import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { contextRequestSchema, contextResponseSchema } from '../../shared/context-protocol.ts';
import type { ContextConfiguration, ContextGrant, ContextOutcome, ContextResponse } from '../../shared/context-protocol.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import type { createNamespaceFileAdapter, ContextFileBundle, ContextFilePlan } from '../adapters/namespace-file.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';

type Intent = { outcome: ContextOutcome; readonly plan: ContextFilePlan; readonly bundle: ContextFileBundle; readonly selection: ConfigSelection; readonly proof: Buffer; readonly expiresAt: number; readonly controller: AbortController; active: boolean };
const digest = (value: string) => createHash('sha256').update(value).digest();
// WRITE controller. Static review only; never imported/called by automatic tests, including rejection/no-op paths.
export function createContextOperations(options: { serviceGeneration: string; config: ReturnType<typeof createConfigReader>; files: ReturnType<typeof createNamespaceFileAdapter>; lock: ConfigurationWriteLock }) {
  const records = new Map<string, Intent>(); let preparing = 0, closed = false;
  function update(record: Intent, phase: ContextOutcome['phase'], code?: ErrorCode) {
    record.outcome = Object.freeze({ ...record.outcome, phase, updatedAt: Date.now(), ...(phase === 'staging' ? { cleanup: 'pending' as const } : {}), ...(code ? { code } : {}) });
  }
  function current(record: Intent) {
    if (closed || record.controller.signal.aborted || record.outcome.phase === 'cancelled') throw new BoundaryError('QUERY_CANCELLED');
    if (Date.now() >= record.expiresAt) throw new BoundaryError('CONFIRMATION_EXPIRED');
  }
  function cancel(record: Intent) {
    if (record.outcome.phase === 'staging') { update(record, 'cancelling', 'QUERY_CANCELLED'); record.controller.abort(); }
    else if (['prepared', 'queued', 'checking'].includes(record.outcome.phase)) { update(record, 'cancelled', 'QUERY_CANCELLED'); record.controller.abort(); }
  }
  async function configuration(selection: ConfigSelection, expected: ContextConfiguration, context: string, signal: AbortSignal) {
    if (expected.serviceGeneration !== options.serviceGeneration) throw new BoundaryError('STALE_TARGET');
    const value = await options.config.privateRead(selection, expected.configIdentity, signal);
    if (value.publicRead.status !== 'ready' || value.publicRead.sources.loadedCount < 1) throw new BoundaryError('CONFIG_NOT_FOUND');
    if (!value.merged.contexts.has(context)) throw new BoundaryError('NOT_FOUND');
    return value.merged.currentContext; // No auth/cluster availability or referenced file read. Private snapshot never enters outcome.
  }
  function owned(grant: ContextGrant) {
    const record = records.get(grant.id);
    if (!record || grant.serviceGeneration !== options.serviceGeneration || grant.expiresAt !== record.expiresAt || !timingSafeEqual(record.proof, digest(grant.capability))) throw new BoundaryError('FORBIDDEN');
    return record;
  }
  async function execute(record: Intent) {
    record.active = true; const timer = setTimeout(() => record.controller.abort(), 10_000);
    try {
      await options.lock.run(record.controller.signal, async () => {
        current(record); update(record, 'checking');
        const previous = await configuration(record.selection, record.outcome.configuration, record.outcome.context, record.controller.signal);
        if (previous !== record.bundle.previous) throw new BoundaryError('CONFIG_CHANGED');
        await options.files.verifyContextSources(record.bundle, record.controller.signal); current(record);
        if (record.plan.unchanged) {
          record.outcome = Object.freeze({ ...record.outcome, phase: 'succeeded', cleanup: 'none', result: 'unchanged', updatedAt: Date.now() }); return;
        }
        const result = await options.files.commit(record.outcome.id, record.plan, undefined, () => { current(record); update(record, 'staging'); },
          () => { current(record); clearTimeout(timer); update(record, 'committing'); }, record.controller.signal,
          () => options.files.verifyContextSources(record.bundle, record.controller.signal));
        if (record.outcome.phase === 'cancelled' && result.cleanup === 'none' && result.phase === 'failed') return;
        if (record.outcome.phase === 'cancelling' && result.cleanup === 'none' && result.phase === 'failed') {
          record.outcome = Object.freeze({ ...record.outcome, phase: 'cancelled', cleanup: 'none', updatedAt: Date.now(), code: 'QUERY_CANCELLED' }); return;
        }
        record.outcome = Object.freeze({ ...record.outcome, phase: result.phase, cleanup: result.cleanup, updatedAt: Date.now(), ...(result.result ? { result: result.result } : {}), ...(result.code ? { code: result.code } : {}) });
      });
    } catch (error) {
      if (record.outcome.phase !== 'cancelled') update(record, record.outcome.phase === 'committing' ? 'unknown' : 'failed', record.outcome.phase === 'committing' ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE');
    } finally { record.active = false; clearTimeout(timer); }
  }
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<ContextResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = contextRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const request = parsed.data, now = Date.now();
      for (const [id, record] of records) {
        if (record.outcome.phase === 'prepared' && record.expiresAt <= now) { update(record, 'failed', 'CONFIRMATION_EXPIRED'); record.controller.abort(); }
        if (!record.active && ['succeeded', 'failed', 'cancelled'].includes(record.outcome.phase) && record.outcome.updatedAt + 3_600_000 <= now) records.delete(id);
      }
      if (request.kind === 'outcomes') {
        const values = [...records.values()].map(record => record.outcome).reverse(), offset = request.after ? values.findIndex(value => value.id === request.after) + 1 : 0;
        if (request.after && !offset) throw new BoundaryError('STALE_TARGET');
        const outcomes = values.slice(offset, offset + 16);
        return contextResponseSchema.parse({ protocol: 2, kind: 'outcomes', serviceGeneration: options.serviceGeneration, outcomes, next: offset + outcomes.length < values.length ? outcomes.at(-1)?.id ?? null : null });
      }
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (request.kind === 'prepare') {
        if (preparing >= 2 || records.size >= 64) throw new BoundaryError('QUERY_LIMIT'); preparing++;
        try {
          const previous = await configuration(request.selection, request.configuration, request.context, signal);
          const bundle = await options.files.inspectContextSources(request.selection, request.context, signal), plan = bundle.plan;
          if (bundle.previous !== previous) throw new BoundaryError('CONFIG_CHANGED');
          if (await configuration(request.selection, request.configuration, request.context, signal) !== previous) throw new BoundaryError('CONFIG_CHANGED');
          if (closed || signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); if (records.size >= 64) throw new BoundaryError('QUERY_LIMIT');
          const id = randomUUID(), capability = randomBytes(32).toString('hex'), expiresAt = Date.now() + 60_000;
          const outcome = Object.freeze<ContextOutcome>({ id, serviceGeneration: options.serviceGeneration, configuration: Object.freeze({ ...request.configuration }), step: 'use-context', dependencies: [],
            path: plan.path, version: plan.version, previous, writePrevious: plan.previous, contextOrigin: bundle.contextOrigin, sources: [...bundle.sources], context: plan.context, createdAt: now, updatedAt: Date.now(), phase: 'prepared', cleanup: 'none' });
          Object.freeze(outcome.dependencies);
          Object.freeze(outcome.sources);
          if (Buffer.byteLength(JSON.stringify(outcome)) > 28_000) throw new BoundaryError('BUDGET_EXCEEDED'); // Sixteen history rows stay inside the 512KB transport budget.
          records.set(id, { outcome, plan, bundle, selection: request.selection, proof: digest(capability), expiresAt, controller: new AbortController(), active: false });
          return contextResponseSchema.parse({ protocol: 2, kind: 'confirmation', grant: { id, capability, serviceGeneration: options.serviceGeneration, expiresAt }, outcome });
        } finally { preparing--; }
      }
      const record = owned(request.grant);
      if (request.kind === 'status') return { protocol: 2, kind: 'outcome', outcome: record.outcome };
      if (request.kind === 'cancel') { cancel(record); return { protocol: 2, kind: 'outcome', outcome: record.outcome }; }
      if (record.outcome.phase !== 'prepared') return { protocol: 2, kind: 'outcome', outcome: record.outcome };
      current(record); update(record, 'queued'); void execute(record); // HTTP disconnect is not cancellation or rollback after explicit submit.
      return { protocol: 2, kind: 'outcome', outcome: record.outcome };
    },
    counts(): Record<string, number> {
      // Stop-gate aggregate: phase counts only, never record content/targets.
      const phases: Record<string, number> = {};
      for (const record of records.values()) phases[record.outcome.phase] = (phases[record.outcome.phase] ?? 0) + 1;
      return phases;
    },
    close() { closed = true; for (const record of records.values()) cancel(record); },
  };
}
