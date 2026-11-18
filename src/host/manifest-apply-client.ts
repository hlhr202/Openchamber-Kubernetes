// WRITE client. Static review only, including prepare/upload/finish/status/cancel; never automatic functional tests.
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { customDocumentReferenceSchema } from '../shared/document-protocol.ts';
import { manifestApplyRequestSchema, manifestApplyResponseSchema, sameApplyIntent } from '../shared/manifest-apply-protocol.ts';
import type { ApplyOutcome, ApplyGrant, ManifestApplyResponse } from '../shared/manifest-apply-protocol.ts';
import { saveContentSnapshot, saveContentChunk } from '../shared/save-content.ts';
import { utf8ByteLength, sameTarget } from '../shared/identity.ts';
import type { TargetIdentity } from '../shared/identity.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import type { TreeTransport } from './tree-source.ts';
export type ApplySnapshot = { readonly owner: object; readonly text: string; readonly revision: number; readonly format: 'yaml' | 'json'; readonly reference: ReturnType<typeof customDocumentReferenceSchema.parse>; readonly target: TargetIdentity; readonly selection: ConfigSelection };
export type ManifestApplyState = { readonly phase: 'idle' | 'preparing' | 'confirm' | 'submitting' | 'outcome' | 'error'; readonly outcome?: ApplyOutcome; readonly history: readonly ApplyOutcome[]; readonly error?: ErrorCode; readonly next: string | null; readonly canCancel: boolean };
type Record = { readonly grant: ApplyGrant; readonly owner: object; readonly epoch: number; readonly selection: ConfigSelection; outcome: ApplyOutcome; submitted: boolean; plan?: string };
const terminal = (value: ApplyOutcome) => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(value.phase);
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class ManifestApplyClient {
  readonly #transport: TreeTransport; readonly #snapshot: () => ApplySnapshot | undefined; readonly #show: (state: ManifestApplyState) => void;
  #pending: Record | undefined; readonly #records = new Map<string, Record>(); #history: readonly ApplyOutcome[] = []; #epoch = 0; #calls = 0; #busy = false; #disposed = false; #next: string | null = null;
  constructor(transport: TreeTransport, snapshot: () => ApplySnapshot | undefined, show: (state: ManifestApplyState) => void) { this.#transport = transport; this.#snapshot = snapshot; this.#show = show; }
  #paint(phase: ManifestApplyState['phase'], error?: ErrorCode) { if (!this.#disposed) this.#show({ phase, ...(this.#pending ? { outcome: this.#pending.outcome } : {}), history: this.#history, next: this.#next, canCancel: !!this.#pending && !this.#pending.submitted && !terminal(this.#pending.outcome), ...(error ? { error } : {}) }); }
  #current(record: Record) {
    const source = this.#snapshot(); if (!source || record.epoch !== this.#epoch || source.owner !== record.owner || source.revision !== record.outcome.source.revision || source.format !== record.outcome.source.format
      || !sameTarget(source.target, record.outcome.target) || JSON.stringify(source.reference) !== JSON.stringify(record.outcome.reference) || JSON.stringify(source.selection) !== JSON.stringify(record.selection)) return false;
    const snapshot = saveContentSnapshot(source.text); try { return snapshot.digest === record.outcome.source.identity; } finally { snapshot.bytes.fill(0); }
  }
  async #post(input: unknown): Promise<ManifestApplyResponse> {
    if (this.#calls >= 2) throw new BoundaryError('QUERY_LIMIT'); const body = JSON.stringify(manifestApplyRequestSchema.parse(input)); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED'); this.#calls++;
    try {
      const response = await this.#transport({ method: 'POST', path: '/v2/operations/manifest-apply', body }); if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body); } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = manifestApplyResponseSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); return parsed.data;
    } finally { this.#calls--; }
  }
  #accept(record: Record, value: ApplyOutcome) {
    if (!sameApplyIntent(record.outcome, value) || value.received < record.outcome.received || value.received > value.bytes) throw new BoundaryError('STALE_TARGET');
    if (value.patchDigest) { const plan = JSON.stringify([value.patchDigest, value.patchBytes, value.unchanged, value.baseline, value.missing]); if (record.plan && plan !== record.plan) throw new BoundaryError('STALE_TARGET'); record.plan ??= plan; }
    else if (record.plan) throw new BoundaryError('STALE_TARGET');
    record.outcome = value;
  }
  async prepare(): Promise<void> {
    if (this.#disposed || this.#busy) return; if (this.#pending && !terminal(this.#pending.outcome)) { this.#paint('error', 'CONFLICT'); return; }
    this.#busy = true; const epoch = ++this.#epoch; this.#pending = undefined; this.#paint('preparing'); let bytes: Uint8Array | undefined;
    try {
      const source = this.#snapshot(); if (!source) throw new BoundaryError('RESOURCE_INVALID'); if (this.#records.size >= 64) throw new BoundaryError('QUERY_LIMIT'); customDocumentReferenceSchema.parse(source.reference);
      const content = saveContentSnapshot(source.text); bytes = content.bytes; const requestId = crypto.randomUUID(), summary = { revision: source.revision, format: source.format, identity: content.digest };
      const response = await this.#post({ protocol: 2, kind: 'begin', requestId, target: source.target, selection: source.selection, reference: source.reference, source: summary, bytes: bytes.length });
      if (response.kind !== 'upload' || response.outcome.requestId !== requestId || !sameTarget(response.outcome.target, source.target) || JSON.stringify(response.outcome.reference) !== JSON.stringify(source.reference)
        || response.outcome.source.identity !== summary.identity || response.outcome.source.revision !== summary.revision || response.outcome.source.format !== summary.format || response.outcome.bytes !== bytes.length || response.outcome.received !== 0 || response.outcome.phase !== 'uploading'
        || response.grant.id !== response.outcome.id || response.grant.generation !== response.outcome.generation || response.grant.expiresAt !== response.outcome.expiresAt) throw new BoundaryError('STATE_UNAVAILABLE');
      // No body text is retained in the ledger: only owner/revision/hash and non-sensitive metadata.
      const record: Record = { grant: response.grant, owner: source.owner, selection: structuredClone(source.selection), epoch, outcome: response.outcome, submitted: false }; this.#records.set(record.outcome.id, record); this.#pending = record;
      if (this.#disposed || !this.#current(record)) { await this.#cancel(record); return; }
      for (let offset = 0; offset < bytes.length;) {
        if (!this.#current(record)) { await this.#cancel(record); return; } const chunk = saveContentChunk(bytes, offset);
        const page = await this.#post({ protocol: 2, kind: 'upload', grant: record.grant, offset, data: chunk.data });
        if (page.kind !== 'upload' || page.grant.capability !== record.grant.capability) throw new BoundaryError('STATE_UNAVAILABLE'); this.#accept(record, page.outcome);
        if (page.outcome.received !== chunk.end) throw new BoundaryError('CONTENT_INVALID'); offset = chunk.end;
      }
      const finished = await this.#post({ protocol: 2, kind: 'finish', grant: record.grant }); if (finished.kind !== 'confirmation' && finished.kind !== 'outcome') throw new BoundaryError('STATE_UNAVAILABLE'); this.#accept(record, finished.outcome);
      if (this.#disposed || !this.#current(record)) { await this.#cancel(record); return; } this.#paint(finished.kind === 'confirmation' ? 'confirm' : 'outcome');
    } catch (error) { if (!this.#disposed && epoch === this.#epoch) this.#paint('error', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
    finally { bytes?.fill(0); this.#busy = false; }
  }
  async submit(): Promise<void> {
    const record = this.#pending; if (this.#disposed || this.#busy || !record || record.submitted || record.outcome.phase !== 'prepared' || !record.outcome.patchDigest) return;
    if (!this.#current(record) || Date.now() >= record.grant.expiresAt) { this.#paint('error', 'STALE_TARGET'); return; }
    this.#busy = true; record.submitted = true; this.#paint('submitting');
    try { const page = await this.#post({ protocol: 2, kind: 'submit', grant: record.grant, patchDigest: record.outcome.patchDigest, confirmation: record.outcome.missing ? 'create-missing-crd-object' : 'apply-exact-crd-version' }); if (page.kind !== 'outcome') throw new BoundaryError('STATE_UNAVAILABLE'); this.#accept(record, page.outcome); if (this.#pending === record) this.#paint('outcome'); }
    catch { if (this.#pending === record) this.#paint('error', 'OPERATION_UNKNOWN'); } finally { this.#busy = false; }
  }
  async status(id?: string): Promise<void> {
    const record = id ? this.#records.get(id) : this.#pending; if (this.#disposed || !record) return;
    try { const page = await this.#post({ protocol: 2, kind: 'status', grant: record.grant }); if (page.kind !== 'outcome') throw new BoundaryError('STATE_UNAVAILABLE'); this.#accept(record, page.outcome); if (!this.#disposed) { this.#pending = record; this.#paint(!record.submitted && this.#current(record) && record.outcome.phase === 'prepared' ? 'confirm' : 'outcome'); } }
    catch (error) { this.#paint('error', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  canQuery(id: string) { return this.#records.has(id); }
  async #cancel(record: Record): Promise<void> { if (record.submitted || terminal(record.outcome)) return; try { const page = await this.#post({ protocol: 2, kind: 'cancel', grant: record.grant }); if (page.kind === 'outcome') this.#accept(record, page.outcome); } catch { /* Original grant remains manually queryable, never replay submit. */ } }
  async cancel(): Promise<void> { const record = this.#pending; if (!record || record.submitted) return; ++this.#epoch; await this.#cancel(record); this.#paint('outcome'); }
  changed() { ++this.#epoch; const record = this.#pending; if (record && !record.submitted && !terminal(record.outcome)) void this.#cancel(record); }
  reset() { this.changed(); this.#pending = undefined; this.#history = []; this.#next = null; this.#paint('idle'); }
  async outcomes(older = false): Promise<void> {
    if (this.#disposed) return; try { const page = await this.#post({ protocol: 2, kind: 'outcomes', ...(older && this.#next ? { after: this.#next } : {}) }); if (page.kind !== 'outcomes') throw new BoundaryError('STATE_UNAVAILABLE'); this.#history = page.outcomes; this.#next = page.next; this.#paint('outcome'); }
    catch (error) { this.#paint('error', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  dispose() { if (this.#disposed) return; this.changed(); this.#disposed = true; this.#history = []; this.#pending = undefined; }
}
