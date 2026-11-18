import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import { namespaceDeleteRequestSchema, namespaceDeleteResponseSchema } from '../../shared/namespace-delete-protocol.ts';
import type { NamespaceDeleteGrant, NamespaceDeleteOutcome } from '../../shared/namespace-delete-protocol.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import type { createNamespaceFileAdapter, NamespaceFileBundle, NamespaceFileResult } from '../adapters/namespace-file.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import type { createResourceGateway } from '../queries/resource-gateway.ts';
import { bindResourceTarget } from '../queries/resource-target.ts';
import { privateKubectlConfiguration } from '../queries/kubectl-configuration.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';
import type { DeleteDispatch, DeleteResult } from './delete.ts';

type Record = { outcome: NamespaceDeleteOutcome; readonly selection: ConfigSelection; readonly proof: Buffer; readonly expiresAt: number; readonly bundle: NamespaceFileBundle; readonly switching: boolean;
  readonly controller: AbortController; active: boolean; cancelled: boolean };
const digest = (value: string) => createHash('sha256').update(value).digest();
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
// WRITE multi-step control plane. Static review only; never import/call with mocks or real adapters in tests.
export function createNamespaceDeleteOperations(options: { serviceGeneration: string; config: ReturnType<typeof createConfigReader>; resources: ReturnType<typeof createResourceGateway>;
  files: ReturnType<typeof createNamespaceFileAdapter>; lock: ConfigurationWriteLock; execute: (request: DeleteDispatch, beforeDispatch: () => void, signal: AbortSignal) => Promise<DeleteResult> }) {
  const records = new Map<string, Record>(); let preparing = 0, closed = false;
  function update(record: Record, values: Partial<NamespaceDeleteOutcome>) { record.outcome = freeze({ ...record.outcome, ...values, updatedAt: Date.now() }); }
  function current(record: Record) {
    if (closed || record.cancelled || record.controller.signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
    if (Date.now() >= record.expiresAt) throw new BoundaryError('CONFIRMATION_EXPIRED');
  }
  function cancel(record: Record) {
    if (['completed', 'failed', 'unknown', 'cancelled'].includes(record.outcome.phase)) return;
    record.cancelled = true; record.controller.abort();
    if (record.active) update(record, { phase: 'cancelling' });
    else update(record, { phase: 'cancelled', code: 'QUERY_CANCELLED', deleteNamespace: { ...record.outcome.deleteNamespace, phase: 'blocked', code: 'QUERY_CANCELLED' } });
  }
  async function execute(record: Record) {
    record.active = true; const signal = record.controller.signal, timer = setTimeout(() => record.controller.abort(), 25_000);
    try {
      await options.lock.run(signal, async () => { // ONE lock covers the complete chain; no nested operation handlers/locks.
        current(record); update(record, { phase: 'running' }); let target = record.outcome.target, versionAfter: string | undefined;
        const verifySources = () => versionAfter === undefined ? options.files.verifyNamespaceSources(record.bundle, signal)
          : options.files.verifyNamespaceCommitted(record.bundle, versionAfter, signal);
        await verifySources(); current(record);
        const inventory = await options.resources.namespaceInventory({ selection: record.selection, target, reference: record.outcome.reference }, signal);
        if (inventory.digest !== record.outcome.inventory.digest) throw new BoundaryError('STALE_TARGET'); current(record);
        if (record.switching) {
          const plan = record.bundle.plan;
          update(record, { switchDefault: { ...record.outcome.switchDefault, phase: 'checking' } });
          bindResourceTarget(target, await options.config.read(record.selection, signal), options.serviceGeneration); current(record);
          await verifySources(); current(record);
          const result: NamespaceFileResult = plan.previous === plan.namespace ? { phase: 'succeeded', cleanup: 'none', result: 'unchanged', versionAfter: plan.version }
            : await options.files.commit(record.outcome.id, plan, target,
            () => { current(record); update(record, { switchDefault: { ...record.outcome.switchDefault, phase: 'staging', cleanup: 'pending' } }); },
            () => { current(record); update(record, { switchDefault: { ...record.outcome.switchDefault, phase: 'committing' } }); }, signal,
            () => options.files.verifyNamespaceSources(record.bundle, signal));
          update(record, { switchDefault: { ...record.outcome.switchDefault, phase: result.phase === 'succeeded' ? 'succeeded' : record.cancelled && result.phase === 'failed' && result.cleanup === 'none' ? 'cancelled' : result.phase,
            cleanup: result.cleanup, ...(result.code ? { code: result.code } : {}) } });
          if (result.phase !== 'succeeded') {
            update(record, { phase: result.phase === 'unknown' ? 'unknown' : record.cancelled ? 'cancelled' : 'failed', ...(result.code ? { code: result.code } : {}), deleteNamespace: { ...record.outcome.deleteNamespace, phase: 'blocked' } }); return;
          }
          current(record); // Successful config commit is NOT permission to continue after cancel/expiry.
          if (!result.versionAfter) throw new BoundaryError('STATE_UNAVAILABLE'); versionAfter = result.versionAfter;
          await verifySources();
          const configuration = await options.config.read(record.selection, signal);
          target = bindResourceTarget({ ...target, configIdentity: configuration.snapshot.configIdentity, namespace: 'default' }, configuration, options.serviceGeneration);
          await verifySources(); update(record, { targetAfter: target }); current(record);
          const after = await options.resources.namespaceInventory({ selection: record.selection, target, reference: record.outcome.reference }, signal);
          if (after.digest !== record.outcome.inventory.digest) throw new BoundaryError('STALE_TARGET'); current(record);
        }
        if (!['succeeded', 'skipped'].includes(record.outcome.switchDefault.phase)) throw new BoundaryError('STATE_UNAVAILABLE');
        update(record, { deleteNamespace: { ...record.outcome.deleteNamespace, phase: 'checking' } });
        await options.resources.verifyReference({ selection: record.selection, target, reference: record.outcome.reference }, signal); current(record);
        await verifySources(); current(record);
        const result = await options.execute({ selection: record.selection, target, parameters: { reference: record.outcome.reference, mode: 'standard' }, notAfter: record.expiresAt }, () => {
          current(record); clearTimeout(timer);
          if (!['succeeded', 'skipped'].includes(record.outcome.switchDefault.phase)) throw new BoundaryError('STATE_UNAVAILABLE');
          update(record, { deleteNamespace: { ...record.outcome.deleteNamespace, phase: 'dispatching' } });
        }, signal);
        update(record, { phase: result.outcome === 'accepted' ? 'completed' : result.outcome === 'unknown' ? 'unknown' : 'failed',
          deleteNamespace: { ...record.outcome.deleteNamespace, phase: result.outcome === 'accepted' ? 'accepted' : result.outcome === 'unknown' ? 'unknown' : 'failed', ...(result.code ? { code: result.code } : {}) }, ...(result.code ? { code: result.code } : {}) });
      });
    } catch (error) {
      const code = error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE', dispatched = record.outcome.deleteNamespace.phase === 'dispatching', committing = record.outcome.switchDefault.phase === 'committing';
      update(record, { phase: dispatched || committing ? 'unknown' : record.cancelled ? 'cancelled' : 'failed', code: dispatched || committing ? 'OPERATION_UNKNOWN' : code,
        switchDefault: ['checking', 'staging', 'committing'].includes(record.outcome.switchDefault.phase) ? { ...record.outcome.switchDefault, phase: committing ? 'unknown' : record.cancelled ? 'cancelled' : 'failed', code } : record.outcome.switchDefault,
        deleteNamespace: { ...record.outcome.deleteNamespace, phase: dispatched ? 'unknown' : 'blocked', code: dispatched ? 'OPERATION_UNKNOWN' : code } });
    } finally { record.active = false; clearTimeout(timer); }
  }
  return {
    async handle(input: unknown, signal: AbortSignal) {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = namespaceDeleteRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const request = parsed.data, now = Date.now();
      for (const [id, record] of records) {
        if (record.outcome.phase === 'prepared' && record.expiresAt <= now) {
          record.controller.abort();
          update(record, { phase: 'failed', code: 'CONFIRMATION_EXPIRED', deleteNamespace: { ...record.outcome.deleteNamespace, phase: 'blocked', code: 'CONFIRMATION_EXPIRED' } });
        }
        if (!record.active && ['completed', 'failed', 'cancelled'].includes(record.outcome.phase) && record.outcome.updatedAt + 3_600_000 <= now) records.delete(id);
      }
      if (request.kind === 'outcomes') {
        const values = [...records.values()].map(record => record.outcome).reverse(), offset = request.after ? values.findIndex(value => value.id === request.after) + 1 : 0;
        if (request.after && !offset) throw new BoundaryError('STALE_TARGET'); const outcomes = values.slice(offset, offset + 16);
        return namespaceDeleteResponseSchema.parse({ protocol: 2, kind: 'outcomes', serviceGeneration: options.serviceGeneration, outcomes, next: offset + outcomes.length < values.length ? outcomes.at(-1)?.id ?? null : null });
      }
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (request.kind === 'prepare') {
        if (request.reference.name === 'default' && !request.acknowledgeDefault) throw new BoundaryError('INVALID_INPUT');
        if (preparing >= 2 || records.size >= 64) throw new BoundaryError('QUERY_LIMIT'); preparing++;
        try {
          const target = bindResourceTarget(request.target, await options.config.read(request.selection, signal), options.serviceGeneration);
          const config = await options.config.transportRead(request.selection, target.configIdentity, signal, target); privateKubectlConfiguration(config.merged, target).fill(0); // Fail auth policy BEFORE any config write.
          const inventory = await options.resources.namespaceInventory({ selection: request.selection, target, reference: request.reference }, signal);
          const switching = request.reference.name === target.namespace;
          const bundle = await options.files.inspectNamespaceSources(request.selection, target, switching ? 'default' : target.namespace, signal);
          bindResourceTarget(target, await options.config.read(request.selection, signal), options.serviceGeneration);
          if (closed || signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); if (records.size >= 64) throw new BoundaryError('QUERY_LIMIT');
          const id = randomUUID(), capability = randomBytes(32).toString('hex'), expiresAt = Date.now() + 60_000;
          const outcome: NamespaceDeleteOutcome = freeze({ id, serviceGeneration: options.serviceGeneration, target, reference: request.reference, inventory, path: switching ? bundle.plan.path : null,
            contextOrigin: bundle.contextOrigin, version: bundle.plan.version, sources: [...bundle.sources],
            switchDefault: { id: 'switch-default', dependencies: [], phase: switching ? 'planned' : 'skipped', cleanup: 'none' },
            deleteNamespace: { id: 'delete-namespace', dependencies: switching ? ['switch-default'] : [], phase: 'planned', cleanup: 'none' }, createdAt: now, updatedAt: Date.now(), phase: 'prepared' });
          if (Buffer.byteLength(JSON.stringify(outcome)) > 24_000) throw new BoundaryError('BUDGET_EXCEEDED'); // Reserve targetAfter + terminal fields within 28KB/row and 512KB/page.
          records.set(id, { outcome, selection: request.selection, proof: digest(capability), expiresAt, bundle, switching, controller: new AbortController(), active: false, cancelled: false });
          return namespaceDeleteResponseSchema.parse({ protocol: 2, kind: 'confirmation', grant: { id, capability, serviceGeneration: options.serviceGeneration, expiresAt }, outcome });
        } finally { preparing--; }
      }
      const record = records.get(request.grant.id); const grant: NamespaceDeleteGrant = request.grant;
      if (!record || grant.serviceGeneration !== options.serviceGeneration || grant.expiresAt !== record.expiresAt || !timingSafeEqual(record.proof, digest(grant.capability))) throw new BoundaryError('FORBIDDEN');
      if (request.kind === 'cancel') { cancel(record); return namespaceDeleteResponseSchema.parse({ protocol: 2, kind: 'outcome', outcome: record.outcome }); }
      if (record.outcome.phase !== 'prepared') return namespaceDeleteResponseSchema.parse({ protocol: 2, kind: 'outcome', outcome: record.outcome });
      if ((record.outcome.inventory.status === 'unknown' || record.outcome.inventory.count !== 0) && !request.acknowledgeContents) throw new BoundaryError('INVALID_INPUT');
      current(record); update(record, { phase: 'queued' }); void execute(record); // HTTP disconnect is not rollback.
      return namespaceDeleteResponseSchema.parse({ protocol: 2, kind: 'outcome', outcome: record.outcome });
    },
    counts(): { [phase: string]: number } {
      // Stop-gate aggregate: phase counts only, never record content/targets.
      const phases: { [phase: string]: number } = {};
      for (const record of records.values()) phases[record.outcome.phase] = (phases[record.outcome.phase] ?? 0) + 1;
      return phases;
    },
    close() { closed = true; for (const record of records.values()) cancel(record); },
  };
}
