// WRITE client: even begin/upload/status/cancel are static-review-only, never automatic functional tests.
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { fileSaveRequestSchema, fileSaveResponseSchema, fileSaveTargetSchema, sameFileSave } from '../shared/file-save-protocol.ts';
import type { FileSaveSource, FileSaveOutcome, FileSaveGrant, FileSaveRequest, FileSaveResponse } from '../shared/file-save-protocol.ts';
import { saveContentSnapshot, saveContentChunk } from '../shared/save-content.ts';
import { utf8ByteLength } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';
export type SaveSnapshot = { readonly source: FileSaveSource; readonly text: string; readonly owner: object };
export type FileSaveState = { readonly phase: 'idle' | 'preparing' | 'confirm' | 'submitting' | 'result' | 'unconfirmed' | 'error'; readonly outcome?: FileSaveOutcome; readonly history: readonly FileSaveOutcome[]; readonly submitted?: boolean; readonly queryable?: readonly string[]; readonly next?: string | null; readonly error?: ErrorCode };
type Pending = { readonly grant: FileSaveGrant; outcome: FileSaveOutcome; readonly owner: object; readonly epoch: number; readonly source: FileSaveSource['kind']; submitted: boolean; acknowledged: boolean };
type Acknowledge = (kind: 'live' | 'file', outcome: FileSaveOutcome, text: string, revision: number) => boolean;
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
const terminal = (value: FileSaveOutcome) => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(value.phase);
function uuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = ((bytes[6] ?? 0) & 15) | 64; bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class FileSaveClient {
  readonly #request: TreeTransport; readonly #show: (state: FileSaveState) => void; readonly #snapshot: (kind: 'live' | 'file') => SaveSnapshot | undefined;
  readonly #ack: (kind: 'live' | 'file', outcome: FileSaveOutcome, text: string, revision: number) => boolean;
  readonly #records = new Map<string, Pending>(); readonly #history = new Map<string, FileSaveOutcome>();
  #pending: Pending | undefined; #epoch = 0; #revision = 0; #calls = 0; #busy = false; #disposed = false; #next: string | null = null;
  constructor(request: TreeTransport, snapshot: (kind: 'live' | 'file') => SaveSnapshot | undefined, ack: Acknowledge, show: (state: FileSaveState) => void) {
    this.#request = request; this.#snapshot = snapshot; this.#ack = ack; this.#show = show;
  }
  #paint(phase: FileSaveState['phase'], error?: ErrorCode) { if (!this.#disposed) this.#show({ phase, history: [...this.#history.values()].reverse(), queryable: [...this.#records.keys()], next: this.#next, ...(this.#pending ? { outcome: this.#pending.outcome, submitted: this.#pending.submitted } : {}), ...(error ? { error } : {}) }); }
  #resultPhase(): FileSaveState['phase'] {
    const record = this.#pending;
    return record && !record.submitted && record.outcome.phase === 'prepared' && Date.now() < record.grant.expiresAt && this.#matches(record) ? 'confirm' : 'result';
  }
  async #post(input: FileSaveRequest): Promise<FileSaveResponse> {
    if (this.#disposed) throw new BoundaryError('SERVICE_CLOSED'); if (this.#calls >= 2) throw new BoundaryError('QUERY_LIMIT');
    const body = JSON.stringify(fileSaveRequestSchema.parse(input)); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED'); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/operations/file-save', body });
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body); } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = fileSaveResponseSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); return parsed.data;
    } finally { this.#calls--; }
  }
  #matches(record: Pending): SaveSnapshot | undefined {
    if (record.epoch !== this.#epoch) return undefined;
    const snapshot = this.#snapshot(record.source);
    if (!snapshot || snapshot.owner !== record.owner || snapshot.source.kind !== record.outcome.source.kind || snapshot.source.identity !== record.outcome.source.identity || snapshot.source.revision !== record.outcome.source.revision) return undefined;
    const content = saveContentSnapshot(snapshot.text);
    try { return content.digest === record.outcome.digest && content.bytes.length === record.outcome.bytes ? snapshot : undefined; } finally { content.bytes.fill(0); }
  }
  #accept(record: Pending, response: FileSaveResponse) {
    if (response.kind === 'outcomes' || !sameFileSave(record.outcome, response.outcome)) throw new BoundaryError('STALE_TARGET');
    if ('grant' in response && JSON.stringify(response.grant) !== JSON.stringify(record.grant)) throw new BoundaryError('STALE_TARGET');
    if (response.outcome.received < record.outcome.received || terminal(record.outcome) && JSON.stringify(response.outcome) !== JSON.stringify(record.outcome)) throw new BoundaryError('STALE_TARGET');
    record.outcome = response.outcome; this.#history.set(record.outcome.id, record.outcome);
    if (record.outcome.phase === 'succeeded' && !record.acknowledged) {
      const snapshot = this.#matches(record);
      if (snapshot) record.acknowledged = this.#ack(record.source, record.outcome, snapshot.text, snapshot.source.revision);
    }
  }
  async prepare(kind: 'live' | 'file', root: string, path: string): Promise<void> {
    if (this.#disposed || this.#busy) return;
    if (this.#pending && !terminal(this.#pending.outcome)) { this.#paint('error', 'CONFLICT'); return; }
    let bytes: Uint8Array | undefined; const revision = ++this.#revision; this.#busy = true; this.#pending = undefined; this.#paint('preparing');
    try {
      if (this.#records.size >= 64) throw new BoundaryError('QUERY_LIMIT');
      const target = fileSaveTargetSchema.parse({ root, path }), snapshot = this.#snapshot(kind); if (!snapshot) throw new BoundaryError('STALE_TARGET');
      const encoded = saveContentSnapshot(snapshot.text); bytes = encoded.bytes;
      const response = await this.#post({ protocol: 2, kind: 'begin', requestId: uuid(), target, source: snapshot.source, bytes: bytes.length, digest: encoded.digest });
      if (response.kind !== 'upload' || response.outcome.target.root !== root || response.outcome.target.path !== path || response.outcome.source.kind !== kind
        || response.outcome.source.identity !== snapshot.source.identity || response.outcome.source.revision !== snapshot.source.revision || response.outcome.bytes !== bytes.length || response.outcome.digest !== encoded.digest
        || response.grant.id !== response.outcome.id || response.grant.generation !== response.outcome.generation || response.grant.expiresAt !== response.outcome.expiresAt || response.outcome.phase !== 'uploading' || response.outcome.received !== 0) throw new BoundaryError('STALE_TARGET');
      const record: Pending = { grant: response.grant, outcome: response.outcome, owner: snapshot.owner, epoch: this.#epoch, source: kind, submitted: false, acknowledged: false };
      this.#records.set(record.grant.id, record); this.#history.set(record.grant.id, record.outcome);
      if (revision !== this.#revision || this.#disposed || !this.#matches(record)) { await this.#cancelRecord(record); return; }
      this.#pending = record;
      for (let offset = 0; offset < bytes.length;) {
        if (revision !== this.#revision || !this.#matches(record)) { await this.#cancelRecord(record); return; }
        const chunk = saveContentChunk(bytes, offset);
        this.#accept(record, await this.#post({ protocol: 2, kind: 'upload', grant: record.grant, offset, data: chunk.data }));
        if (record.outcome.received !== chunk.end || record.outcome.phase !== 'uploading') throw new BoundaryError('CONFLICT'); offset = chunk.end;
      }
      if (revision !== this.#revision || !this.#matches(record)) { await this.#cancelRecord(record); return; }
      const finished = await this.#post({ protocol: 2, kind: 'finish', grant: record.grant }); this.#accept(record, finished);
      if (revision !== this.#revision || !this.#matches(record)) { await this.#cancelRecord(record); return; }
      this.#paint(finished.kind === 'confirmation' && record.outcome.phase === 'prepared' ? 'confirm' : 'result');
    } catch (error) { if (!this.#disposed && revision === this.#revision) this.#paint('unconfirmed', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
    finally { bytes?.fill(0); this.#busy = false; }
  }
  async submit(): Promise<void> {
    const record = this.#pending; if (this.#disposed || this.#busy || !record || record.submitted || record.outcome.phase !== 'prepared') return;
    if (!this.#matches(record) || Date.now() >= record.grant.expiresAt) { await this.cancel(); return; }
    this.#busy = true; record.submitted = true; this.#paint('submitting');
    try { this.#accept(record, await this.#post({ protocol: 2, kind: 'submit', grant: record.grant, confirmation: 'save-exact-snapshot' })); this.#paint('result'); }
    catch { this.#paint('unconfirmed', 'OPERATION_UNKNOWN'); } // Never replay submit, even after a lost response.
    finally { this.#busy = false; }
  }
  async #cancelRecord(record: Pending) {
    if (record.submitted || terminal(record.outcome) || this.#disposed) return;
    try { this.#accept(record, await this.#post({ protocol: 2, kind: 'cancel', grant: record.grant })); }
    catch { /* Fixed service expiry, no automatic write retry or filesystem cleanup. */ }
    if (this.#pending === record) this.#paint(terminal(record.outcome) ? 'result' : 'unconfirmed');
  }
  async cancel(): Promise<void> { ++this.#revision; const record = this.#pending; if (!record || record.submitted) return; await this.#cancelRecord(record); }
  async status(id?: string): Promise<void> {
    const record = id ? this.#records.get(id) : this.#pending; if (this.#disposed || this.#busy || !record) return; this.#busy = true;
    try { this.#accept(record, await this.#post({ protocol: 2, kind: 'status', grant: record.grant })); this.#paint(this.#resultPhase()); }
    catch { this.#paint('unconfirmed', 'OPERATION_UNKNOWN'); } finally { this.#busy = false; }
  }
  async outcomes(next = false): Promise<void> {
    if (this.#disposed || this.#busy) return; this.#busy = true;
    try {
      const after = next ? this.#next : undefined; if (next && !after) return;
      const response = await this.#post({ protocol: 2, kind: 'outcomes', ...(after ? { after } : {}) }); if (response.kind !== 'outcomes') throw new BoundaryError('STATE_UNAVAILABLE');
      if (response.next && (response.next === after || response.next !== response.outcomes.at(-1)?.id)) throw new BoundaryError('STALE_TARGET'); this.#next = response.next;
      for (const value of response.outcomes) { const known = this.#records.get(value.id); if (known) this.#accept(known, { protocol: 2, kind: 'outcome', outcome: value }); else if (this.#history.size < 64) this.#history.set(value.id, value); } this.#paint(this.#resultPhase());
    } catch { this.#paint('unconfirmed', 'OPERATION_UNKNOWN'); } finally { this.#busy = false; }
  }
  changed() { const record = this.#pending; if (record && !record.submitted && !terminal(record.outcome) && !this.#matches(record)) void this.cancel(); }
  reset() { ++this.#epoch; ++this.#revision; const record = this.#pending; this.#pending = undefined; this.#next = null; if (record && !record.submitted) void this.#cancelRecord(record); this.#paint('idle'); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
