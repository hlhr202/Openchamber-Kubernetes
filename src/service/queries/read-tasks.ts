import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { readHandleSchema, readLeaseMs, readLifetimeMs, readConsumerSchema, readControlSchema } from '../../shared/read-task-protocol.ts';
import type { ReadHandle, ReadTaskPhase } from '../../shared/read-task-protocol.ts';
import { z } from 'zod';

type Consumer = { handle: ReadHandle; view: string; leaseUntil: number };
type Task<S, E> = { id: string; key: string; source: S; controller: AbortController; consumers: Map<string, Consumer>;
  events: E[]; bytes: number; sequence: number; expiresAt: number; phase: ReadTaskPhase; error?: ErrorCode; settled: boolean };
type View = { epoch: number; key: string; consumer?: Consumer; expiresAt: number };
export function createReadTaskBudget() {
  let active = 0;
  return { acquire() { if (active >= 2) throw new BoundaryError('QUERY_LIMIT'); active++; let released = false;
    return () => { if (!released) { released = true; active--; } }; } };
}
// Read tasks only. Tokens are server-generated bearer capabilities, NOT authenticated host project/frame owners.
export function createReadTasks<S extends { target: { serviceGeneration: string } }, E extends { sequence: number }, P>(options: {
  generation: string; kind: string; sourceSchema: z.ZodType<S>; eventSchema: z.ZodType<E>; pageSchema: z.ZodType<P>;
  run: (source: S, signal: AbortSignal, emit: (event: Omit<E, 'sequence'>) => void) => Promise<void>; clock?: () => number; budget?: ReturnType<typeof createReadTaskBudget> }) {
  type ReadTask = Task<S, E>;
  const clock = options.clock ?? Date.now, tasks = new Map<string, ReadTask>(), shared = new Map<string, ReadTask>(), views = new Map<string, View>(); let closed = false;
  function freeze(value: unknown): void { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }
  function stop(task: ReadTask, code: ErrorCode) {
    if (task.phase === 'starting' || task.phase === 'running') { task.phase = 'error'; task.error = code; }
    if (shared.get(task.key) === task) shared.delete(task.key);
    task.events = []; task.bytes = 0; task.controller.abort(new BoundaryError(code)); // Never execute operations/sessions or remote cleanup.
  }
  function release(task: ReadTask, consumer: Consumer) {
    task.consumers.delete(consumer.handle.consumer);
    const view = views.get(consumer.view); if (view?.consumer === consumer) delete view.consumer;
    if (!task.consumers.size) { stop(task, 'QUERY_CANCELLED'); if (task.settled) tasks.delete(task.id); }
  }
  function sweep() {
    const now = clock();
    for (const task of tasks.values()) {
      for (const consumer of task.consumers.values()) if (consumer.leaseUntil <= now) release(task, consumer);
      if (task.expiresAt <= now) { stop(task, 'QUERY_TIMEOUT'); for (const consumer of task.consumers.values()) release(task, consumer); if (task.settled) tasks.delete(task.id); }
    }
    for (const [id, view] of views) if (!view.consumer && view.expiresAt <= now) views.delete(id);
  }
  const timer = setInterval(sweep, 1000); timer.unref();
  function lookup(input: unknown) {
    if (closed) throw new BoundaryError('SERVICE_CLOSED'); sweep();
    const parsed = readControlSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
    const { handle, after } = parsed.data;
    if (handle.generation !== options.generation) throw new BoundaryError('STALE_TARGET');
    const task = tasks.get(handle.task), consumer = task?.consumers.get(handle.consumer);
    if (!task || !consumer || consumer.handle.epoch !== handle.epoch
      || !timingSafeEqual(Buffer.from(consumer.handle.token), Buffer.from(handle.token))) throw new BoundaryError('VIEW_EXPIRED');
    if (after > task.sequence) throw new BoundaryError('INVALID_INPUT');
    return { task, consumer, after };
  }
  function page(task: ReadTask, consumer: Consumer, after: number): P {
    const first = task.events[0]?.sequence ?? task.sequence + 1, events: E[] = []; let bytes = 0;
    for (const event of task.events) if (event.sequence > after && events.length < 32) { const size = Buffer.byteLength(JSON.stringify(event)); if (bytes + size > 32_000) break; events.push(event); bytes += size; }
    return options.pageSchema.parse({ protocol: 2, kind: options.kind, handle: consumer.handle, source: task.source, phase: task.phase,
      ...(task.error ? { error: task.error } : {}), expiresAt: task.expiresAt, leaseUntil: consumer.leaseUntil, first, lost: after < first - 1,
      next: events.at(-1)?.sequence ?? after, head: task.sequence, events });
  }
  function execute(task: ReadTask, releaseBudget: (() => void) | undefined) {
    // The slot stays charged until run actually settles, even if an adapter ignores cancellation.
    void Promise.resolve().then(() => {
      if (task.controller.signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); task.phase = 'running';
      return options.run(task.source, task.controller.signal, event => {
        if (task.phase !== 'running' || task.controller.signal.aborted || closed || task.expiresAt <= clock() || !task.consumers.size) return;
        const parsed = options.eventSchema.safeParse({ ...event, sequence: task.sequence + 1 }); if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID');
        const bytes = Buffer.byteLength(JSON.stringify(parsed.data)); if (bytes > 32_000) throw new BoundaryError('BUDGET_EXCEEDED'); // One event must fit a poll, never an undrainable head.
        freeze(parsed.data); task.sequence++; task.events.push(parsed.data); task.bytes += bytes;
        while (task.events.length > 128 || task.bytes > 65_536) { const removed = task.events.shift(); if (removed) task.bytes -= Buffer.byteLength(JSON.stringify(removed)); }
      });
    }).then(() => { if (!task.controller.signal.aborted) task.phase = 'completed'; }, error => {
      if (!task.controller.signal.aborted) { task.phase = 'error'; task.error = error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'; }
    }).finally(() => { task.settled = true; releaseBudget?.(); if (shared.get(task.key) === task) shared.delete(task.key); if (!task.consumers.size) tasks.delete(task.id); });
  }
  return {
    open(input: unknown): P {
      if (closed) throw new BoundaryError('SERVICE_CLOSED'); sweep();
      const header = z.object({ consumer: readConsumerSchema }).passthrough().safeParse(input); if (!header.success) throw new BoundaryError('INVALID_INPUT');
      const { consumer: identity, ...value } = header.data, parsed = options.sourceSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const source = parsed.data;
      if (Buffer.byteLength(JSON.stringify(source)) > 40_000) throw new BoundaryError('BUDGET_EXCEEDED');
      if (source.target.serviceGeneration !== options.generation) throw new BoundaryError('STALE_TARGET');
      const key = createHash('sha256').update(JSON.stringify(source)).digest('hex'), previous = views.get(identity.view);
      if (previous && (identity.epoch < previous.epoch || (identity.epoch === previous.epoch && previous.key !== key))) throw new BoundaryError('STALE_TARGET');
      if (previous && identity.epoch === previous.epoch) {
        const task = previous.consumer ? tasks.get(previous.consumer.handle.task) : undefined;
        if (!task || !previous.consumer) throw new BoundaryError('VIEW_EXPIRED'); return page(task, previous.consumer, 0);
      }
      if (!previous && views.size >= 64) throw new BoundaryError('QUERY_LIMIT');
      if (previous?.consumer) { const task = tasks.get(previous.consumer.handle.task); if (task) release(task, previous.consumer); }
      views.set(identity.view, { epoch: identity.epoch, key, expiresAt: clock() + readLifetimeMs }); // Advance the tombstone even when admission below fails.
      let task = shared.get(key);
      if (task && task.phase !== 'starting' && task.phase !== 'running') task = undefined;
      if (!task) {
        if ([...tasks.values()].filter(task => !task.settled).length >= 2 || tasks.size >= 16) throw new BoundaryError('QUERY_LIMIT');
        const releaseBudget = options.budget?.acquire();
        // JSON validated clone is private and immutable, not caller mutable state.
        freeze(source);
        task = { id: randomUUID(), key, source, controller: new AbortController(), consumers: new Map(), events: [], bytes: 0, sequence: 0, expiresAt: clock() + readLifetimeMs, phase: 'starting', settled: false };
        tasks.set(task.id, task); shared.set(key, task); execute(task, releaseBudget);
      }
      const handle: ReadHandle = readHandleSchema.parse({ generation: options.generation, task: task.id, consumer: randomUUID(), token: randomBytes(32).toString('hex'), epoch: identity.epoch });
      const consumer = { handle: Object.freeze(handle), view: identity.view, leaseUntil: Math.min(clock() + readLeaseMs, task.expiresAt) };
      task.consumers.set(handle.consumer, consumer); views.set(identity.view, { epoch: identity.epoch, key, consumer, expiresAt: clock() + readLifetimeMs });
      return page(task, consumer, 0);
    },
    poll(input: unknown) { const { task, consumer, after } = lookup(input); consumer.leaseUntil = Math.min(clock() + readLeaseMs, task.expiresAt); return page(task, consumer, after); },
    release(input: unknown) { const { task, consumer } = lookup(input); release(task, consumer); },
    source(input: unknown): S { return lookup(input).task.source; },
    sweep,
    close() { if (closed) return; closed = true; clearInterval(timer); for (const task of tasks.values()) stop(task, 'SERVICE_CLOSED'); tasks.clear(); shared.clear(); views.clear(); },
  };
}
