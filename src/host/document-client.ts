import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { documentChunkCharacters, documentPageSchema, documentReferenceId, documentRequestSchema } from '../shared/document-protocol.ts';
import type { DocumentPage, DocumentRequest } from '../shared/document-protocol.ts';
import { DocumentBuffer } from '../shared/document-buffer.ts';
import type { DocumentBufferState } from '../shared/document-buffer.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';
import { analyseManifestBundle } from './manifest-bundle.ts';

export type DocumentState = { readonly phase: 'idle' | 'loading' | 'ready' | 'error'; readonly stale: boolean; readonly text: string; readonly complete: boolean;
  readonly source?: DocumentRequest; readonly page?: DocumentPage; readonly editor?: DocumentBufferState; readonly error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
function freeze(value: unknown): void { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }
export class DocumentClient {
  readonly #request: TreeTransport; readonly #show: (state: DocumentState) => void;
  readonly #inflight = new Set<number>(); readonly #cursors = new Set<string>();
  #binding: DocumentRequest | undefined; #page: DocumentPage | undefined; #buffer: DocumentBuffer | undefined;
  #text = ''; #phase: DocumentState['phase'] = 'idle'; #revision = 0; #disposed = false; #stale = false;
  constructor(request: TreeTransport, show: (state: DocumentState) => void) { this.#request = request; this.#show = show; }
  #emit(phase: DocumentState['phase'], stale = this.#stale, error?: ErrorCode) {
    this.#stale = stale;
    this.#phase = phase;
    if (!this.#disposed) this.#show({ phase, stale, text: this.#text, complete: phase === 'ready' && this.#page?.nextCursor === null,
      ...(this.#binding ? { source: this.#binding } : {}), ...(this.#page ? { page: this.#page } : {}), ...(this.#buffer ? { editor: this.#buffer.state } : {}), ...(error ? { error } : {}) });
  }
  read(input: unknown): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#buffer?.state.dirty) { this.#emit('ready', this.#stale, 'DOCUMENT_DIRTY'); return Promise.resolve(); }
    const parsed = documentRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.cursor !== undefined) { this.reset(); this.#emit('error', false, 'INVALID_INPUT'); return Promise.resolve(); }
    if (JSON.stringify(parsed.data) !== JSON.stringify(this.#binding)) this.reset();
    freeze(parsed.data); this.#binding = parsed.data; return this.#load(parsed.data);
  }
  reload(discard = false): Promise<void> {
    if (this.#disposed || !this.#binding) return Promise.resolve();
    if (this.#buffer?.state.dirty && !discard) { this.#emit('ready', this.#stale, 'DOCUMENT_DIRTY'); return Promise.resolve(); }
    if (discard) this.#buffer?.revert(); return this.#load(this.#binding);
  }
  next(): Promise<void> { return !this.#stale && this.#phase === 'ready' && this.#page?.nextCursor && this.#binding ? this.#load({ ...this.#binding, cursor: this.#page.nextCursor }) : Promise.resolve(); }
  edit(text: string): void {
    if (this.#disposed || this.#phase !== 'ready' || !this.#buffer || this.#page?.nextCursor !== null) return;
    try { this.#buffer.edit(text); this.#emit('ready'); }
    catch (error) { this.#emit('ready', this.#stale, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  revert(): void { if (!this.#disposed && this.#buffer && this.#phase === 'ready') { this.#buffer.revert(); this.#emit('ready'); } }
  acknowledgeSaved(input: unknown, text: string, revision: number): boolean {
    if (this.#disposed || this.#phase !== 'ready' || !this.#buffer || this.#page?.nextCursor !== null) return false;
    if (!this.#buffer.acknowledgeSaved(input, text, revision)) return false; this.#emit('ready'); return true;
  }
  analyse(): void {
    if (this.#disposed || this.#phase !== 'ready' || !this.#buffer || this.#page?.nextCursor !== null) return;
    try { this.#buffer.analyse(analyseManifestBundle(this.#buffer.state.text, this.#buffer.state.origin.format)); this.#emit('ready'); } catch (error) { this.#emit('ready', false, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  selectDocument(index: number): void {
    if (this.#disposed || this.#phase !== 'ready' || !this.#buffer || this.#page?.nextCursor !== null) return;
    try { this.#buffer.selectDocument(index); this.#emit('ready'); } catch (error) { this.#emit('ready', false, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async #load(request: DocumentRequest) {
    const revision = ++this.#revision, previous = this.#page, old = this.#text;
    const current = () => !this.#disposed && this.#revision === revision;
    this.#emit('loading', !!previous);
    try {
      if (this.#inflight.size >= 4) throw new BoundaryError('QUERY_LIMIT');
      const body = JSON.stringify(request); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
      this.#inflight.add(revision); const response = await this.#request({ method: 'POST', path: '/v2/documents/read', body });
      if (!current()) return;
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = documentPageSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      const page = parsed.data, cursor = request.cursor;
      if (!sameTarget(page.target, request.target) || documentReferenceId(page.reference) !== documentReferenceId(request.reference) || page.format !== request.format
        || page.offset !== (cursor ? previous?.end : 0) || page.end - page.offset !== page.text.length || page.end > page.totalCharacters
        || (page.end < page.totalCharacters) !== (page.nextCursor !== null) || (page.nextCursor && page.text.length < documentChunkCharacters - 1)
        || (cursor && (page.contentIdentity !== previous?.contentIdentity || page.totalBytes !== previous?.totalBytes || page.totalCharacters !== previous?.totalCharacters))
        || (cursor && page.nextCursor && this.#cursors.has(page.nextCursor))) throw new BoundaryError('STALE_TARGET');
      const text = cursor ? old + page.text : page.text, bytes = utf8ByteLength(text);
      if (text.length !== page.end || page.totalCharacters > page.totalBytes || page.totalBytes > page.totalCharacters * 3 || bytes > page.totalBytes
        || (!page.nextCursor && bytes !== page.totalBytes)) throw new BoundaryError('CONTENT_INVALID');
      if (!cursor) this.#cursors.clear(); if (page.nextCursor) this.#cursors.add(page.nextCursor);
      freeze(page); this.#page = page; this.#text = text;
       this.#buffer = page.nextCursor ? undefined : new DocumentBuffer(text, page); this.#emit('ready', false);
    } catch (error) { if (current()) this.#emit('error', !!previous, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
    finally { this.#inflight.delete(revision); }
  }
  cancel(): void { if (!this.#disposed && this.#phase === 'loading') { ++this.#revision; this.#emit('error', !!this.#page, 'QUERY_CANCELLED'); } }
  close(discard = false): void {
    if (this.#buffer?.state.dirty && !discard) { this.#emit('ready', this.#stale, 'DOCUMENT_DIRTY'); return; }
    this.reset();
  }
  suspend(): void { if (this.#disposed || !this.#binding) return; ++this.#revision; this.#emit(this.#buffer ? 'ready' : 'error', true, 'STALE_TARGET'); }
  reset(): void { ++this.#revision; this.#binding = undefined; this.#page = undefined; this.#buffer = undefined; this.#text = ''; this.#cursors.clear(); this.#emit('idle', false); }
  dispose(): void { this.#disposed = true; this.reset(); }
}
