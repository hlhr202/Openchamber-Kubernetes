import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import { isDisplayText, keyContentChunkCharacters, keyContentRequestSchema, keyContentResponseSchema, keyReferenceId } from '../shared/key-content-protocol.ts';
import type { KeyContentRequest, KeyContentResponse, KeyReference } from '../shared/key-content-protocol.ts';
import { resourceRequestBytes } from '../shared/resource-protocol.ts';

export type KeyContentState = { readonly phase: 'idle' | 'loading' | 'ready' | 'error'; readonly stale: boolean; readonly text: string;
  readonly complete: boolean; readonly reference?: KeyReference; readonly encoding?: 'utf8' | 'base64'; readonly totalBytes?: number; readonly totalCharacters?: number; readonly error?: ErrorCode };
type Transport = (request: { method: 'POST'; path: string; body: string }) => Promise<{ status: number; body: string }>;
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function validatePage(page: KeyContentResponse, binding: KeyContentRequest, cursor: string | undefined, previous: KeyContentResponse | undefined, text: string) {
  if (!sameTarget(page.target, binding.target) || keyReferenceId(page.reference) !== keyReferenceId(binding.reference)
    || page.offset !== (cursor ? previous?.end : 0) || page.end - page.offset !== page.text.length || page.end > page.totalCharacters
    || (page.end < page.totalCharacters) !== (page.nextCursor !== null) || (page.nextCursor && (page.end === page.offset || page.text.length < keyContentChunkCharacters - 1))) throw new BoundaryError('STALE_TARGET');
  if (cursor && (page.nextCursor === cursor || page.contentIdentity !== previous?.contentIdentity || page.encoding !== previous?.encoding
    || page.totalBytes !== previous?.totalBytes || page.totalCharacters !== previous?.totalCharacters)) throw new BoundaryError('STALE_TARGET');
  if (page.encoding === 'utf8') {
    if (!isDisplayText(page.text) || page.totalCharacters > page.totalBytes || page.totalBytes > page.totalCharacters * 3
      || utf8ByteLength(text) > page.totalBytes || (!page.nextCursor && utf8ByteLength(text) !== page.totalBytes)) throw new BoundaryError('CONTENT_INVALID');
  } else {
    if (page.totalCharacters !== Math.ceil(page.totalBytes / 3) * 4 || page.offset % 4 || page.end % 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(page.text) || (page.nextCursor && page.text.includes('='))) throw new BoundaryError('CONTENT_INVALID');
    if (!page.nextCursor && text) {
      const padding = (3 - page.totalBytes % 3) % 3;
      if (text.endsWith('=') !== (padding > 0) || (padding && !text.endsWith('='.repeat(padding))) || text.endsWith('='.repeat(padding + 1))
        || (padding === 2 && (alphabet.indexOf(text.charAt(text.length - 3)) & 15) !== 0)
        || (padding === 1 && (alphabet.indexOf(text.charAt(text.length - 2)) & 3) !== 0)) throw new BoundaryError('CONTENT_INVALID');
    }
  }
  if (text.length !== page.end) throw new BoundaryError('STATE_UNAVAILABLE');
}

// Explicit sensitive view only. No tree state, storage, URL, log, clipboard or chat receives these strings.
export class KeyContentClient {
  readonly #request: Transport;
  readonly #show: (state: KeyContentState) => void;
  readonly #inflight = new Set<number>();
  readonly #cursors = new Set<string>();
  #binding: KeyContentRequest | undefined;
  #page: KeyContentResponse | undefined;
  #text = '';
  #revision = 0;
  #phase: KeyContentState['phase'] = 'idle';
  #disposed = false;
  constructor(request: Transport, show: (state: KeyContentState) => void) { this.#request = request; this.#show = show; }
  #emit(phase: KeyContentState['phase'], stale = false, error?: ErrorCode) {
    this.#phase = phase;
    if (!this.#disposed) this.#show({ phase, stale, text: this.#text, complete: phase === 'ready' && this.#page?.nextCursor === null,
      ...(this.#binding ? { reference: this.#binding.reference } : {}), ...(this.#page ? { encoding: this.#page.encoding, totalBytes: this.#page.totalBytes, totalCharacters: this.#page.totalCharacters } : {}),
      ...(error ? { error } : {}) });
  }
  read(input: unknown): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const parsed = keyContentRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.cursor !== undefined) { this.reset(); this.#emit('error', false, 'INVALID_INPUT'); return Promise.resolve(); }
    if (JSON.stringify(parsed.data) !== JSON.stringify(this.#binding)) { this.#text = ''; this.#page = undefined; this.#cursors.clear(); }
    Object.freeze(parsed.data.reference.parent); Object.freeze(parsed.data.reference);
    this.#binding = parsed.data;
    return this.#load();
  }
  reload(): Promise<void> { return this.#binding ? this.#load() : Promise.resolve(); }
  next(): Promise<void> { return this.#phase === 'ready' && this.#page?.nextCursor ? this.#load(this.#page.nextCursor) : Promise.resolve(); }
  async #load(cursor?: string) {
    if (this.#disposed || !this.#binding) return;
    const binding = this.#binding, previous = this.#page, revision = ++this.#revision, old = this.#text;
    const current = () => !this.#disposed && revision === this.#revision;
    this.#emit('loading', !!previous);
    try {
      if (this.#inflight.size >= 4) throw new BoundaryError('QUERY_LIMIT');
      const body = JSON.stringify({ ...binding, ...(cursor ? { cursor } : {}) });
      if (utf8ByteLength(body) > resourceRequestBytes) throw new BoundaryError('BUDGET_EXCEEDED');
      this.#inflight.add(revision);
      const response = await this.#request({ method: 'POST', path: '/v2/keys/read', body });
      if (!current()) return;
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown;
      try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = keyContentResponseSchema.safeParse(value);
      if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      const page = parsed.data, text = cursor ? old + page.text : page.text;
      validatePage(page, binding, cursor, previous, text);
      if (cursor && page.nextCursor && this.#cursors.has(page.nextCursor)) throw new BoundaryError('STALE_TARGET');
      if (!cursor) this.#cursors.clear();
      if (page.nextCursor) this.#cursors.add(page.nextCursor);
      this.#page = page; this.#text = text; this.#emit('ready');
    } catch (error) { if (current()) this.#emit('error', !!previous, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
    finally { this.#inflight.delete(revision); }
  }
  cancel(): void { if (!this.#disposed && this.#phase === 'loading') { ++this.#revision; this.#emit('error', !!this.#page, 'QUERY_CANCELLED'); } }
  reset(): void { ++this.#revision; this.#binding = undefined; this.#page = undefined; this.#text = ''; this.#cursors.clear(); this.#emit('idle'); }
  dispose(): void { this.#disposed = true; this.reset(); }
}
