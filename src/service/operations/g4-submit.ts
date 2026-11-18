// Universal G4 submit gate and multi-step operation ledger shared by WRITE chains:
// view grant -> fresh proof -> limited 60s confirmation -> ONE dispatch -> original ledger.
// Never import/instantiate/call this from automated functional tests or any read path.
// Per-command gates already shipped (delete/scale/...) keep their audited shape; every NEW
// write operation (ApplyFile, ImageRun, Sync, SaveKubeconfig, Helm cluster writes, ...) uses
// this engine so serviceGeneration, operation IDs, immutable snapshots, dedup, the 60s
// confirmation window and the unknown-blocks-progress rule cannot drift per command.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { g4Limits, g4ViewLifetimeMs, g4ConfirmationLifetimeMs, g4PruneDue } from '../../shared/g4-submit-protocol.ts';
import type { G4ViewGrant, G4Phase } from '../../shared/g4-submit-protocol.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';

export type G4Outcome<P> = {
  readonly id: string; readonly owner: string; readonly step: string; readonly dependencies: readonly never[];
  readonly target: TargetIdentity; readonly parameters: P;
  readonly createdAt: number; readonly updatedAt: number;
  readonly phase: G4Phase; readonly code?: ErrorCode; readonly details?: unknown;
};
export type G4DispatchResult = { readonly outcome: 'accepted' | 'failed' | 'unknown'; readonly code?: ErrorCode; readonly details?: unknown };
export type G4LedgerView = { readonly id: string; readonly digest: Buffer; readonly expiresAt: number; readonly target: TargetIdentity; readonly selection: ConfigSelection };
export type G4LedgerRecord<P, A = unknown> = { readonly view: G4LedgerView; readonly proof: Buffer; readonly expiresAt: number; outcome: G4Outcome<P>; readonly controller: AbortController; readonly attachment?: A };
type View = G4LedgerView;
type Record_<P, A = unknown> = G4LedgerRecord<P, A>;
const digest = (value: string) => createHash('sha256').update(value).digest();
const equal = (stored: Buffer, value: string) => timingSafeEqual(stored, digest(value));
function immutable<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); } return value; }

export interface G4GateOptions<P, A = unknown> {
  readonly serviceGeneration: string;
  readonly lock: ConfigurationWriteLock;
  /** Bind the request target against a FRESH config read at view-open time. */
  readonly bind: (target: TargetIdentity, selection: ConfigSelection, signal: AbortSignal) => Promise<TargetIdentity>;
  /** Optional prepare-time proof (e.g. reference pre-check) before a record is created. */
  readonly verifyPrepare?: (target: TargetIdentity, parameters: P, signal: AbortSignal) => Promise<void>;
  /** Optional execute-time fresh proof under the write lock, before the single dispatch. */
  readonly verifyExecute?: (record: Record_<P, A>, signal: AbortSignal) => Promise<void>;
  /** The ONE dispatch. beforeDispatch() flips the record to 'dispatching'; after it, retries are impossible. */
  readonly dispatch: (record: Record_<P, A>, beforeDispatch: () => void, signal: AbortSignal) => Promise<G4DispatchResult>;
  /** Serialization key for exclusive execution; defaults to the target's config identity. */
  readonly lockKey?: (target: TargetIdentity) => string;
  /** Bounded dispatch timeout; the controller aborts but never kills or retries a dispatch. */
  readonly dispatchTimeoutMs?: number;
  /** Ledger step label; defaults to 'g4-submit'. */
  readonly step?: string;
}

export function createG4SubmitGate<P, A = unknown>(options: G4GateOptions<P, A>) {
  const views = new Map<string, View>(), records = new Map<string, Record_<P, A>>(), queued: Record_<P, A>[] = [], locks = new Set<string>();
  let closed = false, running = 0, preparing = 0, opening = 0;
  const lockKeyOf: (target: TargetIdentity) => string = options.lockKey ?? (target => target.configIdentity);
  const dispatchTimeout = options.dispatchTimeoutMs ?? 12_000;
  function update(record: Record_<P, A>, phase: G4Phase, code?: ErrorCode, details?: unknown) {
    record.outcome = immutable({ id: record.outcome.id, owner: record.outcome.owner, step: record.outcome.step, dependencies: [], target: record.outcome.target,
      parameters: record.outcome.parameters, createdAt: record.outcome.createdAt, updatedAt: Date.now(), phase, ...(code ? { code } : {}),
      ...(details !== undefined ? { details: immutable(details) } : record.outcome.details !== undefined ? { details: record.outcome.details } : {}) });
  }
  function prune() {
    const now = Date.now();
    for (const [id, view] of views) if (view.expiresAt <= now) views.delete(id);
    for (const [id, record] of records) {
      if (record.outcome.phase === 'prepared' && record.expiresAt <= now) update(record, 'cancelled', 'CONFIRMATION_EXPIRED');
      if (g4PruneDue(record.outcome, now)) records.delete(id);
      // Unknown records are never silently evicted to admit another submission; a full ledger fails closed.
    }
  }
  function view(grant: G4ViewGrant): View {
    const value = views.get(grant.id);
    if (closed || grant.serviceGeneration !== options.serviceGeneration || !value || value.expiresAt !== grant.expiresAt || value.expiresAt <= Date.now() || !equal(value.digest, grant.capability)) throw new BoundaryError('VIEW_EXPIRED');
    return value;
  }
  function current(record: Record_<P, A>): void {
    if (closed || record.controller.signal.aborted || record.outcome.phase === 'cancelled') throw new BoundaryError('QUERY_CANCELLED');
    if (!views.has(record.view.id) || record.view.expiresAt <= Date.now()) throw new BoundaryError('VIEW_EXPIRED');
    if (record.expiresAt <= Date.now()) throw new BoundaryError('CONFIRMATION_EXPIRED');
  }
  function cancel(record: Record_<P, A>) {
    if (['prepared', 'queued', 'checking'].includes(record.outcome.phase)) {
      update(record, 'cancelled', 'QUERY_CANCELLED'); record.controller.abort();
      const index = queued.indexOf(record); if (index >= 0) queued.splice(index, 1);
    }
    // Dispatch may already have reached the API. Never kill it, retry it, or claim it was undone.
  }
  async function execute(record: Record_<P, A>) {
    const timeout = setTimeout(() => record.controller.abort(), dispatchTimeout);
    try {
      await options.lock.run(record.controller.signal, async () => {
        current(record); update(record, 'checking');
        if (options.verifyExecute) await options.verifyExecute(record, record.controller.signal);
        current(record);
        const result = await options.dispatch(record, () => {
          current(record); clearTimeout(timeout); update(record, 'dispatching');
        }, record.controller.signal);
        update(record, result.outcome, result.code, result.details);
      });
    } catch (error) {
      if (record.outcome.phase !== 'cancelled') update(record, record.outcome.phase === 'dispatching' ? 'unknown' : 'failed', record.outcome.phase === 'dispatching' ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE');
    } finally { clearTimeout(timeout); running--; locks.delete(lockKeyOf(record.view.target)); pump(); }
  }
  function pump() {
    while (!closed && running < g4Limits.running) {
      const index = queued.findIndex(record => !locks.has(lockKeyOf(record.view.target)));
      if (index < 0) return;
      const record = queued.splice(index, 1)[0]; if (!record || record.outcome.phase !== 'queued') continue;
      running++; locks.add(lockKeyOf(record.view.target)); void execute(record);
    }
  }
  function owned(grant: G4ViewGrant, id: string): Record_<P, A> {
    const owner = view(grant), record = records.get(id);
    if (!record || record.view.id !== owner.id) throw new BoundaryError('NOT_FOUND'); return record;
  }
  return {
    get state() {
      // Stop-gate aggregate (read-only counts only; never record content or targets).
      let inFlight = 0, unknown = 0;
      for (const record of records.values()) {
        if (['prepared', 'queued', 'checking', 'dispatching'].includes(record.outcome.phase)) inFlight++;
        if (record.outcome.phase === 'unknown') unknown++;
      }
      return { closed, views: views.size, records: records.size, queued: queued.length, running, inFlight, unknown };
    },
    async open(selection: ConfigSelection, target: TargetIdentity, signal: AbortSignal): Promise<G4ViewGrant> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      if (opening >= g4Limits.opening || views.size >= g4Limits.views) throw new BoundaryError('QUERY_LIMIT'); opening++;
      try {
        const bound = await options.bind(target, selection, signal);
        if (signal.aborted || closed) throw new BoundaryError('QUERY_CANCELLED');
        if (views.size >= g4Limits.views) throw new BoundaryError('QUERY_LIMIT');
        const capability = randomBytes(32).toString('hex'), id = randomUUID(), expiresAt = Date.now() + g4ViewLifetimeMs;
        views.set(id, Object.freeze({ id, expiresAt, digest: digest(capability), target: immutable(bound), selection: immutable(selection) }));
        return { id, capability, expiresAt, serviceGeneration: options.serviceGeneration };
      } finally { opening--; }
    },
    closeView(grant: G4ViewGrant) {
      const owner = view(grant); views.delete(owner.id); for (const record of records.values()) if (record.view.id === owner.id) cancel(record);
    },
    async prepare(grant: G4ViewGrant, parameters: P, attachment: A | undefined, signal: AbortSignal): Promise<{ record: Record_<P, A>; proof: string; expiresAt: number }> {
      const owner = view(grant);
      if (preparing >= g4Limits.preparing || records.size >= g4Limits.records) throw new BoundaryError('QUERY_LIMIT'); preparing++;
      try {
        if (options.verifyPrepare) await options.verifyPrepare(owner.target, parameters, signal);
        view(grant); if (signal.aborted || closed) throw new BoundaryError('QUERY_CANCELLED');
        if (records.size >= g4Limits.records) throw new BoundaryError('QUERY_LIMIT');
        const id = randomUUID(), proof = randomBytes(32).toString('hex'), expiresAt = Date.now() + g4ConfirmationLifetimeMs;
        const record: Record_<P, A> = { view: owner, proof: digest(proof), expiresAt, controller: new AbortController(),
          ...(attachment === undefined ? {} : { attachment: immutable(attachment) }),
          outcome: immutable<G4Outcome<P>>({ id, owner: owner.id, step: options.step ?? 'g4-submit', dependencies: [], target: owner.target, parameters: immutable(parameters),
            createdAt: Date.now(), updatedAt: Date.now(), phase: 'prepared' }) };
        records.set(id, record);
        return { record, proof, expiresAt };
      } finally { preparing--; }
    },
    submit(grant: G4ViewGrant, id: string, proof: string): Record_<P, A> {
      const record = owned(grant, id);
      if (record.outcome.phase !== 'prepared' || !equal(Buffer.from(record.proof), proof)) throw new BoundaryError('CONFLICT');
      if (queued.length >= g4Limits.queued) throw new BoundaryError('QUERY_LIMIT');
      current(record); update(record, 'queued'); queued.push(record); pump();
      return record;
    },
    cancel(grant: G4ViewGrant, id: string) { const record = owned(grant, id); cancel(record); return record; },
    viewOf(grant: G4ViewGrant): View { return view(grant); },
    status(grant: G4ViewGrant, id: string): Record_<P, A> { return owned(grant, id); },
    outcomes(after?: string): { outcomes: G4Outcome<P>[]; next: string | null } {
      const values = [...records.values()].map(record => record.outcome).reverse();
      const offset = after ? values.findIndex(outcome => outcome.id === after) + 1 : 0;
      if (after && !offset) throw new BoundaryError('STALE_TARGET');
      const page = values.slice(offset, offset + g4Limits.outcomePage);
      return { outcomes: page, next: offset + page.length < values.length ? page.at(-1)?.id ?? null : null };
    },
    prune,
    close() { closed = true; for (const record of records.values()) cancel(record); queued.length = 0; },
  };
}
export type G4SubmitGate<P, A = unknown> = ReturnType<typeof createG4SubmitGate<P, A>>;
