// WRITE client, including prepare/begin/upload/finish/status/cancel: static review only, never automatic functional tests.
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { createSourceSchema, manifestCreateRequestSchema, manifestCreateResponseSchema, sameCreateIntent } from '../shared/manifest-create-protocol.ts';
import type { CreateGrant, CreateOutcome, ManifestCreateResponse } from '../shared/manifest-create-protocol.ts';
import { saveContentChunk, saveContentSnapshot } from '../shared/save-content.ts';
import { encodeCreateSource } from './manifest-create-source.ts';
import { readCreatePayload } from '../shared/manifest-create-payload.ts';
import type { ManifestLocator } from '../shared/manifest-diff-protocol.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import type { TargetIdentity } from '../shared/identity.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import type { TreeTransport } from './tree-source.ts';
import type { ManifestFile } from '../shared/manifest-file-protocol.ts';
export type CreateSourceInput = { readonly kind: 'scratch' | 'live' | 'selection' | 'file' | 'file-command'; readonly revision: number; readonly file?: ManifestFile; readonly fileProof?: string };
export type CreateCapturedInput = { readonly text: string; readonly source: CreateSourceInput; readonly selection?: { start: number; end: number } };
export type CreateContext = { readonly target: TargetIdentity; readonly selection: ConfigSelection };
export type ManifestCreateState = { readonly phase: 'idle' | 'preparing' | 'confirm' | 'submitting' | 'result' | 'unconfirmed' | 'error'; readonly outcome?: CreateOutcome;
  readonly submitted?: boolean; readonly history: readonly CreateOutcome[]; readonly queryable: readonly string[]; readonly next: string | null; readonly error?: ErrorCode };
type Pending = { readonly grant: CreateGrant; outcome: CreateOutcome; readonly context: CreateContext; readonly epoch: number; readonly expected: readonly ManifestLocator[]; submitted: boolean; plan?: string };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
const terminal = (value: CreateOutcome) => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(value.phase);
function uuid() { const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = ((bytes[6] ?? 0) & 15) | 64; bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }
export class ManifestCreateClient {
  readonly #request: TreeTransport; readonly #context: () => CreateContext | undefined; readonly #show: (state: ManifestCreateState) => void;
  readonly #records = new Map<string, Pending>(); readonly #history = new Map<string, CreateOutcome>();
  #pending: Pending | undefined; #epoch = 0; #calls = 0; #busy = false; #disposed = false; #next: string | null = null; #independentFile = false;
  constructor(request: TreeTransport, context: () => CreateContext | undefined, show: (state: ManifestCreateState) => void) { this.#request = request; this.#context = context; this.#show = show; }
  #paint(phase: ManifestCreateState['phase'], error?: ErrorCode) { if (!this.#disposed) this.#show({ phase, history: [...this.#history.values()].reverse(), queryable: [...this.#records.keys()], next: this.#next,
    ...(this.#pending ? { outcome: this.#pending.outcome, submitted: this.#pending.submitted } : {}), ...(error ? { error } : {}) }); }
  #matches(record: Pending) { const context = this.#context(); return record.epoch === this.#epoch && !!context && sameTarget(context.target, record.context.target) && JSON.stringify(context.selection) === JSON.stringify(record.context.selection); }
  #phase(): ManifestCreateState['phase'] { const value = this.#pending; return value && !value.submitted && value.outcome.phase === 'prepared' && this.#matches(value) && Date.now() < value.grant.expiresAt ? 'confirm' : 'result'; }
  async #post(input: unknown): Promise<ManifestCreateResponse> {
    if (this.#disposed) throw new BoundaryError('SERVICE_CLOSED'); if (this.#calls >= 2) throw new BoundaryError('QUERY_LIMIT');
    const body = JSON.stringify(manifestCreateRequestSchema.parse(input)); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED'); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/operations/manifest-create', body }); if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body); } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = manifestCreateResponseSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); return parsed.data;
    } finally { this.#calls--; }
  }
  #accept(record: Pending, response: ManifestCreateResponse) {
    if (response.kind === 'outcomes' || !sameCreateIntent(record.outcome, response.outcome) || response.outcome.received < record.outcome.received) throw new BoundaryError('STALE_TARGET');
    if ('grant' in response && JSON.stringify(record.grant) !== JSON.stringify(response.grant)) throw new BoundaryError('STALE_TARGET');
    if (terminal(record.outcome) && JSON.stringify(record.outcome) !== JSON.stringify(response.outcome)) throw new BoundaryError('STALE_TARGET');
    if (response.outcome.steps.some((item, index) => item.index !== index)) throw new BoundaryError('STALE_TARGET');
    if (response.outcome.steps.length && (response.outcome.steps.length !== record.expected.length || response.outcome.steps.some((item, index) => JSON.stringify(item.locator) !== JSON.stringify(record.expected[index])))) throw new BoundaryError('STALE_TARGET');
    const plan = JSON.stringify(response.outcome.steps.map(item => [item.index, item.locator, item.reference]));
    if (record.plan && plan !== record.plan) throw new BoundaryError('STALE_TARGET');
    if (response.outcome.phase === 'prepared') {
      if (response.outcome.steps.length !== record.expected.length || response.outcome.steps.some(item => {
        const ref = item.reference, locator = item.locator;
        return !ref || item.phase !== 'pending' || ref.type.group !== locator.group || ref.type.version !== locator.version || ref.type.kind !== locator.kind || ref.name !== locator.name
          || (ref.type.scope === 'namespace' ? ref.namespace !== (locator.namespace ?? record.context.target.namespace) : locator.namespace !== undefined || ref.namespace !== undefined);
      })) throw new BoundaryError('STALE_TARGET'); record.plan = plan;
    }
    record.outcome = response.outcome; this.#history.set(record.outcome.id, record.outcome);
  }
  async prepare(text: string, format: 'yaml' | 'json', source: CreateSourceInput, selection?: { start: number; end: number }): Promise<void> {
    return this.prepareCaptured(async () => ({ text, source, ...(selection ? { selection } : {}) }), format);
  }
  async prepareCaptured(capture: () => Promise<CreateCapturedInput>, format: 'yaml' | 'json', independentFile = false): Promise<void> {
    if (this.#disposed || this.#busy) return; if (this.#pending && !terminal(this.#pending.outcome)) { this.#paint('error', 'CONFLICT'); return; }
    this.#busy = true; this.#independentFile = independentFile; const epoch = ++this.#epoch; this.#pending = undefined; this.#paint('preparing'); let bytes: Uint8Array | undefined;
    try {
      const context = this.#context(); if (!context) throw new BoundaryError('STALE_TARGET'); if (this.#records.size >= 64) throw new BoundaryError('QUERY_LIMIT');
      const { text, source, selection } = await capture(), afterCapture = this.#context();
      if (this.#disposed || epoch !== this.#epoch || !afterCapture || !sameTarget(context.target, afterCapture.target) || JSON.stringify(context.selection) !== JSON.stringify(afterCapture.selection)) throw new BoundaryError('STALE_TARGET');
      if (source.file && (selection || source.file.format !== format)) throw new BoundaryError('INVALID_INPUT');
      const origin = saveContentSnapshot(text); const identity = origin.digest; origin.bytes.fill(0);
      const payload = encodeCreateSource(text, format, selection), expected = readCreatePayload(payload).map(item => item.locator);
      const encoded = saveContentSnapshot(payload); bytes = encoded.bytes;
      const { fileProof, ...metadata } = source, requestId = uuid(), summary = createSourceSchema.parse({ ...metadata, identity });
      const response = await this.#post({ protocol: 2, kind: 'begin', requestId, ...context, source: summary, bytes: bytes.length, digest: encoded.digest, ...(fileProof ? { fileProof } : {}) });
      if (response.kind !== 'upload' || response.outcome.requestId !== requestId || !sameTarget(response.outcome.target, context.target) || response.outcome.source.kind !== summary.kind || response.outcome.source.identity !== summary.identity || response.outcome.source.revision !== summary.revision
        || JSON.stringify(response.outcome.source.file) !== JSON.stringify(summary.file) || response.outcome.bytes !== bytes.length || response.outcome.digest !== encoded.digest
        || response.outcome.received !== (summary.file ? bytes.length : 0) || response.outcome.phase !== 'uploading' || response.outcome.steps.length
        || response.grant.id !== response.outcome.id || response.grant.generation !== response.outcome.generation || response.grant.generation !== context.target.serviceGeneration || response.grant.expiresAt !== response.outcome.expiresAt) throw new BoundaryError('STALE_TARGET');
      const record: Pending = { grant: response.grant, outcome: response.outcome, context, expected, epoch, submitted: false }; this.#records.set(record.grant.id, record); this.#history.set(record.grant.id, record.outcome);
      if (this.#disposed || !this.#matches(record)) { await this.#cancelRecord(record); return; } this.#pending = record;
      for (let offset = response.outcome.received; offset < bytes.length;) {
        if (!this.#matches(record)) { await this.#cancelRecord(record); return; } const chunk = saveContentChunk(bytes, offset);
        this.#accept(record, await this.#post({ protocol: 2, kind: 'upload', grant: record.grant, offset, data: chunk.data }));
        if (record.outcome.received !== chunk.end || record.outcome.phase !== 'uploading') throw new BoundaryError('CONFLICT'); offset = chunk.end;
      }
      if (!this.#matches(record)) { await this.#cancelRecord(record); return; }
      this.#accept(record, await this.#post({ protocol: 2, kind: 'finish', grant: record.grant }));
      if (!this.#matches(record)) { await this.#cancelRecord(record); return; } this.#paint(this.#phase());
    } catch (error) { if (epoch === this.#epoch && !this.#disposed) this.#paint('unconfirmed', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
    finally { bytes?.fill(0); this.#busy = false; }
  }
  async submit(): Promise<void> {
    const record = this.#pending; if (this.#disposed || this.#busy || !record || record.submitted || record.outcome.phase !== 'prepared') return;
    if (!this.#matches(record) || Date.now() >= record.grant.expiresAt || !record.plan) { await this.cancel(); return; }
    this.#busy = true; record.submitted = true; this.#paint('submitting');
    try { this.#accept(record, await this.#post({ protocol: 2, kind: 'submit', grant: record.grant, confirmation: 'create-exact-documents' })); this.#paint('result'); }
    catch { this.#paint('unconfirmed', 'OPERATION_UNKNOWN'); } finally { this.#busy = false; } // No submit replay after any attempted send.
  }
  async #cancelRecord(record: Pending) { if (record.submitted || terminal(record.outcome) || this.#disposed) return;
    try { this.#accept(record, await this.#post({ protocol: 2, kind: 'cancel', grant: record.grant })); } catch { /* Original fixed expiry; no retries, rollback or cleanup. */ }
    if (record === this.#pending) this.#paint(terminal(record.outcome) ? 'result' : 'unconfirmed'); }
  async cancel(): Promise<void> { ++this.#epoch; const record = this.#pending; if (record && !record.submitted) await this.#cancelRecord(record); }
  async status(id?: string): Promise<void> {
    const record = id ? this.#records.get(id) : this.#pending; if (this.#disposed || this.#busy || !record) return; this.#busy = true;
    try { this.#accept(record, await this.#post({ protocol: 2, kind: 'status', grant: record.grant })); this.#paint(this.#phase()); } catch { this.#paint('unconfirmed', 'OPERATION_UNKNOWN'); } finally { this.#busy = false; }
  }
  async outcomes(next = false): Promise<void> {
    if (this.#disposed || this.#busy) return; this.#busy = true;
    try {
      const after = next ? this.#next : undefined; if (next && !after) return;
      const response = await this.#post({ protocol: 2, kind: 'outcomes', ...(after ? { after } : {}) }); if (response.kind !== 'outcomes' || response.generation !== this.#context()?.target.serviceGeneration) throw new BoundaryError('STALE_TARGET');
      if (response.next && (response.next === after || response.next !== response.outcomes.at(-1)?.id)) throw new BoundaryError('STALE_TARGET'); this.#next = response.next;
      for (const value of response.outcomes) { const known = this.#records.get(value.id); if (known) this.#accept(known, { protocol: 2, kind: 'outcome', outcome: value }); else if (this.#history.size < 64) this.#history.set(value.id, value); } this.#paint(this.#phase());
    } catch { this.#paint('unconfirmed', 'OPERATION_UNKNOWN'); } finally { this.#busy = false; }
  }
  changed() { ++this.#epoch; const record = this.#pending; if (record && !record.submitted && !terminal(record.outcome)) void this.#cancelRecord(record); }
  sourceChanged() { if (!this.#independentFile) this.changed(); }
  reset() { this.changed(); this.#pending = undefined; this.#next = null; this.#paint('idle'); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
