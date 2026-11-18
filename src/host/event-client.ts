import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { eventMaximumPages, eventReadRequestSchema, eventReadResponseSchema, eventScopeId } from '../shared/event-protocol.ts';
import type { EventReadRequest, EventReadResponse } from '../shared/event-protocol.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';

export type EventState = { readonly phase: 'idle' | 'loading' | 'ready' | 'error'; readonly stale: boolean;
  readonly source?: EventReadRequest; readonly page?: EventReadResponse; readonly error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
function freeze(value: unknown): void { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }

// One visible page, never an unbounded event history. Cancelled proxy calls retain admission until settle.
export class EventClient {
  readonly #request: TreeTransport;
  readonly #show: (state: EventState) => void;
  readonly #inflight = new Set<number>();
  readonly #uids = new Set<string>();
  readonly #names = new Set<string>();
  readonly #cursors = new Set<string>();
  #binding: EventReadRequest | undefined;
  #page: EventReadResponse | undefined;
  #revision = 0;
  #phase: EventState['phase'] = 'idle';
  #disposed = false;
  constructor(request: TreeTransport, show: (state: EventState) => void) { this.#request = request; this.#show = show; }
  #emit(phase: EventState['phase'], stale = false, error?: ErrorCode) {
    this.#phase = phase;
    if (!this.#disposed) this.#show({ phase, stale, ...(this.#binding ? { source: this.#binding } : {}), ...(this.#page ? { page: this.#page } : {}), ...(error ? { error } : {}) });
  }
  read(input: unknown): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const parsed = eventReadRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.cursor !== undefined) { this.reset(); this.#emit('error', false, 'INVALID_INPUT'); return Promise.resolve(); }
    if (JSON.stringify(parsed.data) !== JSON.stringify(this.#binding)) this.reset();
    freeze(parsed.data); this.#binding = parsed.data; return this.#load();
  }
  reload(): Promise<void> { return this.#binding && !this.#disposed ? this.#load() : Promise.resolve(); }
  next(): Promise<void> { return this.#phase === 'ready' && this.#page?.nextCursor ? this.#load(this.#page.nextCursor) : Promise.resolve(); }
  async #load(cursor?: string): Promise<void> {
    if (!this.#binding || this.#disposed) return;
    const binding = this.#binding, previous = this.#page, revision = ++this.#revision;
    const current = () => !this.#disposed && this.#revision === revision;
    this.#emit('loading', !!previous);
    try {
      if (this.#inflight.size >= 4 || (cursor && (previous?.page ?? eventMaximumPages) >= eventMaximumPages)) throw new BoundaryError('QUERY_LIMIT');
      const body = JSON.stringify({ ...binding, ...(cursor ? { cursor } : {}) });
      if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
      this.#inflight.add(revision);
      const response = await this.#request({ method: 'POST', path: '/v2/events/read', body });
      if (!current()) return;
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown;
      try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = eventReadResponseSchema.safeParse(value);
      if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      const page = parsed.data, ns = page.namespace;
      if (!sameTarget(page.target, binding.target) || eventScopeId(page.scope) !== eventScopeId(binding.scope)
        || ns.name !== (binding.scope.kind === 'current' ? binding.target.namespace : binding.scope.name)
        || (binding.scope.kind === 'namespace' && (ns.uid !== binding.scope.uid || ns.resourceVersion !== binding.scope.resourceVersion))
        || page.page !== (cursor ? (previous?.page ?? 0) + 1 : 1)
         || (cursor && (page.apiVersion !== previous?.apiVersion || page.resourceVersion !== previous?.resourceVersion || JSON.stringify(ns) !== JSON.stringify(previous?.namespace)))
        || (page.nextCursor && (page.nextCursor === cursor || (cursor && this.#cursors.has(page.nextCursor))))) throw new BoundaryError('STALE_TARGET');
      if (page.rows.some(row => row.namespace !== ns.name || (cursor && (this.#uids.has(row.uid) || this.#names.has(row.name))))
        || new Set(page.rows.map(row => row.uid)).size !== page.rows.length || new Set(page.rows.map(row => row.name)).size !== page.rows.length) throw new BoundaryError('STALE_TARGET');
      if (!cursor) { this.#uids.clear(); this.#names.clear(); this.#cursors.clear(); }
      for (const row of page.rows) { this.#uids.add(row.uid); this.#names.add(row.name); }
      if (page.nextCursor) this.#cursors.add(page.nextCursor);
      freeze(page); this.#page = page; this.#emit('ready');
    } catch (error) { if (current()) this.#emit('error', !!previous, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
    finally { this.#inflight.delete(revision); }
  }
  cancel(): void { if (!this.#disposed && this.#phase === 'loading') { ++this.#revision; this.#emit('error', !!this.#page, 'QUERY_CANCELLED'); } }
  reset(): void { ++this.#revision; this.#binding = undefined; this.#page = undefined; this.#uids.clear(); this.#names.clear(); this.#cursors.clear(); this.#emit('idle'); }
  dispose(): void { this.#disposed = true; this.reset(); }
}
