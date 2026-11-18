import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { contextDeleteRequestSchema, contextDeleteResponseSchema } from '../../shared/context-delete-protocol.ts';
import type { ContextDeleteOutcome, ContextDeleteResponse, ContextDeleteStep } from '../../shared/context-delete-protocol.ts';
import type { ContextConfiguration } from '../../shared/context-protocol.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import type { createNamespaceFileAdapter } from '../adapters/namespace-file.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';

type Files = ReturnType<typeof createNamespaceFileAdapter>;
type Intent = { outcome: ContextDeleteOutcome; readonly bundle: Awaited<ReturnType<Files['inspectContextDeletionSources']>>; readonly selection: ConfigSelection;
  readonly proof: Buffer; readonly expiresAt: number; readonly controller: AbortController; active: boolean; cancelled: boolean; timedOut: boolean };
const digest = (value: string) => createHash('sha256').update(value).digest();
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
// WRITE controller/planning/confirmation. Never imported, constructed or called by automatic tests.
export function createContextDeleteOperations(options: { serviceGeneration: string; config: ReturnType<typeof createConfigReader>; files: Files; lock: ConfigurationWriteLock }) {
  const records = new Map<string, Intent>(); let preparing = 0, closed = false;
  function update(record: Intent, fields: Partial<ContextDeleteOutcome>) { record.outcome = freeze({ ...record.outcome, ...fields, updatedAt: Date.now() }); }
  function step(record: Intent, index: number, fields: Partial<ContextDeleteStep>) {
    const steps: ContextDeleteOutcome['steps'] = [...record.outcome.steps];
    const value = steps[index]; if (!value) throw new BoundaryError('STATE_UNAVAILABLE');
    Object.assign(steps, { [index]: { ...value, ...fields, id: value.id } }); update(record, { steps });
  }
  function current(record: Intent) {
    if (record.timedOut) throw new BoundaryError('QUERY_TIMEOUT');
    if (closed || record.cancelled || record.controller.signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
    if (Date.now() >= record.expiresAt) throw new BoundaryError('CONFIRMATION_EXPIRED');
  }
  function block(record: Intent, code: ErrorCode) {
    for (let n = 0; n < 3; n++) if (record.outcome.steps[n]?.phase === 'planned') step(record, n, { phase: 'blocked', code });
  }
  function cancel(record: Intent) {
    if (['completed', 'failed', 'unknown', 'cancelled'].includes(record.outcome.phase)) return;
    record.cancelled = true;
    const committing = record.outcome.steps.some(value => value.phase === 'committing');
    if (!committing) record.controller.abort(); // Committing is irrevocable, but the next dependent step still stops.
    for (let n = 0; n < 3; n++) if (record.outcome.steps[n]?.phase === 'staging') step(record, n, { phase: 'cancelling' });
    if (!record.active) { block(record, 'QUERY_CANCELLED'); update(record, { phase: 'cancelled', code: 'QUERY_CANCELLED' }); }
  }
  async function configuration(selection: ConfigSelection, expected: ContextConfiguration, context: string, signal: AbortSignal) {
    if (expected.serviceGeneration !== options.serviceGeneration) throw new BoundaryError('STALE_TARGET');
    const value = await options.config.privateRead(selection, expected.configIdentity, signal);
    if (value.publicRead.status !== 'ready' || value.publicRead.sources.loadedCount < 1) throw new BoundaryError('CONFIG_NOT_FOUND');
    if (!value.merged.contexts.has(context)) throw new BoundaryError('NOT_FOUND');
  }
  async function execute(record: Intent) {
    record.active = true; let index = -1;
    const versions = new Map(record.bundle.sources.flatMap(source => source.version === null ? [] : [[source.path, source.version] as const]));
    const timer = setTimeout(() => { record.timedOut = true; record.controller.abort(); }, 10_000);
    try {
      await options.lock.run(record.controller.signal, async () => {
        current(record); update(record, { phase: 'running' });
        await configuration(record.selection, record.outcome.configuration, record.outcome.context, record.controller.signal);
        const fresh = await options.files.inspectContextDeletionSources(record.selection, record.outcome.context, record.controller.signal);
        if (JSON.stringify(fresh) !== JSON.stringify(record.bundle)) throw new BoundaryError('CONFIG_CHANGED');
        for (index = 0; index < 3; index++) {
          current(record); await options.files.verifyContextDeletionSources(record.bundle, index, versions, record.controller.signal); current(record);
          const original = record.bundle.plans[index]; if (!original) continue;
          current(record); step(record, index, { phase: 'checking' });
          const expectedVersion = versions.get(original.path); if (!expectedVersion) throw new BoundaryError('STATE_UNAVAILABLE');
          const plan = await options.files.rebaseEntry(original, expectedVersion, record.controller.signal);
          current(record);
          const result = await options.files.commit(record.outcome.id, plan, undefined,
            () => { current(record); step(record, index, { phase: 'staging', cleanup: 'pending' }); },
            () => { current(record); step(record, index, { phase: 'committing' }); }, record.controller.signal,
            () => options.files.verifyContextDeletionSources(record.bundle, index, versions, record.controller.signal));
          step(record, index, { phase: result.phase, cleanup: result.cleanup, ...(result.result ? { result: result.result } : {}), ...(result.code ? { code: result.code } : {}) });
          if (result.phase !== 'succeeded') { block(record, result.code ?? 'OPERATION_UNKNOWN'); update(record, { phase: result.phase === 'unknown' ? 'unknown' : record.cancelled ? 'cancelled' : 'failed', code: result.code ?? 'OPERATION_UNKNOWN' }); return; }
          if (!result.versionAfter) throw new BoundaryError('STATE_UNAVAILABLE');
          versions.set(plan.path, result.versionAfter);
          await options.files.verifyContextDeletionSources(record.bundle, index + 1, versions, record.controller.signal); // Definite writer metadata AND confirmed complete content across every source.
        }
        await options.files.verifyContextDeletionSources(record.bundle, 3, versions, record.controller.signal); current(record);
        update(record, { phase: 'completed' }); // Does not imply a reachable cluster or an atomic three-step transaction.
      });
    } catch (error) {
      const code = record.timedOut ? 'QUERY_TIMEOUT' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE', value = record.outcome.steps[index];
      const uncertain = value?.phase === 'committing';
      if (value && !['skipped', 'planned', 'succeeded'].includes(value.phase)) step(record, index, { phase: uncertain ? 'unknown' : record.cancelled ? 'cancelled' : 'failed', code: uncertain ? 'OPERATION_UNKNOWN' : code });
      block(record, code); update(record, { phase: uncertain ? 'unknown' : record.cancelled ? 'cancelled' : 'failed', code: uncertain ? 'OPERATION_UNKNOWN' : code });
    } finally { record.active = false; clearTimeout(timer); }
  }
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<ContextDeleteResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = contextDeleteRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const request = parsed.data, now = Date.now();
      for (const [id, record] of records) {
        if (record.outcome.phase === 'prepared' && now >= record.expiresAt) { block(record, 'CONFIRMATION_EXPIRED'); update(record, { phase: 'failed', code: 'CONFIRMATION_EXPIRED' }); record.controller.abort(); }
        if (!record.active && ['completed', 'failed', 'cancelled'].includes(record.outcome.phase) && record.outcome.updatedAt + 3_600_000 <= now) records.delete(id);
      }
      if (request.kind === 'outcomes') {
        const values = [...records.values()].map(value => value.outcome).reverse(), offset = request.after ? values.findIndex(value => value.id === request.after) + 1 : 0;
        if (request.after && !offset) throw new BoundaryError('STALE_TARGET'); const outcomes = values.slice(offset, offset + 16);
        return contextDeleteResponseSchema.parse({ protocol: 2, kind: 'outcomes', serviceGeneration: options.serviceGeneration, outcomes, next: offset + outcomes.length < values.length ? outcomes.at(-1)?.id ?? null : null });
      }
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (request.kind === 'prepare') {
        if (preparing >= 2 || records.size >= 64) throw new BoundaryError('QUERY_LIMIT'); preparing++;
        try {
          await configuration(request.selection, request.configuration, request.context, signal);
          const bundle = await options.files.inspectContextDeletionSources(request.selection, request.context, signal);
          await configuration(request.selection, request.configuration, request.context, signal);
          if (closed || signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); if (records.size >= 64) throw new BoundaryError('QUERY_LIMIT');
          const id = randomUUID(), capability = randomBytes(32).toString('hex'), expiresAt = Date.now() + 60_000;
          const outcome = freeze<ContextDeleteOutcome>({ id, serviceGeneration: options.serviceGeneration, configuration: request.configuration, context: request.context,
            path: bundle.path, version: bundle.version, currentContextRetained: bundle.description.currentContextRetained, removesCurrent: bundle.description.currentContextRetained === request.context,
             sources: [...bundle.sources], contextRemains: bundle.description.contextRemains, contextAfter: bundle.description.contextAfter,
             steps: bundle.description.steps, createdAt: now, updatedAt: Date.now(), phase: 'prepared' });
          if (Buffer.byteLength(JSON.stringify(outcome)) > 28_000) throw new BoundaryError('BUDGET_EXCEEDED');
          records.set(id, { outcome, bundle, selection: request.selection, proof: digest(capability), expiresAt, controller: new AbortController(), active: false, cancelled: false, timedOut: false });
          return contextDeleteResponseSchema.parse({ protocol: 2, kind: 'confirmation', grant: { id, capability, serviceGeneration: options.serviceGeneration, expiresAt }, outcome });
        } finally { preparing--; }
      }
      const record = records.get(request.grant.id);
      if (!record || request.grant.serviceGeneration !== options.serviceGeneration || request.grant.expiresAt !== record.expiresAt || !timingSafeEqual(record.proof, digest(request.grant.capability))) throw new BoundaryError('FORBIDDEN');
      if (request.kind === 'cancel') { cancel(record); return contextDeleteResponseSchema.parse({ protocol: 2, kind: 'outcome', outcome: record.outcome }); }
      if (record.outcome.phase !== 'prepared') return contextDeleteResponseSchema.parse({ protocol: 2, kind: 'outcome', outcome: record.outcome });
      current(record); update(record, { phase: 'queued' }); void execute(record); // Response/disconnect is not rollback. Original outcomes remain service-owned.
      return contextDeleteResponseSchema.parse({ protocol: 2, kind: 'outcome', outcome: record.outcome });
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
