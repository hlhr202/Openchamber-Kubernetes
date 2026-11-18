// WRITE operation chain, including begin/upload/finish/status/cancel. Static review only, never automatic functional execution.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { fileSaveRequestSchema, fileSaveResponseSchema, fileSaveChunkBytes, fileSaveLocation, savedFileReceiptSchema, fileSaveTargetSchema, saveDigestSchema } from '../../shared/file-save-protocol.ts';
import type { FileSaveSource, FileSaveGrant, FileSaveOutcome, FileSaveResponse } from '../../shared/file-save-protocol.ts';
import type { SaveFilePlan, createWorkspaceFileWriter } from '../adapters/workspace-file-write.ts';
import type { createWorkspaceReader } from '../queries/workspace-reader.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Record = { readonly requestId: string; readonly binding: string; readonly plan: SaveFilePlan; readonly grant: FileSaveGrant; readonly proof: Buffer;
  readonly controller: AbortController; source?: FileSaveSource; payload?: Buffer; outcome: FileSaveOutcome; active: boolean; timer?: ReturnType<typeof setTimeout> };
export function createFileSaveOperations(options: { generation: string; files: ReturnType<typeof createWorkspaceFileWriter>; workspace: Pick<ReturnType<typeof createWorkspaceReader>, 'read'>; lock: ConfigurationWriteLock }) {
  const records = new Map<string, Record>(), pending = new Set<string>(); let preparing = 0, closed = false;
  const terminal = (record: Record) => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(record.outcome.phase);
  function clear(record: Record) { record.payload?.fill(0); delete record.payload; delete record.source; if (record.timer) clearTimeout(record.timer); delete record.timer; }
  function update(record: Record, phase: FileSaveOutcome['phase'], code?: ErrorCode) {
    record.outcome = Object.freeze({ ...record.outcome, phase, updatedAt: Date.now(), ...(code ? { code } : {}) });
    if (terminal(record) && !record.active) clear(record);
  }
  function current(record: Record) {
    if (closed || record.controller.signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
    if (Date.now() >= record.grant.expiresAt) throw new BoundaryError('CONFIRMATION_EXPIRED');
  }
  function owned(grant: FileSaveGrant) {
    const record = records.get(grant.id);
    if (!record || grant.generation !== options.generation || grant.expiresAt !== record.grant.expiresAt
      || !timingSafeEqual(record.proof, Buffer.from(digest(grant.capability), 'hex'))) throw new BoundaryError('FORBIDDEN');
    return record;
  }
  function cancel(record: Record) {
    if (terminal(record) || record.outcome.phase === 'committing') return; // Submitted publication cannot be revoked.
    if (record.active) { update(record, 'cancelling', 'QUERY_CANCELLED'); record.controller.abort(); }
    else { update(record, 'cancelled', 'QUERY_CANCELLED'); record.controller.abort(); }
  }
  async function sourceProof(source: FileSaveSource, target: { root: string; path: string }, signal: AbortSignal): Promise<string | undefined> {
    const file = source.file;
    if (file?.detached && fileSaveLocation(file) === fileSaveLocation(target)) throw new BoundaryError('CONFLICT'); // Explicit detached draft may Save As elsewhere, never adopt a conflicting original version.
    const previous = source.previousFile;
    if (previous && fileSaveLocation(previous) === fileSaveLocation(target)) {
      const record = records.get(previous.id), value = record?.outcome;
      if (previous.generation !== options.generation || !value || value.phase !== 'succeeded' || value.versionAfter !== previous.version
        || value.target.root !== previous.root || value.target.path !== previous.path || value.source.kind !== source.kind || value.source.identity !== source.identity) throw new BoundaryError('CONFLICT');
      return previous.version; // Only original succeeded ledger, not a panel-created version receipt.
    }
    if (file && fileSaveLocation(file) === fileSaveLocation(target)) {
      const page = await options.workspace.read({ protocol: 2, scope: file.scope, path: file.path }, signal);
      if (page.root !== file.root || page.path !== file.path || page.version !== file.version || page.identity !== source.identity) throw new BoundaryError('CONFLICT');
    }
    return undefined;
  }
  async function verifySource(record: Record) {
    current(record); if (!record.source) throw new BoundaryError('STATE_UNAVAILABLE');
    const expected = await sourceProof(record.source, record.outcome.target, record.controller.signal);
    if (expected && record.plan.version !== expected) throw new BoundaryError('CONFLICT'); current(record);
  }
  async function execute(record: Record) {
    record.active = true;
    try {
      await options.lock.run(record.controller.signal, async () => {
        current(record); update(record, 'checking'); await verifySource(record); await options.files.verify(record.plan, record.controller.signal); await verifySource(record);
        const payload = record.payload; if (!payload) throw new BoundaryError('STATE_UNAVAILABLE');
        const result = await options.files.commit(record.outcome.id, record.plan, payload, record.outcome.digest, record.controller.signal, () => verifySource(record),
          () => { current(record); record.outcome = Object.freeze({ ...record.outcome, phase: 'staging', cleanup: 'pending', stagingName: `.oc-k8s-save-${record.outcome.id}.tmp`, updatedAt: Date.now() }); },
          () => { current(record); update(record, 'committing'); if (record.timer) clearTimeout(record.timer); delete record.timer; });
        record.outcome = Object.freeze({ ...record.outcome, phase: result.phase === 'failed' && record.controller.signal.aborted ? 'cancelled' : result.phase,
          cleanup: result.cleanup, updatedAt: Date.now(), ...(result.code ? { code: result.code } : {}), ...(result.result ? { result: result.result } : {}), ...(result.versionAfter ? { versionAfter: result.versionAfter } : {}) });
      });
    } catch (error) {
      if (!terminal(record)) update(record, record.outcome.phase === 'committing' ? 'unknown' : record.controller.signal.aborted ? 'cancelled' : 'failed',
        record.outcome.phase === 'committing' ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE');
    } finally { record.active = false; clear(record); }
  }
  return {
    // Internal file-consumption guard, not a public read endpoint. Static-only like the containing write controller.
    async verifyConsumption(input: { root: string; path: string; identity: string; digest: string; receipt?: unknown }, signal: AbortSignal): Promise<void> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED'); if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (!fileSaveTargetSchema.safeParse({ root: input.root, path: input.path }).success || !saveDigestSchema.safeParse(input.identity).success || !saveDigestSchema.safeParse(input.digest).success) throw new BoundaryError('INVALID_INPUT');
      for (const record of records.values()) if (fileSaveLocation(record.outcome.target) === fileSaveLocation(input)) {
        if (record.outcome.phase === 'unknown' || record.outcome.cleanup === 'manual-check') throw new BoundaryError('OPERATION_UNKNOWN');
        if (record.active || !terminal(record)) throw new BoundaryError('CONFLICT');
      }
      if (!input.receipt) return;
      const parsed = savedFileReceiptSchema.safeParse(input.receipt); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const receipt = parsed.data;
      const record = records.get(receipt.id), outcome = record?.outcome;
      if (receipt.generation !== options.generation || !outcome || outcome.phase !== 'succeeded' || outcome.cleanup !== 'none' || outcome.versionAfter !== receipt.version
        || receipt.root !== input.root || receipt.path !== input.path || outcome.target.root !== receipt.root || outcome.target.path !== receipt.path
        || outcome.source.kind !== 'file' || outcome.source.identity !== input.identity || outcome.digest !== input.digest) throw new BoundaryError('CONFLICT');
      const actual = await options.files.inspect(receipt.root, receipt.path, signal);
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (actual.version !== receipt.version || actual.digest !== input.digest) throw new BoundaryError('CONFLICT');
    },
    async handle(input: unknown, signal: AbortSignal): Promise<FileSaveResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = fileSaveRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const request = parsed.data;
      for (const record of records.values()) if (!record.active && !terminal(record) && Date.now() >= record.grant.expiresAt) update(record, 'failed', 'CONFIRMATION_EXPIRED');
      // No eviction of unknown/manual-cleanup or succeeded receipts: bounded ledger fails closed when full.
      if (request.kind === 'outcomes') {
        const values = [...records.values()].map(record => record.outcome).reverse(), offset = request.after ? values.findIndex(value => value.id === request.after) + 1 : 0;
        if (request.after && !offset) throw new BoundaryError('STALE_TARGET'); const outcomes = values.slice(offset, offset + 16);
        return fileSaveResponseSchema.parse({ protocol: 2, kind: 'outcomes', generation: options.generation, outcomes, next: offset + outcomes.length < values.length ? outcomes.at(-1)?.id ?? null : null });
      }
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (request.kind === 'begin') {
        const binding = digest(JSON.stringify([request.target, request.source, request.bytes, request.digest]));
        const previous = [...records.values()].find(record => record.requestId === request.requestId);
        if (previous) {
          if (previous.binding !== binding) throw new BoundaryError('CONFLICT');
          if (terminal(previous) || previous.active) return { protocol: 2, kind: 'outcome', outcome: previous.outcome };
          return { protocol: 2, kind: previous.outcome.phase === 'prepared' ? 'confirmation' : 'upload', grant: previous.grant, outcome: previous.outcome };
        }
        if (pending.has(request.requestId)) throw new BoundaryError('QUERY_LIMIT');
        if ([...records.values()].some(record => fileSaveLocation(record.outcome.target) === fileSaveLocation(request.target)
          && (record.outcome.phase === 'unknown' || record.outcome.cleanup === 'manual-check'))) throw new BoundaryError('OPERATION_UNKNOWN');
        const payloads = [...records.values()].filter(record => record.payload).length;
        if (preparing >= 2 || records.size + preparing >= 64 || payloads + preparing >= 4) throw new BoundaryError('QUERY_LIMIT');
        preparing++; pending.add(request.requestId); const now = Date.now(), expiresAt = now + 60_000, controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000), combined = AbortSignal.any([signal, controller.signal]);
        try {
          const expected = await sourceProof(request.source, request.target, combined);
          const plan = await options.files.inspect(request.target.root, request.target.path, combined);
          if (expected && plan.version !== expected) throw new BoundaryError('CONFLICT');
          const second = await sourceProof(request.source, request.target, combined); if (second !== expected) throw new BoundaryError('CONFLICT');
          if (closed || combined.aborted || Date.now() >= expiresAt) throw new BoundaryError('CONFIRMATION_EXPIRED');
          const id = randomUUID(), capability = randomBytes(32).toString('hex'), grant = Object.freeze({ id, generation: options.generation, capability, expiresAt });
          const outcome = Object.freeze<FileSaveOutcome>({ id, generation: options.generation, target: Object.freeze({ ...request.target }), source: Object.freeze({ kind: request.source.kind, identity: request.source.identity, revision: request.source.revision }),
            bytes: request.bytes, digest: request.digest, received: 0, action: plan.version === null ? 'create' : 'replace', version: plan.version, mode: plan.mode,
            createdAt: now, updatedAt: Date.now(), expiresAt, phase: 'uploading', cleanup: 'none' });
          if (Buffer.byteLength(JSON.stringify(outcome)) > 28_000) throw new BoundaryError('BUDGET_EXCEEDED');
          const record: Record = { requestId: request.requestId, binding, plan, grant, proof: Buffer.from(digest(capability), 'hex'), controller, source: request.source,
            payload: Buffer.alloc(request.bytes), outcome, active: false };
          record.timer = setTimeout(() => { if (!record.active && !terminal(record)) update(record, 'failed', 'CONFIRMATION_EXPIRED'); else if (record.outcome.phase !== 'committing' && !terminal(record)) controller.abort(); }, Math.max(1, expiresAt - Date.now()));
          records.set(id, record); return fileSaveResponseSchema.parse({ protocol: 2, kind: 'upload', grant, outcome });
        } finally { clearTimeout(timeout); pending.delete(request.requestId); preparing--; }
      }
      const record = owned(request.grant);
      if (request.kind === 'status') return { protocol: 2, kind: 'outcome', outcome: record.outcome };
      if (request.kind === 'cancel') { cancel(record); return { protocol: 2, kind: 'outcome', outcome: record.outcome }; }
      if (terminal(record) || record.active || ['queued', 'committing'].includes(record.outcome.phase)) return { protocol: 2, kind: 'outcome', outcome: record.outcome };
      current(record);
      if (request.kind === 'upload') {
        if (record.outcome.phase !== 'uploading' || !record.payload) throw new BoundaryError('CONFLICT');
        const chunk = Buffer.from(request.data, 'base64');
        try {
          const expected = Math.min(fileSaveChunkBytes, record.outcome.bytes - request.offset);
          if (chunk.toString('base64') !== request.data || chunk.length !== expected || expected < 1 || request.offset % fileSaveChunkBytes !== 0 || request.offset > record.outcome.received) throw new BoundaryError('CONTENT_INVALID');
          if (request.offset < record.outcome.received) {
            if (request.offset + chunk.length > record.outcome.received || !timingSafeEqual(record.payload.subarray(request.offset, request.offset + chunk.length), chunk)) throw new BoundaryError('CONFLICT');
          } else { chunk.copy(record.payload, request.offset); record.outcome = Object.freeze({ ...record.outcome, received: request.offset + chunk.length, updatedAt: Date.now() }); }
          return { protocol: 2, kind: 'upload', grant: record.grant, outcome: record.outcome };
        } finally { chunk.fill(0); }
      }
      if (request.kind === 'finish') {
        if (record.outcome.phase === 'prepared') return { protocol: 2, kind: 'confirmation', grant: record.grant, outcome: record.outcome };
        if (record.outcome.phase !== 'uploading' || !record.payload || record.outcome.received !== record.outcome.bytes) throw new BoundaryError('CONFLICT');
        if (digest(record.payload) !== record.outcome.digest) { update(record, 'failed', 'CONTENT_INVALID'); return { protocol: 2, kind: 'outcome', outcome: record.outcome }; }
        try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(record.payload); if (record.payload.includes(0)) throw new Error('NUL'); }
        catch { update(record, 'failed', 'CONTENT_INVALID'); return { protocol: 2, kind: 'outcome', outcome: record.outcome }; }
        // Serialize finish with the record's cancellation/expiry without opening another payload slot.
        record.active = true;
        try { await verifySource(record); await options.files.verify(record.plan, record.controller.signal); await verifySource(record); update(record, 'prepared'); }
        catch (error) { update(record, record.controller.signal.aborted ? 'cancelled' : 'failed', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
        finally { record.active = false; if (terminal(record)) clear(record); }
        return fileSaveResponseSchema.parse({ protocol: 2, kind: terminal(record) ? 'outcome' : 'confirmation', ...(!terminal(record) ? { grant: record.grant } : {}), outcome: record.outcome });
      }
      if (record.outcome.phase !== 'prepared') throw new BoundaryError('CONFLICT');
      update(record, 'queued'); void execute(record); // Only explicit submit enters the writer; disconnect is not rollback/replay.
      return { protocol: 2, kind: 'outcome', outcome: record.outcome };
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
