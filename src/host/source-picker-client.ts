import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { z } from 'zod';
import { healthSchema } from '../shared/protocol.ts';
import { serverDirectorySchema, sourceChildPath, sourcePickerPageSchema, sourcePickerRequestSchema } from '../shared/source-picker-protocol.ts';
import type { SourcePickerPage } from '../shared/source-picker-protocol.ts';
import { utf8ByteLength } from '../shared/identity.ts';
import type { ConfigurationReadTransport } from './configuration-client.ts';

export type SourcePickerState = { phase: 'idle' | 'loading' | 'ready' | 'error'; page?: SourcePickerPage; error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
const decode = (text: string): unknown => { if (utf8ByteLength(text) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED'); try { return JSON.parse(text) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); } };
export class SourcePickerClient {
  readonly #request: ConfigurationReadTransport; readonly #show: (state: SourcePickerState) => void;
  #page: SourcePickerPage | undefined; #revision = 0; #calls = 0; #ready = false; #disposed = false;
  constructor(request: ConfigurationReadTransport, show: (state: SourcePickerState) => void) { this.#request = request; this.#show = show; }
  async read(directory: string, showHidden = false, next = false) {
    if (this.#disposed) return; const original = next ? this.#page : undefined;
    if (next && (!this.#ready || original?.nextOffset == null)) return;
    const revision = ++this.#revision, current = () => !this.#disposed && revision === this.#revision; this.#ready = false; this.#page = undefined; this.#show({ phase: 'loading' });
    if (this.#calls >= 4) { this.#show({ phase: 'error', error: 'QUERY_LIMIT' }); return; } this.#calls++;
    try {
      serverDirectorySchema.parse(directory);
      const health = await this.#request({ method: 'GET', path: '/health' }); if (!current()) return;
      const alive = healthSchema.safeParse(decode(health.body)); if (health.status !== 200 || !alive.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (original && original.serviceGeneration !== alive.data.serviceGeneration) throw new BoundaryError('STALE_TARGET');
      const input = sourcePickerRequestSchema.parse({ protocol: 2, serviceGeneration: alive.data.serviceGeneration, directory, showHidden,
        offset: original?.nextOffset ?? 0, ...(original ? { listingIdentity: original.listingIdentity } : {}) });
      const body = JSON.stringify(input); if (utf8ByteLength(body) > 12_000) throw new BoundaryError('BUDGET_EXCEEDED');
      const response = await this.#request({ method: 'POST', path: '/v2/configuration/files', body }); if (!current()) return;
      const data = decode(response.body); if (response.status !== 200) { const error = failure.safeParse(data); throw new BoundaryError(error.success ? error.data.error.code : 'STATE_UNAVAILABLE'); }
      const page = sourcePickerPageSchema.safeParse(data); if (!page.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (page.data.serviceGeneration !== input.serviceGeneration || page.data.directory !== directory || page.data.showHidden !== showHidden || page.data.offset !== input.offset
        || (original && (page.data.listingIdentity !== original.listingIdentity || page.data.total !== original.total))) throw new BoundaryError('STALE_TARGET');
      this.#page = page.data; this.#ready = true; this.#show({ phase: 'ready', page: page.data });
    } catch (error) { if (current()) this.#show({ phase: 'error', error: error instanceof BoundaryError ? error.code : 'INVALID_INPUT' }); }
    finally { this.#calls--; }
  }
  next() { const page = this.#page; return page ? this.read(page.directory, page.showHidden, true) : Promise.resolve(); }
  pick(name: string): string | undefined { const page = this.#page; if (!this.#ready || !page?.entries.some(entry => entry.name === name && entry.kind === 'file')) return undefined;
    try { return sourceChildPath(page.directory, name); } catch { return undefined; } }
  reset() { ++this.#revision; this.#ready = false; this.#page = undefined; if (!this.#disposed) this.#show({ phase: 'idle' }); }
  dispose() { this.reset(); this.#disposed = true; }
}
