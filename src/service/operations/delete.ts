import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { deleteRequestSchema, deleteResponseSchema } from '../../shared/delete-protocol.ts';
import type { DeleteOutcome, DeleteParameters, DeleteResponse, ViewGrant } from '../../shared/delete-protocol.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { bindResourceTarget } from '../queries/resource-target.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import type { createResourceGateway } from '../queries/resource-gateway.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';

type View = { readonly id: string; readonly digest: Buffer; readonly expiresAt: number; readonly target: TargetIdentity; readonly selection: ConfigSelection };
type Record = { readonly view: View; readonly proof: Buffer; readonly expiresAt: number; outcome: DeleteOutcome; readonly controller: AbortController };
export type DeleteDispatch = { target: TargetIdentity; selection: ConfigSelection; parameters: DeleteParameters; notAfter: number };
export type DeleteResult = { readonly outcome: 'accepted' | 'rejected' | 'not-submitted' | 'unknown'; readonly code?: ErrorCode };
const digest = (value: string) => createHash('sha256').update(value).digest();
const equal = (stored: Buffer, value: string) => timingSafeEqual(stored, digest(value));
function immutable<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); } return value; }

// WRITE control plane. Never import/instantiate/call this from automated functional tests.
// Authenticated HTTP is the only runtime caller. Capabilities are service-issued, NOT host project attestations.
export function createDeleteOperations(options: { serviceGeneration: string; config: ReturnType<typeof createConfigReader>; resources: ReturnType<typeof createResourceGateway>;
  execute: (input: DeleteDispatch, beforeDispatch: () => void, signal: AbortSignal) => Promise<DeleteResult>; lock: ConfigurationWriteLock }) {
  const views = new Map<string, View>(), records = new Map<string, Record>(), queued: Record[] = [], locks = new Set<string>();
  let closed = false, running = 0, preparing = 0, opening = 0;
  function update(record: Record, phase: DeleteOutcome['phase'], code?: ErrorCode) {
    record.outcome = immutable({ id: record.outcome.id, owner: record.outcome.owner, step: record.outcome.step, dependencies: [], target: record.outcome.target, parameters: record.outcome.parameters,
      createdAt: record.outcome.createdAt, updatedAt: Date.now(), phase, ...(code ? { code } : {}) });
  }
  function prune() {
    const now = Date.now();
    for (const [id, view] of views) if (view.expiresAt <= now) views.delete(id);
    for (const [id, record] of records) {
      if (record.outcome.phase === 'prepared' && record.expiresAt <= now) update(record, 'cancelled', 'CONFIRMATION_EXPIRED');
      if (['accepted', 'failed', 'cancelled'].includes(record.outcome.phase) && record.outcome.updatedAt + 3_600_000 <= now) records.delete(id);
      // Unknown records are never silently evicted to admit another submission; a full ledger fails closed.
    }
  }
  function view(grant: ViewGrant): View {
    const value = views.get(grant.id);
    if (closed || grant.serviceGeneration !== options.serviceGeneration || !value || value.expiresAt !== grant.expiresAt || value.expiresAt <= Date.now() || !equal(value.digest, grant.capability)) throw new BoundaryError('VIEW_EXPIRED');
    return value;
  }
  function current(record: Record): void {
    if (closed || record.controller.signal.aborted || record.outcome.phase === 'cancelled') throw new BoundaryError('QUERY_CANCELLED');
    if (!views.has(record.view.id) || record.view.expiresAt <= Date.now()) throw new BoundaryError('VIEW_EXPIRED');
    if (record.expiresAt <= Date.now()) throw new BoundaryError('CONFIRMATION_EXPIRED');
  }
  function cancel(record: Record) {
    if (['prepared', 'queued', 'checking'].includes(record.outcome.phase)) {
      update(record, 'cancelled', 'QUERY_CANCELLED'); record.controller.abort();
      const index = queued.indexOf(record); if (index >= 0) queued.splice(index, 1);
    }
    // Dispatch may already have reached the API. Never kill it, retry it, or claim it was undone.
  }
  async function execute(record: Record) {
    const timeout = setTimeout(() => record.controller.abort(), 12_000);
    try {
      await options.lock.run(record.controller.signal, async () => {
      current(record); update(record, 'checking');
      await options.resources.verifyReference({ selection: record.view.selection, target: record.view.target, reference: record.outcome.parameters.reference }, record.controller.signal);
      current(record);
      const result = await options.execute({ target: record.view.target, selection: record.view.selection, parameters: record.outcome.parameters, notAfter: record.expiresAt }, () => {
        current(record); clearTimeout(timeout); update(record, 'dispatching');
      }, record.controller.signal);
      update(record, result.outcome === 'accepted' ? 'accepted' : result.outcome === 'unknown' ? 'unknown' : 'failed', result.code);
      });
    } catch (error) {
      if (record.outcome.phase !== 'cancelled') update(record, record.outcome.phase === 'dispatching' ? 'unknown' : 'failed', record.outcome.phase === 'dispatching' ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE');
    } finally { clearTimeout(timeout); running--; locks.delete(record.view.target.configIdentity); pump(); }
  }
  function pump() {
    while (!closed && running < 2) {
      const index = queued.findIndex(record => !locks.has(record.view.target.configIdentity));
      if (index < 0) return;
      const record = queued.splice(index, 1)[0]; if (!record || record.outcome.phase !== 'queued') continue;
      running++; locks.add(record.view.target.configIdentity); void execute(record);
    }
  }
  function owned(grant: ViewGrant, id: string): Record {
    const owner = view(grant), record = records.get(id);
    if (!record || record.view.id !== owner.id) throw new BoundaryError('NOT_FOUND'); return record;
  }
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<DeleteResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = deleteRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const request = parsed.data; prune();
      if (request.kind === 'outcomes') {
        const outcomes = [...records.values()].map(record => record.outcome).reverse();
        const offset = request.after ? outcomes.findIndex(outcome => outcome.id === request.after) + 1 : 0;
        if (request.after && !offset) throw new BoundaryError('STALE_TARGET');
        const page = outcomes.slice(offset, offset + 16);
        return deleteResponseSchema.parse({ protocol: 2, kind: 'outcomes', serviceGeneration: options.serviceGeneration, outcomes: page,
          next: offset + page.length < outcomes.length ? page.at(-1)?.id ?? null : null });
      }
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (request.kind === 'open') {
        if (opening >= 2 || views.size >= 64) throw new BoundaryError('QUERY_LIMIT'); opening++;
        try {
          const target = bindResourceTarget(request.target, await options.config.read(request.selection, signal), options.serviceGeneration);
          if (signal.aborted || closed) throw new BoundaryError('QUERY_CANCELLED');
          if (views.size >= 64) throw new BoundaryError('QUERY_LIMIT');
          const capability = randomBytes(32).toString('hex'), id = randomUUID(), expiresAt = Date.now() + 120_000;
          views.set(id, Object.freeze({ id, expiresAt, digest: digest(capability), target: immutable(target), selection: immutable(request.selection) }));
          return { protocol: 2, kind: 'view', grant: { id, capability, expiresAt, serviceGeneration: options.serviceGeneration } };
        } finally { opening--; }
      }
      if (request.kind === 'close') {
        const owner = view(request.grant); views.delete(owner.id); for (const record of records.values()) if (record.view.id === owner.id) cancel(record);
        return { protocol: 2, kind: 'closed' };
      }
      if (request.kind === 'prepare') {
        const owner = view(request.grant);
        if (preparing >= 2 || records.size >= 128) throw new BoundaryError('QUERY_LIMIT'); preparing++;
        try {
          await options.resources.verifyReference({ target: owner.target, selection: owner.selection, reference: request.parameters.reference }, signal);
          view(request.grant); if (signal.aborted || closed) throw new BoundaryError('QUERY_CANCELLED');
          if (records.size >= 128) throw new BoundaryError('QUERY_LIMIT');
          const id = randomUUID(), proof = randomBytes(32).toString('hex'), now = Date.now(), expiresAt = Math.min(now + 60_000, owner.expiresAt);
          const outcome: DeleteOutcome = immutable({ id, owner: owner.id, step: 'delete-request', dependencies: [], target: owner.target, parameters: request.parameters, createdAt: now, updatedAt: now, phase: 'prepared' });
          records.set(id, { view: owner, proof: digest(proof), expiresAt, outcome, controller: new AbortController() });
          return { protocol: 2, kind: 'confirmation', outcome, proof, expiresAt };
        } finally { preparing--; }
      }
      const record = owned(request.grant, request.id);
      if (request.kind === 'cancel') { cancel(record); return { protocol: 2, kind: 'outcome', outcome: record.outcome }; }
      if (!equal(record.proof, request.proof)) throw new BoundaryError('FORBIDDEN');
      if (record.outcome.phase !== 'prepared') return { protocol: 2, kind: 'outcome', outcome: record.outcome }; // Same ticket is never dispatched twice.
      current(record); if (queued.length >= 16) throw new BoundaryError('QUERY_LIMIT');
      update(record, 'queued'); queued.push(record); pump(); // HTTP disconnect does NOT cancel a submitted operation.
      return { protocol: 2, kind: 'outcome', outcome: record.outcome };
    },
    counts(): { [phase: string]: number } {
      // Stop-gate aggregate: phase counts only, never record content/targets.
      const phases: { [phase: string]: number } = {};
      for (const record of records.values()) phases[record.outcome.phase] = (phases[record.outcome.phase] ?? 0) + 1;
      return phases;
    },
    close() {
      closed = true; views.clear(); for (const record of records.values()) cancel(record); queued.length = 0;
      // No kill, rollback, resource deletion, or cleanup of dispatched writes on service shutdown.
    },
  };
}
