// WRITE control plane. Never import, instantiate or invoke from automated functional tests, including status/cancel.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { manifestCreateRequestSchema, manifestCreateResponseSchema, manifestCreateChunkBytes } from '../../shared/manifest-create-protocol.ts';
import type { CreateGrant, CreateOutcome, ManifestCreateResponse } from '../../shared/manifest-create-protocol.ts';
import { readCreatePayload } from '../../shared/manifest-create-payload.ts';
import type { CreatePayloadItem } from '../../shared/manifest-create-payload.ts';
import type { ManifestComparisonReference } from '../../shared/manifest-diff-protocol.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { bindResourceTarget } from '../queries/resource-target.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import type { createResourceGateway } from '../queries/resource-gateway.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';
import type { createWorkspaceReader } from '../queries/workspace-reader.ts';
import type { createFileSaveOperations } from './file-save.ts';
import type { WorkspaceScope } from '../../shared/workspace-protocol.ts';
import { verifiedManifestFilePayload } from '../../parsing/manifest-file-check.ts';
export type ManifestCreateDispatch = { readonly target: TargetIdentity; readonly selection: ConfigSelection; readonly reference: ManifestComparisonReference; readonly text: string; readonly notAfter: number; readonly generated?: boolean };
export type ManifestCreateResult = ({ readonly phase: 'succeeded'; readonly uid: string; readonly resourceVersion: string; readonly name?: string | undefined } | { readonly phase: 'not-submitted' | 'unknown'; readonly code: ErrorCode }) & { readonly cleanup: 'none' | 'manual-check' };
type Record = { readonly binding: string; readonly grant: CreateGrant; readonly proof: Buffer; readonly selection: ConfigSelection; readonly controller: AbortController;
  outcome: CreateOutcome; payload?: Buffer; items?: readonly CreatePayloadItem[]; active: boolean; stopRequested: boolean; timer?: ReturnType<typeof setTimeout>;
  fileScope?: WorkspaceScope; fileProof?: string; fileBaseline?: { identity: string; version: string }; fileChecks: number };
const digest = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
const terminal = (record: Record) => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(record.outcome.phase);
export function createManifestCreateOperations(options: { generation: string; config: ReturnType<typeof createConfigReader>; resources: ReturnType<typeof createResourceGateway>; lock: ConfigurationWriteLock;
  workspace: Pick<ReturnType<typeof createWorkspaceReader>, 'open' | 'rebind' | 'capture' | 'release'>; fileSaves: Pick<ReturnType<typeof createFileSaveOperations>, 'verifyConsumption'>;
  execute: (input: ManifestCreateDispatch, beforeDispatch: (workerLive: () => boolean) => Promise<void>, signal: AbortSignal) => Promise<ManifestCreateResult> }) {
  const records = new Map<string, Record>(), pending = new Set<string>(), queued: Record[] = []; let closed = false, preparing = 0, running = 0;
  function clear(record: Record) {
    record.payload?.fill(0); delete record.payload; delete record.items;
    if (record.fileScope) { try { options.workspace.release({ protocol: 2, scope: record.fileScope }); } catch { /* Fixed private read scope expiry; no filesystem cleanup. */ } }
    delete record.fileScope; delete record.fileProof; delete record.fileBaseline; if (record.timer) clearTimeout(record.timer); delete record.timer;
  }
  function update(record: Record, phase: CreateOutcome['phase'], code?: ErrorCode) {
    const { code: _old, ...value } = record.outcome; record.outcome = freeze({ ...value, phase, updatedAt: Date.now(), ...(code ? { code } : {}) });
    if (terminal(record) && !record.active) clear(record);
  }
  function current(record: Record) {
    if (Date.now() >= record.grant.expiresAt) throw new BoundaryError('CONFIRMATION_EXPIRED');
    if (closed || record.stopRequested || record.controller.signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
  }
  function step(record: Record, index: number, value: Partial<CreateOutcome['steps'][number]>) {
    record.outcome = freeze({ ...record.outcome, updatedAt: Date.now(), steps: record.outcome.steps.map(item => item.index === index ? { ...item, ...value } : item) });
  }
  function owned(grant: CreateGrant) {
    const record = records.get(grant.id);
    if (!record || grant.generation !== options.generation || record.grant.expiresAt !== grant.expiresAt || !timingSafeEqual(record.proof, Buffer.from(digest(grant.capability), 'hex'))) throw new BoundaryError('FORBIDDEN'); return record;
  }
  function cancel(record: Record) {
    if (terminal(record)) return; record.stopRequested = true;
    if (record.outcome.phase === 'dispatching') return; // Never kill/replay a submitted API request as a purported rollback.
    record.controller.abort(); if (!record.active) { skipped(record); update(record, 'cancelled', 'QUERY_CANCELLED'); }
  }
  async function bind(record: Record) {
    if ([...records.values()].some(other => other !== record && (other.outcome.phase === 'unknown' || other.outcome.cleanup === 'manual-check')
      && other.outcome.target.configIdentity === record.outcome.target.configIdentity && other.outcome.target.context === record.outcome.target.context)) throw new BoundaryError('OPERATION_UNKNOWN');
    current(record); bindResourceTarget(record.outcome.target, await options.config.read(record.selection, record.controller.signal), options.generation); current(record);
  }
  async function verifyFile(record: Record, outer = record.controller.signal): Promise<string | undefined> {
    const file = record.outcome.source.file; if (!file) return undefined; current(record);
    if (++record.fileChecks > 100) throw new BoundaryError('BUDGET_EXCEEDED');
    const signal = AbortSignal.any([outer, record.controller.signal, AbortSignal.timeout(5000)]);
    const guard = () => options.fileSaves.verifyConsumption({ root: file.root, path: file.path, identity: file.identity, digest: record.outcome.source.identity, ...(file.receipt ? { receipt: file.receipt } : {}) }, signal);
    await guard(); current(record);
    if (!record.fileScope) {
      const opened = file.receipt ? await options.workspace.open({ protocol: 2, root: file.root }, signal)
        : await options.workspace.rebind({ protocol: 2, root: file.root, path: file.path, proof: record.fileProof }, signal);
      record.fileScope = opened.scope;
      if (!file.receipt && (!('identity' in opened) || opened.identity !== file.identity || opened.version !== file.version)) throw new BoundaryError('CONFLICT');
    }
    const actual = await options.workspace.capture({ protocol: 2, scope: record.fileScope, path: file.path }, signal);
    if (actual.root !== file.root || actual.path !== file.path || digest(actual.text) !== record.outcome.source.identity) throw new BoundaryError('CONFLICT');
    if (!file.receipt && (actual.identity !== file.identity || actual.version !== file.version)) throw new BoundaryError('CONFLICT');
    if (record.fileBaseline && (actual.identity !== record.fileBaseline.identity || actual.version !== record.fileBaseline.version)) throw new BoundaryError('CONFLICT');
    record.fileBaseline ??= { identity: actual.identity, version: actual.version };
    await guard(); current(record); return actual.text;
  }
  async function proof(record: Record, index: number, expected?: ManifestComparisonReference) {
    const item = record.items?.[index]; if (!item) throw new BoundaryError('STATE_UNAVAILABLE'); await bind(record);
    // A generateName create has no by-name non-existence proof: the server assigns the suffix on
    // the collection POST, so only the GVR resolution is proven and the name is backfilled after.
    const reference = item.generated === true
      ? await options.resources.resolveLocator({ target: record.outcome.target, selection: record.selection, locator: item.locator }, record.controller.signal)
      : await options.resources.proveManifestCreate({ target: record.outcome.target, selection: record.selection, locator: item.locator }, record.controller.signal);
    if (expected && JSON.stringify(reference) !== JSON.stringify(expected)) throw new BoundaryError('STALE_TARGET'); await verifyFile(record); await bind(record); return reference;
  }
  function skipped(record: Record) {
    record.outcome = freeze({ ...record.outcome, steps: record.outcome.steps.map(item => item.phase === 'pending' || item.phase === 'checking' ? { ...item, phase: 'not-started' as const } : item) });
  }
  async function execute(record: Record) {
    record.active = true;
    try {
      await options.lock.run(record.controller.signal, async () => {
        current(record); update(record, 'checking');
        for (const item of record.outcome.steps) {
          current(record); if (!item.reference) throw new BoundaryError('STATE_UNAVAILABLE'); step(record, item.index, { phase: 'checking' });
          const reference = await proof(record, item.index, item.reference), text = record.items?.[item.index]?.text; if (!text) throw new BoundaryError('STATE_UNAVAILABLE');
          const result = await options.execute({ target: record.outcome.target, selection: record.selection, reference, text, notAfter: record.grant.expiresAt, ...(record.items?.[item.index]?.generated ? { generated: true } : {}) }, async workerLive => {
            await proof(record, item.index, reference); current(record); if (!workerLive()) throw new BoundaryError('QUERY_CANCELLED'); step(record, item.index, { phase: 'dispatching' }); update(record, 'dispatching');
          }, record.controller.signal);
          if (result.cleanup === 'manual-check') record.outcome = freeze({ ...record.outcome, cleanup: 'manual-check' });
          if (result.phase === 'succeeded') { step(record, item.index, { phase: 'succeeded', uid: result.uid, resourceVersion: result.resourceVersion, ...(result.name !== undefined ? { name: result.name } : {}) }); update(record, 'checking'); }
          else { step(record, item.index, { phase: result.phase === 'unknown' ? 'unknown' : 'failed', code: result.code }); skipped(record); update(record, result.phase === 'unknown' ? 'unknown' : 'failed', result.code); return; }
          if (result.cleanup === 'manual-check') { skipped(record); update(record, 'failed', 'STATE_UNAVAILABLE'); return; }
        }
        update(record, 'succeeded'); // Every item is known succeeded; cancellation cannot erase already completed work.
      });
    } catch (error) {
      const unknown = record.outcome.phase === 'dispatching', index = record.outcome.steps.find(item => item.phase === 'dispatching' || item.phase === 'checking')?.index;
      const code = unknown ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE';
      if (index !== undefined) step(record, index, { phase: unknown ? 'unknown' : 'failed', code }); skipped(record);
      update(record, unknown ? 'unknown' : record.stopRequested ? 'cancelled' : 'failed', code);
    } finally { record.active = false; clear(record); running--; pump(); }
  }
  function pump() { while (!closed && running < 2 && queued.length) { const record = queued.shift(); if (!record || terminal(record)) continue; running++; void execute(record); } }
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<ManifestCreateResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED'); const parsed = manifestCreateRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const request = parsed.data;
      for (const record of records.values()) if (!record.active && !terminal(record) && Date.now() >= record.grant.expiresAt) { skipped(record); update(record, 'failed', 'CONFIRMATION_EXPIRED'); clear(record); }
      if (request.kind === 'outcomes') {
        const values = [...records.values()].map(record => record.outcome).reverse(), offset = request.after ? values.findIndex(value => value.id === request.after) + 1 : 0;
        if (request.after && !offset) throw new BoundaryError('STALE_TARGET'); const outcomes = values.slice(offset, offset + 4);
        return manifestCreateResponseSchema.parse({ protocol: 2, kind: 'outcomes', generation: options.generation, outcomes, next: offset + outcomes.length < values.length ? outcomes.at(-1)?.id ?? null : null });
      }
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (request.kind === 'begin') {
        const binding = digest(JSON.stringify([request.target, request.selection, request.source, request.bytes, request.digest, request.fileProof ?? null]));
        const previous = [...records.values()].find(record => record.outcome.requestId === request.requestId);
        if (previous) { if (previous.binding !== binding) throw new BoundaryError('CONFLICT'); return terminal(previous) || previous.active ? { protocol: 2, kind: 'outcome', outcome: previous.outcome }
          : { protocol: 2, kind: previous.outcome.phase === 'prepared' ? 'confirmation' : 'upload', grant: previous.grant, outcome: previous.outcome }; }
        if (pending.has(request.requestId) || preparing >= 2 || records.size + preparing >= 64 || [...records.values()].filter(record => record.payload || record.items).length + preparing >= 4) throw new BoundaryError('QUERY_LIMIT');
        if ([...records.values()].some(record => (record.outcome.phase === 'unknown' || record.outcome.cleanup === 'manual-check') && record.outcome.target.configIdentity === request.target.configIdentity && record.outcome.target.context === request.target.context)) throw new BoundaryError('OPERATION_UNKNOWN');
        preparing++; pending.add(request.requestId); const now = Date.now(), expiresAt = now + 60_000;
        try {
          const target = bindResourceTarget(request.target, await options.config.read(request.selection, AbortSignal.any([signal, AbortSignal.timeout(5000)])), options.generation);
          if (closed || signal.aborted || Date.now() >= expiresAt) throw new BoundaryError('QUERY_CANCELLED');
          const id = randomUUID(), capability = randomBytes(32).toString('hex'), grant = freeze({ id, generation: options.generation, capability, expiresAt });
          const outcome = freeze<CreateOutcome>({ id, generation: options.generation, requestId: request.requestId, target, source: request.source, bytes: request.bytes, digest: request.digest,
            received: 0, createdAt: now, updatedAt: Date.now(), expiresAt, phase: 'uploading', steps: [], cleanup: 'none' });
          const record: Record = { binding, grant, proof: Buffer.from(digest(capability), 'hex'), selection: freeze(request.selection), controller: new AbortController(), outcome, active: false, stopRequested: false,
            fileChecks: 0, ...(request.fileProof ? { fileProof: request.fileProof } : {}) };
          try {
            const text = await verifyFile(record, signal);
            if (text !== undefined) {
              const file = record.outcome.source.file; if (!file) throw new BoundaryError('STATE_UNAVAILABLE');
              const canonical = verifiedManifestFilePayload(text, file.format, { sourceDigest: record.outcome.source.identity, payloadDigest: request.digest, payloadBytes: request.bytes });
              record.payload = Buffer.from(canonical); record.outcome = freeze({ ...record.outcome, received: request.bytes });
            } else record.payload = Buffer.alloc(request.bytes);
            current(record); if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
          } catch (error) { clear(record); throw error; }
          record.timer = setTimeout(() => {
            if (terminal(record)) return;
            if (!record.active) { skipped(record); update(record, 'failed', 'CONFIRMATION_EXPIRED'); }
            else if (record.outcome.phase === 'dispatching') record.stopRequested = true;
            else record.controller.abort();
          }, Math.max(1, expiresAt - Date.now())); records.set(id, record); return { protocol: 2, kind: 'upload', grant, outcome: record.outcome };
        } finally { preparing--; pending.delete(request.requestId); }
      }
      const record = owned(request.grant);
      if (request.kind === 'status') return { protocol: 2, kind: 'outcome', outcome: record.outcome };
      if (request.kind === 'cancel') { cancel(record); return { protocol: 2, kind: 'outcome', outcome: record.outcome }; }
      if (record.active || terminal(record) || record.outcome.phase === 'queued') return { protocol: 2, kind: 'outcome', outcome: record.outcome }; current(record);
      if (request.kind === 'upload') {
        if (record.outcome.phase !== 'uploading' || !record.payload) throw new BoundaryError('CONFLICT'); const bytes = Buffer.from(request.data, 'base64');
        try {
          const expected = Math.min(manifestCreateChunkBytes, record.outcome.bytes - request.offset);
          if (bytes.toString('base64') !== request.data || bytes.length !== expected || expected < 1 || request.offset % manifestCreateChunkBytes !== 0 || request.offset > record.outcome.received) throw new BoundaryError('CONTENT_INVALID');
          if (request.offset < record.outcome.received) { if (request.offset + bytes.length > record.outcome.received || !timingSafeEqual(record.payload.subarray(request.offset, request.offset + bytes.length), bytes)) throw new BoundaryError('CONFLICT'); }
          else { bytes.copy(record.payload, request.offset); record.outcome = freeze({ ...record.outcome, received: request.offset + bytes.length, updatedAt: Date.now() }); }
          return { protocol: 2, kind: 'upload', grant: record.grant, outcome: record.outcome };
        } finally { bytes.fill(0); }
      }
      if (request.kind === 'finish') {
        if (record.outcome.phase === 'prepared') return { protocol: 2, kind: 'confirmation', grant: record.grant, outcome: record.outcome };
        if (record.outcome.phase !== 'uploading' || !record.payload || record.outcome.received !== record.outcome.bytes) throw new BoundaryError('CONFLICT');
        record.active = true; preparing++;
        try {
          if (preparing > 2) throw new BoundaryError('QUERY_LIMIT');
          await verifyFile(record);
          if (digest(record.payload) !== record.outcome.digest) throw new BoundaryError('CONTENT_INVALID');
          const items = readCreatePayload(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(record.payload)); record.items = items; record.payload.fill(0); delete record.payload;
          const keys = items.map(item => JSON.stringify([item.locator.group, item.locator.version, item.locator.kind, item.locator.name, item.locator.namespace ?? record.outcome.target.namespace, ...(item.generated ? [digest(item.text)] : [])])); // identical generateName prefixes may coexist; the pinned text disambiguates
          if (new Set(keys).size !== keys.length) throw new BoundaryError('CONFLICT');
          record.outcome = freeze({ ...record.outcome, phase: 'preparing', steps: items.map((item, index) => ({ index, locator: item.locator, ...(item.generated ? { generated: true } : {}), phase: 'pending' as const })) });
          for (let index = 0; index < items.length; index++) step(record, index, { reference: await proof(record, index) });
          current(record); if (Buffer.byteLength(JSON.stringify(record.outcome)) > 100_000) throw new BoundaryError('BUDGET_EXCEEDED'); update(record, 'prepared');
        } catch (error) { skipped(record); update(record, record.stopRequested ? 'cancelled' : 'failed', error instanceof BoundaryError ? error.code : 'CONTENT_INVALID'); }
        finally { record.active = false; preparing--; if (terminal(record)) clear(record); }
        return manifestCreateResponseSchema.parse({ protocol: 2, kind: record.outcome.phase === 'prepared' ? 'confirmation' : 'outcome', ...(record.outcome.phase === 'prepared' ? { grant: record.grant } : {}), outcome: record.outcome });
      }
      if (record.outcome.phase !== 'prepared' || !record.items || queued.length >= 16) throw new BoundaryError('CONFLICT');
      update(record, 'queued'); queued.push(record); pump(); // Only this explicit confirmed submit enters a writer; disconnect is not rollback.
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
