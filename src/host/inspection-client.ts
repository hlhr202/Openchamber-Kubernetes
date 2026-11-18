import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { inspectionChunkCharacters, inspectionPageSchema, inspectionRequestSchema, sameInspectionObject } from '../shared/inspection-protocol.ts';
import type { InspectionPage, InspectionRequest } from '../shared/inspection-protocol.ts';
import { documentReferenceId } from '../shared/document-protocol.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';

export type InspectionState = { phase: 'idle' | 'loading' | 'ready' | 'error'; stale: boolean; text: string; complete: boolean; source?: InspectionRequest; page?: InspectionPage; error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
function freeze(value: unknown): void { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }
export class InspectionClient {
  readonly #request: TreeTransport; readonly #show: (state: InspectionState) => void; readonly #inflight = new Set<number>(); readonly #cursors = new Set<string>();
  #source: InspectionRequest | undefined; #page: InspectionPage | undefined; #text = ''; #phase: InspectionState['phase'] = 'idle'; #revision = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: InspectionState) => void) { this.#request = request; this.#show = show; }
  #emit(phase: InspectionState['phase'], stale = false, error?: ErrorCode) {
    this.#phase = phase;
    if (!this.#disposed) this.#show({ phase, stale, text: this.#text, complete: phase === 'ready' && this.#page?.nextCursor === null,
      ...(this.#source ? { source: this.#source } : {}), ...(this.#page ? { page: this.#page } : {}), ...(error ? { error } : {}) });
  }
  read(input: unknown): Promise<void> {
    if (this.#disposed) return Promise.resolve(); const parsed = inspectionRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.cursor !== undefined || (parsed.data.mode !== 'cluster-info' && parsed.data.refresh)) { this.reset(); this.#emit('error', false, 'INVALID_INPUT'); return Promise.resolve(); }
    if (JSON.stringify(parsed.data) !== JSON.stringify(this.#source)) this.reset();
    freeze(parsed.data); this.#source = parsed.data; return this.#load(parsed.data);
  }
  refresh(): Promise<void> { return !this.#disposed && this.#source ? this.#load(this.#source.mode === 'cluster-info' ? this.#source : { ...this.#source, refresh: true }) : Promise.resolve(); }
  next(): Promise<void> { return this.#phase === 'ready' && this.#page?.nextCursor && this.#source ? this.#load({ ...this.#source, cursor: this.#page.nextCursor }) : Promise.resolve(); }
  async #load(request: InspectionRequest) {
    const revision = ++this.#revision, previous = this.#page, old = this.#text, current = () => !this.#disposed && revision === this.#revision; this.#emit('loading', !!previous);
    try {
      if (this.#inflight.size >= 4) throw new BoundaryError('QUERY_LIMIT'); const body = JSON.stringify(request); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
      this.#inflight.add(revision); const response = await this.#request({ method: 'POST', path: '/v2/inspection/read', body }); if (!current()) return;
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let data: unknown; try { data = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const error = failure.safeParse(data); throw new BoundaryError(error.success ? error.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = inspectionPageSchema.safeParse(data); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); const page = parsed.data, continuation = !!request.cursor;
      const sameReference = request.mode === 'cluster-info' ? page.mode === 'cluster-info' : page.mode !== 'cluster-info'
        && (request.refresh ? sameInspectionObject(page.reference, request.reference) : documentReferenceId(page.reference) === documentReferenceId(request.reference));
      if (!sameTarget(page.target, request.target) || !sameReference || page.mode !== request.mode
        || page.offset !== (continuation ? previous?.end : 0) || (page.nextCursor && page.text.length < inspectionChunkCharacters - 1)
        || (continuation && (page.contentIdentity !== previous?.contentIdentity || page.totalBytes !== previous?.totalBytes || page.totalCharacters !== previous?.totalCharacters || page.expiresAt !== previous?.expiresAt))
        || (page.nextCursor && this.#cursors.has(page.nextCursor) && continuation)) throw new BoundaryError('STALE_TARGET');
      const text = continuation ? old + page.text : page.text, bytes = utf8ByteLength(text);
      if (text.length !== page.end || page.totalCharacters > page.totalBytes || page.totalBytes > page.totalCharacters * 3 || bytes > page.totalBytes || (!page.nextCursor && bytes !== page.totalBytes)) throw new BoundaryError('CONTENT_INVALID');
      if (!continuation) this.#cursors.clear(); if (page.nextCursor) this.#cursors.add(page.nextCursor);
      if (request.mode !== 'cluster-info' && request.refresh && page.mode !== 'cluster-info') {
        this.#source = { protocol: request.protocol, selection: request.selection, target: request.target, mode: request.mode, reference: page.reference }; freeze(this.#source);
      }
      freeze(page); this.#page = page; this.#text = text; this.#emit('ready');
    } catch (error) { if (current()) this.#emit('error', !!previous, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
    finally { this.#inflight.delete(revision); }
  }
  cancel() { if (!this.#disposed && this.#phase === 'loading') { ++this.#revision; this.#emit('error', !!this.#page, 'QUERY_CANCELLED'); } }
  reset() { ++this.#revision; this.#source = undefined; this.#page = undefined; this.#text = ''; this.#cursors.clear(); this.#emit('idle'); }
  dispose() { this.#disposed = true; this.reset(); }
}
