// WRITE control plane for ConfigMap/Secret data-key add. Never import/instantiate/call from automated functional tests.
// E024 file-source verification (original read proof, no Save receipts) + delete-shaped G4 chain + one PUT.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { configFileAddRequestSchema, configFileAddResponseSchema, configFileAddParametersSchema } from '../../shared/config-file-add-protocol.ts';
import type { ConfigFileAddOutcome, ConfigFileAddViewGrant } from '../../shared/config-file-add-protocol.ts';
import type { ConfigFileAddResponse } from '../../shared/config-file-add-protocol.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { bindResourceTarget } from '../queries/resource-target.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import type { createResourceGateway } from '../queries/resource-gateway.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';
import type { createWorkspaceReader } from '../queries/workspace-reader.ts';
import type { createFileSaveOperations } from './file-save.ts';
import type { WorkspaceScope } from '../../shared/workspace-protocol.ts';
import type { ConfigFileAddDispatch, ConfigFileAddResult } from '../adapters/config-file-add-https.ts';

type View = { readonly id: string; readonly digest: Buffer; readonly expiresAt: number; readonly target: TargetIdentity; readonly selection: ConfigSelection };
type Record = { readonly view: View; readonly proof: Buffer; readonly expiresAt: number; outcome: ConfigFileAddOutcome; readonly controller: AbortController;
  fileScope?: WorkspaceScope; fileProof?: string; fileBaseline?: { identity: string; version: string }; fileChecks: number; value?: string };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const digestBuffer = (value: string) => createHash('sha256').update(value).digest();
const equal = (stored: Buffer, value: string) => timingSafeEqual(stored, digestBuffer(value));
function immutable<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); } return value; }

export function createConfigFileAddOperations(options: { serviceGeneration: string; config: ReturnType<typeof createConfigReader>; resources: ReturnType<typeof createResourceGateway>;
  workspace: Pick<ReturnType<typeof createWorkspaceReader>, 'open' | 'rebind' | 'capture' | 'release'>; fileSaves: Pick<ReturnType<typeof createFileSaveOperations>, 'verifyConsumption'>;
  execute: (input: ConfigFileAddDispatch, beforeDispatch: () => void, signal: AbortSignal) => Promise<ConfigFileAddResult>; lock: ConfigurationWriteLock }) {
  const views = new Map<string, View>(), records = new Map<string, Record>(), queued: Record[] = [], locks = new Set<string>();
  let closed = false, running = 0, preparing = 0, opening = 0;
  function clear(record: Record) {
    if (record.fileScope) { try { options.workspace.release({ protocol: 2, scope: record.fileScope }); } catch { /* Fixed private read scope expiry; no filesystem cleanup. */ } }
    delete record.fileScope; delete record.fileProof; delete record.fileBaseline; delete record.value;
  }
  function update(record: Record, phase: ConfigFileAddOutcome['phase'], code?: ErrorCode) {
    record.outcome = immutable({ id: record.outcome.id, owner: record.outcome.owner, step: record.outcome.step, dependencies: [], target: record.outcome.target, parameters: record.outcome.parameters,
      createdAt: record.outcome.createdAt, updatedAt: Date.now(), phase, ...(record.outcome.encodedBytes !== undefined ? { encodedBytes: record.outcome.encodedBytes } : {}), ...(code ? { code } : {}) });
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
  function view(grant: ConfigFileAddViewGrant): View {
    const value = views.get(grant.id);
    if (closed || grant.serviceGeneration !== options.serviceGeneration || !value || value.expiresAt !== grant.expiresAt || value.expiresAt <= Date.now() || !equal(value.digest, grant.capability)) throw new BoundaryError('VIEW_EXPIRED');
    return value;
  }
  function current(record: Record): void {
    if (closed || record.controller.signal.aborted || record.outcome.phase === 'cancelled') throw new BoundaryError('QUERY_CANCELLED');
    if (!views.has(record.view.id) || record.view.expiresAt <= Date.now()) throw new BoundaryError('VIEW_EXPIRED');
    if (record.expiresAt <= Date.now()) throw new BoundaryError('CONFIRMATION_EXPIRED');
  }
  // E024 pattern: original 24h read proof rebinds to a private scope; the Save ledger is only checked for in-flight/unknown writes.
  async function verifyFile(record: Record, outer: AbortSignal | undefined): Promise<string> {
    const file = record.outcome.parameters.file; current(record);
    if (++record.fileChecks > 100) throw new BoundaryError('BUDGET_EXCEEDED');
    const signal = AbortSignal.any([outer ?? record.controller.signal, record.controller.signal, AbortSignal.timeout(5000)]);
    const guard = () => options.fileSaves.verifyConsumption({ root: file.root, path: file.path, identity: file.identity, digest: record.outcome.parameters.sourceDigest }, signal);
    await guard(); current(record);
    if (!record.fileScope) {
      if (!record.fileProof) throw new BoundaryError('VIEW_EXPIRED');
      const opened = await options.workspace.rebind({ protocol: 2, root: file.root, path: file.path, proof: record.fileProof }, signal);
      record.fileScope = opened.scope;
      if (!('identity' in opened) || opened.identity !== file.identity || opened.version !== file.version) throw new BoundaryError('CONFLICT');
    }
    const actual = await options.workspace.capture({ protocol: 2, scope: record.fileScope, path: file.path }, signal);
    if (actual.root !== file.root || actual.path !== file.path || digest(actual.text) !== record.outcome.parameters.sourceDigest) throw new BoundaryError('CONFLICT');
    if (actual.identity !== file.identity || actual.version !== file.version) throw new BoundaryError('CONFLICT');
    if (record.fileBaseline && (actual.identity !== record.fileBaseline.identity || actual.version !== record.fileBaseline.version)) throw new BoundaryError('CONFLICT');
    record.fileBaseline ??= { identity: actual.identity, version: actual.version };
    await guard(); current(record); return actual.text;
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
        const value = await verifyFile(record, undefined);
        if (!record.value || record.value !== value) throw new BoundaryError('CONFLICT');
        const result = await options.execute({ target: record.view.target, selection: record.view.selection, parameters: record.outcome.parameters, value, notAfter: record.expiresAt }, () => {
          current(record); clearTimeout(timeout); update(record, 'dispatching');
        }, record.controller.signal);
        update(record, result.outcome === 'accepted' ? 'accepted' : result.outcome === 'unknown' ? 'unknown' : 'failed', result.code);
      });
    } catch (error) {
      if (record.outcome.phase !== 'cancelled') update(record, record.outcome.phase === 'dispatching' ? 'unknown' : 'failed', record.outcome.phase === 'dispatching' ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE');
    } finally { clearTimeout(timeout); running--; locks.delete(record.view.target.configIdentity); clear(record); pump(); }
  }
  function pump() {
    while (!closed && running < 2) {
      const index = queued.findIndex(record => !locks.has(record.view.target.configIdentity));
      if (index < 0) return;
      const record = queued.splice(index, 1)[0]; if (!record || record.outcome.phase !== 'queued') continue;
      running++; locks.add(record.view.target.configIdentity); void execute(record);
    }
  }
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<ConfigFileAddResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = configFileAddRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const request = parsed.data; prune();
      if (request.kind === 'outcomes') {
        const outcomes = [...records.values()].map(record => record.outcome).reverse();
        const offset = request.after ? outcomes.findIndex(outcome => outcome.id === request.after) + 1 : 0;
        if (request.after && !offset) throw new BoundaryError('STALE_TARGET');
        const page = outcomes.slice(offset, offset + 16);
        return configFileAddResponseSchema.parse({ protocol: 2, kind: 'outcomes', serviceGeneration: options.serviceGeneration, outcomes: page,
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
          views.set(id, Object.freeze({ id, expiresAt, digest: digestBuffer(capability), target: immutable(target), selection: immutable(request.selection) }));
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
          configFileAddParametersSchema.parse(request.parameters);
          await options.resources.verifyReference({ target: owner.target, selection: owner.selection, reference: request.parameters.reference }, signal);
          view(request.grant); if (signal.aborted || closed) throw new BoundaryError('QUERY_CANCELLED');
          if (records.size >= 128) throw new BoundaryError('QUERY_LIMIT');
          const id = randomUUID(), capability = randomBytes(32).toString('hex'), expiresAt = Date.now() + 60_000;
          const record: Record = { view: owner, proof: digestBuffer(capability), expiresAt, controller: new AbortController(), fileChecks: 0, fileProof: request.fileProof,
            outcome: immutable<ConfigFileAddOutcome>({ id, owner: owner.id, step: 'config-file-add', dependencies: [], target: owner.target, parameters: request.parameters,
              createdAt: Date.now(), updatedAt: Date.now(), phase: 'prepared' }) };
          try {
            record.value = await verifyFile(record, signal);
            record.outcome = immutable({ ...record.outcome, encodedBytes: Buffer.byteLength(record.value, 'utf8') });
          } catch (error) { clear(record); update(record, 'failed', error instanceof BoundaryError ? error.code : 'CONTENT_INVALID'); return { protocol: 2, kind: 'outcome', outcome: record.outcome }; }
          records.set(id, record);
          return { protocol: 2, kind: 'confirmation', outcome: record.outcome, proof: capability, expiresAt };
        } finally { preparing--; }
      }
      const record = records.get(request.id);
      if (!record || record.view.id !== view(request.grant).id) throw new BoundaryError('NOT_FOUND');
      if (request.kind === 'cancel') { cancel(record); return { protocol: 2, kind: 'outcome', outcome: record.outcome }; }
      if (record.outcome.phase !== 'prepared' || !equal(Buffer.from(record.proof), request.proof)) throw new BoundaryError('CONFLICT');
      if (queued.length >= 16) throw new BoundaryError('QUERY_LIMIT');
      current(record); update(record, 'queued'); queued.push(record); pump();
      return { protocol: 2, kind: 'outcome', outcome: record.outcome };
    },
    counts(): { [phase: string]: number } {
      // Stop-gate aggregate: phase counts only, never record content/targets.
      const phases: { [phase: string]: number } = {};
      for (const record of records.values()) phases[record.outcome.phase] = (phases[record.outcome.phase] ?? 0) + 1;
      return phases;
    },
    close() { closed = true; for (const record of records.values()) cancel(record); queued.length = 0; },
  };
}
