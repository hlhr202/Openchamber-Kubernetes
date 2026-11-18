// WRITE control plane, including begin/upload/finish/status/cancel. Static review only; never automatic functional execution.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { manifestApplyRequestSchema, manifestApplyResponseSchema, manifestApplyChunkBytes } from '../../shared/manifest-apply-protocol.ts';
import type { ApplyOutcome, ApplyGrant, ManifestApplyResponse } from '../../shared/manifest-apply-protocol.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { customDocumentReferenceSchema } from '../../shared/document-protocol.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import type { createResourceGateway } from '../queries/resource-gateway.ts';
import { bindResourceTarget } from '../queries/resource-target.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';
import { prepareManifestApplyPatch, prepareManifestApplyCreate } from './manifest-apply-patch.ts';
export type ManifestApplyDispatch = { target: TargetIdentity; selection: ConfigSelection; reference: ReturnType<typeof customDocumentReferenceSchema.parse>; body: string; notAfter: number };
export type ManifestApplyCreateDispatch = { target: TargetIdentity; selection: ConfigSelection; reference: ReturnType<typeof customDocumentReferenceSchema.parse>; body: string; notAfter: number };
export type ManifestApplyResult = { phase: 'succeeded'; resourceVersion: string } | { phase: 'failed' | 'unknown' | 'not-submitted'; code: ErrorCode };
export type ManifestApplyCreateResult = { phase: 'succeeded'; uid: string; resourceVersion: string } | { phase: 'failed' | 'unknown' | 'not-submitted'; code: ErrorCode };
type Record = { binding: string; grant: ApplyGrant; proof: Buffer; selection: ConfigSelection; controller: AbortController; outcome: ApplyOutcome;
  payload?: Buffer; patch?: Buffer; liveDigest?: string; active: boolean; stop: boolean; timer?: ReturnType<typeof setTimeout> };
const digest = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
const terminal = (record: Record) => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(record.outcome.phase);
export function createManifestApplyOperations(options: { generation: string; config: ReturnType<typeof createConfigReader>; resources: ReturnType<typeof createResourceGateway>; lock: ConfigurationWriteLock;
  adapter: { check(input: Pick<ManifestApplyDispatch, 'target' | 'selection'>, signal: AbortSignal): Promise<void>; execute(input: ManifestApplyDispatch, beforeDispatch: () => Promise<void>, signal: AbortSignal): Promise<ManifestApplyResult>;
    create(input: ManifestApplyCreateDispatch, beforeDispatch: () => Promise<void>, signal: AbortSignal): Promise<ManifestApplyCreateResult> } }) {
  const records = new Map<string, Record>(), pending = new Set<string>(), queue: Record[] = []; let closed = false, preparing = 0, running = 0;
  function clear(record: Record) { record.payload?.fill(0); record.patch?.fill(0); delete record.payload; delete record.patch; delete record.liveDigest; if (record.timer) clearTimeout(record.timer); delete record.timer; }
  function update(record: Record, phase: ApplyOutcome['phase'], code?: ErrorCode) {
    const { code: _old, ...value } = record.outcome; record.outcome = freeze({ ...value, phase, updatedAt: Date.now(), ...(code ? { code } : {}) }); if (terminal(record) && !record.active) clear(record);
  }
  function current(record: Record) { if (Date.now() >= record.grant.expiresAt) throw new BoundaryError('CONFIRMATION_EXPIRED'); if (closed || record.stop || record.controller.signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); }
  function blocked(target: TargetIdentity, own?: Record) { if ([...records.values()].some(record => record !== own && record.outcome.phase === 'unknown' && record.outcome.target.configIdentity === target.configIdentity && record.outcome.target.context === target.context)) throw new BoundaryError('OPERATION_UNKNOWN'); }
  async function proof(record: Record, outer: AbortSignal | undefined, expect: 'live' | 'missing') {
    current(record); blocked(record.outcome.target, record); const signal = outer ? AbortSignal.any([outer, record.controller.signal]) : record.controller.signal;
    bindResourceTarget(record.outcome.target, await options.config.read(record.selection, signal), options.generation);
    const snapshot = await options.resources.captureManifestApply({ target: record.outcome.target, selection: record.selection, reference: record.outcome.reference, expect }, signal);
    current(record); if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
    if (expect === 'missing') return '';
    if (!('text' in snapshot)) throw new BoundaryError('STATE_UNAVAILABLE');
    if (record.liveDigest && digest(snapshot.text) !== record.liveDigest) throw new BoundaryError('CONFLICT');
    return snapshot.text;
  }
  function cancel(record: Record) { if (terminal(record)) return; record.stop = true; if (record.outcome.phase === 'dispatching') return; record.controller.abort(); if (!record.active) update(record, 'cancelled', 'QUERY_CANCELLED'); }
  async function execute(record: Record) {
    record.active = true;
    try {
      await options.lock.run(record.controller.signal, async () => {
        update(record, 'checking'); await proof(record, undefined, record.outcome.missing ? 'missing' : 'live');
        if (!record.patch || digest(record.patch) !== record.outcome.patchDigest) throw new BoundaryError('CONTENT_INVALID');
        if (record.outcome.missing) {
          // The explicitly confirmed Create branch: one POST with the prepared body, never a silent apply-to-create.
          const result = await options.adapter.create({ target: record.outcome.target, selection: record.selection, reference: record.outcome.reference, body: new TextDecoder('utf-8', { fatal: true }).decode(record.patch), notAfter: record.grant.expiresAt }, async () => {
            await proof(record, undefined, 'missing'); current(record); update(record, 'dispatching');
          }, record.controller.signal);
          if (result.phase === 'succeeded') { record.outcome = freeze({ ...record.outcome, uidAfter: result.uid, resourceVersionAfter: result.resourceVersion }); update(record, 'succeeded'); }
          else update(record, result.phase === 'unknown' ? 'unknown' : 'failed', result.code);
          return;
        }
        if (record.outcome.unchanged) { record.outcome = freeze({ ...record.outcome, resourceVersionAfter: record.outcome.reference.resourceVersion }); update(record, 'succeeded'); return; }
        const result = await options.adapter.execute({ target: record.outcome.target, selection: record.selection, reference: record.outcome.reference, body: new TextDecoder('utf-8', { fatal: true }).decode(record.patch), notAfter: record.grant.expiresAt }, async () => {
          await proof(record, undefined, 'live'); current(record); update(record, 'dispatching');
        }, record.controller.signal);
        if (result.phase === 'succeeded') { record.outcome = freeze({ ...record.outcome, resourceVersionAfter: result.resourceVersion }); update(record, 'succeeded'); }
        else update(record, result.phase === 'unknown' ? 'unknown' : 'failed', result.code);
      });
    } catch (error) { const unknown = record.outcome.phase === 'dispatching'; update(record, unknown ? 'unknown' : record.stop ? 'cancelled' : 'failed', unknown ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
    finally { record.active = false; clear(record); running--; pump(); }
  }
  function pump() { while (!closed && running < 2 && queue.length) { const record = queue.shift(); if (!record || terminal(record)) continue; running++; void execute(record); } }
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<ManifestApplyResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED'); const parsed = manifestApplyRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const request = parsed.data;
      if (request.kind === 'outcomes') {
        const values = [...records.values()].map(record => record.outcome).reverse(), offset = request.after ? values.findIndex(value => value.id === request.after) + 1 : 0;
        if (request.after && !offset) throw new BoundaryError('STALE_TARGET'); const outcomes = values.slice(offset, offset + 8); return manifestApplyResponseSchema.parse({ protocol: 2, kind: 'outcomes', generation: options.generation, outcomes, next: offset + outcomes.length < values.length ? outcomes.at(-1)?.id ?? null : null });
      }
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (request.kind === 'begin') {
        const binding = digest(JSON.stringify([request.target, request.selection, request.reference, request.source, request.bytes])), old = [...records.values()].find(record => record.outcome.requestId === request.requestId);
        if (old) { if (old.binding !== binding) throw new BoundaryError('CONFLICT'); return terminal(old) || old.active || old.outcome.phase === 'queued' ? { protocol: 2, kind: 'outcome', outcome: old.outcome } : { protocol: 2, kind: old.outcome.phase === 'prepared' ? 'confirmation' : 'upload', grant: old.grant, outcome: old.outcome }; }
        blocked(request.target); if (pending.has(request.requestId) || preparing >= 2 || records.size + preparing >= 64 || [...records.values()].filter(record => record.payload || record.patch).length + preparing >= 4) throw new BoundaryError('QUERY_LIMIT');
        preparing++; pending.add(request.requestId); const now = Date.now(), expiresAt = now + 60_000;
        try {
          const target = bindResourceTarget(request.target, await options.config.read(request.selection, signal), options.generation);
          await options.adapter.check({ target, selection: request.selection }, signal);
          blocked(target); // Another original request may have become unknown while admission awaited configuration.
          if (closed || signal.aborted || Date.now() >= expiresAt) throw new BoundaryError('QUERY_CANCELLED');
          const id = randomUUID(), capability = randomBytes(32).toString('hex'), grant = freeze({ id, generation: options.generation, capability, expiresAt });
          const outcome: ApplyOutcome = freeze({ id, generation: options.generation, requestId: request.requestId, target, reference: request.reference, source: request.source, bytes: request.bytes, received: 0, createdAt: now, updatedAt: now, expiresAt, phase: 'uploading' });
          const record: Record = { binding, grant, proof: Buffer.from(digest(capability), 'hex'), selection: freeze(request.selection), controller: new AbortController(), outcome, payload: Buffer.alloc(request.bytes), active: false, stop: false };
          record.timer = setTimeout(() => { if (terminal(record)) return; if (!record.active) update(record, 'failed', 'CONFIRMATION_EXPIRED'); else if (record.outcome.phase !== 'dispatching') record.controller.abort(); }, Math.max(1, expiresAt - Date.now())); records.set(id, record);
          return { protocol: 2, kind: 'upload', grant, outcome };
        } finally { preparing--; pending.delete(request.requestId); }
      }
      const record = records.get(request.grant.id);
      if (!record || request.grant.generation !== options.generation || request.grant.expiresAt !== record.grant.expiresAt || !timingSafeEqual(record.proof, Buffer.from(digest(request.grant.capability), 'hex'))) throw new BoundaryError('FORBIDDEN');
      if (request.kind === 'status') return { protocol: 2, kind: 'outcome', outcome: record.outcome };
      if (request.kind === 'cancel') { cancel(record); return { protocol: 2, kind: 'outcome', outcome: record.outcome }; }
      if (terminal(record) || record.active || record.outcome.phase === 'queued') return { protocol: 2, kind: 'outcome', outcome: record.outcome }; current(record);
      if (request.kind === 'upload') {
        if (record.outcome.phase !== 'uploading' || !record.payload) throw new BoundaryError('CONFLICT'); const bytes = Buffer.from(request.data, 'base64');
        try {
          const expected = Math.min(manifestApplyChunkBytes, record.outcome.bytes - request.offset);
          if (bytes.toString('base64') !== request.data || expected < 1 || bytes.length !== expected || request.offset % manifestApplyChunkBytes !== 0 || request.offset > record.outcome.received) throw new BoundaryError('CONTENT_INVALID');
          if (request.offset < record.outcome.received) { if (request.offset + bytes.length > record.outcome.received || !timingSafeEqual(record.payload.subarray(request.offset, request.offset + bytes.length), bytes)) throw new BoundaryError('CONFLICT'); }
          else { bytes.copy(record.payload, request.offset); record.outcome = freeze({ ...record.outcome, received: request.offset + bytes.length, updatedAt: Date.now() }); }
          return { protocol: 2, kind: 'upload', grant: record.grant, outcome: record.outcome };
        } finally { bytes.fill(0); }
      }
      if (request.kind === 'finish') {
        if (record.outcome.phase === 'prepared') return { protocol: 2, kind: 'confirmation', grant: record.grant, outcome: record.outcome };
        if (!record.payload || record.outcome.phase !== 'uploading' || record.outcome.received !== record.outcome.bytes || preparing >= 2) throw new BoundaryError('CONFLICT'); record.active = true; preparing++; update(record, 'preparing');
        try {
          if (digest(record.payload) !== record.outcome.source.identity) throw new BoundaryError('CONTENT_INVALID');
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(record.payload);
          let body: string, baseline: 'annotation' | 'absent', unchanged: boolean, missing = false, live: string | undefined;
          try {
            live = await proof(record, signal, 'live');
            const prepared = prepareManifestApplyPatch(text, record.outcome.source.format, live, record.outcome.reference);
            body = prepared.body; baseline = prepared.baseline; unchanged = prepared.unchanged;
          } catch (error) {
            // The only admitted fallback is a fresh 404: an explicit user-confirmed Create branch of the same intent.
            if (!(error instanceof BoundaryError) || error.code !== 'NOT_FOUND') throw error;
            current(record);
            await proof(record, signal, 'missing');
            body = prepareManifestApplyCreate(text, record.outcome.source.format, record.outcome.reference); baseline = 'absent'; unchanged = false; missing = true;
          }
          current(record);
          record.patch = Buffer.from(body); delete record.liveDigest;
          if (!missing && live !== undefined) record.liveDigest = digest(live);
          record.payload.fill(0); delete record.payload;
          record.outcome = freeze({ ...record.outcome, patchDigest: digest(record.patch), patchBytes: record.patch.length, unchanged, baseline, missing }); update(record, 'prepared');
        } catch (error) { update(record, record.stop ? 'cancelled' : 'failed', error instanceof BoundaryError ? error.code : 'CONTENT_INVALID'); }
        finally { record.active = false; preparing--; if (terminal(record)) clear(record); }
        return manifestApplyResponseSchema.parse({ protocol: 2, kind: record.outcome.phase === 'prepared' ? 'confirmation' : 'outcome', ...(record.outcome.phase === 'prepared' ? { grant: record.grant } : {}), outcome: record.outcome });
      }
      if (record.outcome.phase !== 'prepared' || !record.patch || request.patchDigest !== record.outcome.patchDigest
        || request.confirmation !== (record.outcome.missing ? 'create-missing-crd-object' : 'apply-exact-crd-version') || queue.length >= 16) throw new BoundaryError('CONFLICT');
      blocked(record.outcome.target, record); update(record, 'queued'); queue.push(record); pump(); return { protocol: 2, kind: 'outcome', outcome: record.outcome };
    },
    counts(): { [phase: string]: number } {
      // Stop-gate aggregate: phase counts only, never record content/targets.
      const phases: { [phase: string]: number } = {};
      for (const record of records.values()) phases[record.outcome.phase] = (phases[record.outcome.phase] ?? 0) + 1;
      return phases;
    },
    close() { closed = true; for (const record of records.values()) cancel(record); queue.length = 0; },
  };
}
