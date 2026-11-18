import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { readConfigSelection } from '../shared/configuration.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { healthSchema } from '../shared/protocol.ts';
import { contextChoicePageSchema, contextChoiceRequestSchema } from '../shared/context-choice-protocol.ts';
import type { ContextChoicePage } from '../shared/context-choice-protocol.ts';
import { utf8ByteLength } from '../shared/identity.ts';
import type { ConfigurationReadTransport } from './configuration-client.ts';

export type ContextChoiceState = { phase: 'idle' | 'loading' | 'ready' | 'error'; page?: ContextChoicePage; error?: ErrorCode };
const errorSchema = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
const decode = (text: string): unknown => { if (utf8ByteLength(text) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED'); try { return JSON.parse(text) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); } };
// READ only. Picking returns metadata; it neither imports nor calls a Use Context writer/confirmation client.
export class ContextChoiceClient {
  readonly #request: ConfigurationReadTransport; readonly #show: (state: ContextChoiceState) => void;
  #selection: ConfigSelection | undefined; #page: ContextChoicePage | undefined; #ready = false; #revision = 0; #calls = 0; #disposed = false;
  constructor(request: ConfigurationReadTransport, show: (state: ContextChoiceState) => void) { this.#request = request; this.#show = show; }
  async read(selection: ConfigSelection, search: string, next = false) {
    if (this.#disposed) return; const original = next ? this.#page : undefined;
    if (next && (!this.#ready || original?.nextOffset == null)) return;
    const revision = ++this.#revision, current = () => !this.#disposed && revision === this.#revision;
    this.#ready = false; this.#page = undefined; this.#selection = undefined; this.#show({ phase: 'loading' });
    if (this.#calls >= 4) { this.#show({ phase: 'error', error: 'QUERY_LIMIT' }); return; } this.#calls++;
    try {
      const chosen = readConfigSelection(selection), request = contextChoiceRequestSchema.parse({ protocol: 2, selection: chosen, search,
        page: { offset: original?.nextOffset ?? 0, limit: 100, ...(original ? { configIdentity: original.configIdentity } : {}) } });
      const health = await this.#request({ method: 'GET', path: '/health' }); if (!current()) return;
      const alive = healthSchema.safeParse(decode(health.body)); if (health.status !== 200 || !alive.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (original && original.serviceGeneration !== alive.data.serviceGeneration) throw new BoundaryError('STALE_TARGET');
      const body = JSON.stringify(request); if (utf8ByteLength(body) > 32_000) throw new BoundaryError('BUDGET_EXCEEDED');
      const response = await this.#request({ method: 'POST', path: '/v2/configuration/contexts', body }); if (!current()) return;
      const data = decode(response.body); if (response.status !== 200) { const error = errorSchema.safeParse(data); throw new BoundaryError(error.success ? error.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = contextChoicePageSchema.safeParse(data); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); const page = parsed.data;
      if (page.serviceGeneration !== alive.data.serviceGeneration || page.sources.mode !== chosen.mode || page.search !== search
        || (original && (page.configIdentity !== original.configIdentity || page.currentContext !== original.currentContext || page.currentContextMissing !== original.currentContextMissing
          || JSON.stringify(page.currentContextInfo) !== JSON.stringify(original.currentContextInfo) || page.total !== original.total))) throw new BoundaryError('STALE_TARGET');
      const end = request.page.offset + page.contexts.length;
      if (end > page.total || (end < page.total ? page.contexts.length !== 100 || page.nextOffset !== end : page.nextOffset !== null)) throw new BoundaryError('STATE_UNAVAILABLE');
      this.#page = page; this.#selection = chosen; this.#ready = true; this.#show({ phase: 'ready', page });
    } catch (error) { if (current()) this.#show({ phase: 'error', error: error instanceof BoundaryError ? error.code : 'INVALID_INPUT' }); }
    finally { this.#calls--; }
  }
  next() { const page = this.#page, selection = this.#selection; return page && selection ? this.read(selection, page.search, true) : Promise.resolve(); }
  pick(context: string) { const page = this.#page, selection = this.#selection; return this.#ready && page && selection && page.contexts.some(entry => entry.name === context)
    ? { serviceGeneration: page.serviceGeneration, configIdentity: page.configIdentity, selection, context } : undefined; }
  reset(error?: ErrorCode) { ++this.#revision; this.#page = undefined; this.#selection = undefined; this.#ready = false; if (!this.#disposed) this.#show(error ? { phase: 'error', error } : { phase: 'idle' }); }
  dispose() { this.reset(); this.#disposed = true; }
}
