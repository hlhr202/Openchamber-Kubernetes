import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import { jobLogOriginId, logChunkCharacters, podLogReferenceId, podLogRequestSchema, podLogResponseSchema } from '../shared/pod-log-protocol.ts';
import type { PodLogPage, PodLogRequest, PodLogResponse } from '../shared/pod-log-protocol.ts';
import type { TreeTransport } from './tree-source.ts';

export type PodLogState = { readonly phase: 'idle' | 'loading' | 'ready' | 'error'; readonly stale: boolean; readonly text: string; readonly complete: boolean;
  readonly source?: PodLogRequest; readonly containers: readonly { readonly name: string; readonly kind: 'init' | 'regular' }[]; readonly page?: PodLogPage; readonly error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
function freeze(value: unknown): void { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }
export class PodLogClient {
  readonly #request: TreeTransport;
  readonly #show: (state: PodLogState) => void;
  readonly #inflight = new Set<number>();
  readonly #cursors = new Set<string>();
  #revision = 0;
  #binding: PodLogRequest | undefined;
  #page: PodLogPage | undefined;
  #containers: PodLogState['containers'] = [];
  #text = '';
  #phase: PodLogState['phase'] = 'idle';
  #disposed = false;
  constructor(request: TreeTransport, show: (state: PodLogState) => void) { this.#request = request; this.#show = show; }
  #emit(phase: PodLogState['phase'], stale = false, error?: ErrorCode) {
    this.#phase = phase;
    if (!this.#disposed) this.#show({ phase, stale, text: this.#text, complete: phase === 'ready' && this.#page?.nextCursor === null, containers: this.#containers,
      ...(this.#binding ? { source: this.#binding } : {}), ...(this.#page ? { page: this.#page } : {}), ...(error ? { error } : {}) });
  }
  open(input: unknown): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.reset();
    const parsed = podLogRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.kind !== 'containers') { this.#emit('error', false, 'INVALID_INPUT'); return Promise.resolve(); }
    freeze(parsed.data); this.#binding = parsed.data; return this.#load(parsed.data);
  }
  run(container: string, options: unknown): Promise<void> {
    if (this.#disposed || !this.#binding || !this.#containers.some(value => value.name === container)) return Promise.resolve();
    const parsed = podLogRequestSchema.safeParse({ ...this.#binding, kind: 'read', container, options, cursor: undefined });
    if (!parsed.success || parsed.data.kind !== 'read') { ++this.#revision; this.#emit('error', !!this.#page, 'INVALID_INPUT'); return Promise.resolve(); }
    freeze(parsed.data); this.#binding = parsed.data; this.#page = undefined; this.#text = ''; this.#cursors.clear(); return this.#load(parsed.data);
  }
  next(): Promise<void> {
    return this.#phase === 'ready' && this.#binding?.kind === 'read' && this.#page?.nextCursor ? this.#load({ ...this.#binding, cursor: this.#page.nextCursor }) : Promise.resolve();
  }
  async #load(request: PodLogRequest) {
    const revision = ++this.#revision, previous = this.#page, old = this.#text;
    const current = () => !this.#disposed && revision === this.#revision;
    this.#emit('loading', !!previous);
    try {
      if (this.#inflight.size >= 4) throw new BoundaryError('QUERY_LIMIT');
      const body = JSON.stringify(request);
      if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
      this.#inflight.add(revision);
      const response = await this.#request({ method: 'POST', path: '/v2/logs/read', body });
      if (!current()) return;
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown;
      try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = podLogResponseSchema.safeParse(value);
      if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      const result: PodLogResponse = parsed.data;
      if (!sameTarget(result.target, request.target) || podLogReferenceId(result.reference) !== podLogReferenceId(request.reference)
        || jobLogOriginId(result.origin) !== jobLogOriginId(request.origin)) throw new BoundaryError('STALE_TARGET');
      if (request.kind === 'containers') {
        if (result.kind !== 'log-containers' || new Set(result.containers.map(value => value.name)).size !== result.containers.length) throw new BoundaryError('STATE_UNAVAILABLE');
        this.#containers = Object.freeze(result.containers.map(value => Object.freeze(value)));
      } else {
        if (result.kind !== 'pod-log' || result.container !== request.container || JSON.stringify(result.options) !== JSON.stringify(request.options)) throw new BoundaryError('STALE_TARGET');
        const page = result, cursor = request.cursor, text = cursor ? old + page.text : page.text;
        if (page.offset !== (cursor ? previous?.end : 0) || page.end - page.offset !== page.text.length || page.end > page.totalCharacters
          || (page.end < page.totalCharacters) !== (page.nextCursor !== null) || (page.nextCursor && page.text.length < logChunkCharacters - 1)
          || (cursor && (page.snapshotId !== previous?.snapshotId || page.totalBytes !== previous?.totalBytes || page.totalCharacters !== previous?.totalCharacters))
          || (cursor && page.nextCursor && this.#cursors.has(page.nextCursor))) throw new BoundaryError('STALE_TARGET');
        const bytes = utf8ByteLength(text);
        if (text.length !== page.end || page.totalCharacters > page.totalBytes || page.totalBytes > page.totalCharacters * 3
          || bytes > page.totalBytes || (!page.nextCursor && bytes !== page.totalBytes)) throw new BoundaryError('CONTENT_INVALID');
        if (page.nextCursor) this.#cursors.add(page.nextCursor);
        freeze(page); this.#page = page; this.#text = text;
      }
      this.#emit('ready');
    } catch (error) { if (current()) this.#emit('error', !!previous, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
    finally { this.#inflight.delete(revision); }
  }
  cancel(): void { if (!this.#disposed && this.#phase === 'loading') { ++this.#revision; this.#emit('error', !!this.#page, 'QUERY_CANCELLED'); } }
  clear(): void { ++this.#revision; this.#text = ''; this.#page = undefined; this.#cursors.clear(); this.#emit(this.#binding ? 'ready' : 'idle'); }
  reset(): void { ++this.#revision; this.#binding = undefined; this.#page = undefined; this.#text = ''; this.#containers = []; this.#cursors.clear(); this.#emit('idle'); }
  dispose(): void { this.#disposed = true; this.reset(); }
}
