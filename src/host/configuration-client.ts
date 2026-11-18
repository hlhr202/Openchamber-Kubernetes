import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { readConfigSelection } from '../shared/configuration.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { configPageSchema, healthSchema, protocolVersion } from '../shared/protocol.ts';
import type { ConfigPage } from '../shared/protocol.ts';

export type ConfigurationState = {
  readonly phase: 'loading' | 'ready' | 'error'; readonly stale: boolean;
  readonly config?: ConfigPage; readonly error?: ErrorCode; readonly offset?: number;
};
export type ConfigurationReadTransport = (request: { method: 'GET' | 'POST'; path: string; body?: string }) => Promise<{ status: number; body: string }>;
const serviceErrorSchema = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();

function decode(body: string): unknown {
  if (new TextEncoder().encode(body).byteLength > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
  try { return JSON.parse(body); } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
}

// Read-only view controller. It does not authenticate an owner, persist paths, write configuration,
// switch context, or instantiate SDK/DOM globals; tests inject only pure synthetic READ responses.
export class ConfigurationClient {
  readonly #request: ConfigurationReadTransport;
  readonly #show: (state: ConfigurationState) => void;
  #revision = 0;
  #project: string | null | undefined;
  #selection: ConfigSelection = { mode: 'default' };
  #config: ConfigPage | undefined;
  #disposed = false;
  #loading = false;
  #failed = false;

  constructor(request: ConfigurationReadTransport, show: (state: ConfigurationState) => void) { this.#request = request; this.#show = show; }

  project(directory: string | null): boolean {
    if (this.#project === directory) return false;
    this.#project = directory;
    ++this.#revision;
    this.#selection = { mode: 'default' };
    this.#config = undefined;
    this.#loading = false;
    this.#failed = false;
    return true;
  }

  select(selection: unknown): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const next = readConfigSelection(selection);
    if (JSON.stringify(next) !== JSON.stringify(this.#selection)) this.#config = undefined;
    this.#selection = next;
    return this.#load({ offset: 0, limit: 100 });
  }

  reload(): Promise<void> { return this.#load({ offset: 0, limit: 100 }); }
  get selection(): ConfigSelection { return readConfigSelection(this.#selection); }

  next(): Promise<void> {
    if (this.#loading || this.#failed || this.#config?.nextOffset === null || !this.#config) return Promise.resolve();
    return this.#load({ offset: this.#config.nextOffset, limit: 100, configIdentity: this.#config.configIdentity });
  }

  async #load(page: { offset: number; limit: number; configIdentity?: string }): Promise<void> {
    if (this.#disposed) return;
    const revision = ++this.#revision;
    const current = () => !this.#disposed && revision === this.#revision;
    const selection = this.#selection;
    this.#loading = true;
    this.#show({ phase: 'loading', stale: this.#config !== undefined, ...(this.#config ? { config: this.#config } : {}) });
    try {
      const healthResponse = await this.#request({ method: 'GET', path: '/health' });
      if (!current()) return;
      const health = healthSchema.safeParse(decode(healthResponse.body));
      if (healthResponse.status !== 200 || !health.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (page.configIdentity && this.#config?.serviceGeneration !== health.data.serviceGeneration) throw new BoundaryError('STALE_TARGET');
      const body = JSON.stringify({ protocol: protocolVersion, selection, page });
      if (new TextEncoder().encode(body).byteLength > 32_000) throw new BoundaryError('BUDGET_EXCEEDED');
      const response = await this.#request({ method: 'POST', path: '/v2/configuration/read', body });
      if (!current()) return;
      const value = decode(response.body);
      if (response.status !== 200) {
        const error = serviceErrorSchema.safeParse(value);
        throw new BoundaryError(error.success ? error.data.error.code : 'STATE_UNAVAILABLE');
      }
      const result = configPageSchema.safeParse(value);
      if (!result.success) throw new BoundaryError('STATE_UNAVAILABLE');
      const config = result.data;
      if (config.serviceGeneration !== health.data.serviceGeneration || config.sources.mode !== selection.mode
        || (page.configIdentity && (config.configIdentity !== page.configIdentity || config.currentContext !== this.#config?.currentContext
          || config.currentContextMissing !== this.#config?.currentContextMissing || JSON.stringify(config.currentContextInfo) !== JSON.stringify(this.#config?.currentContextInfo)
          || config.total !== this.#config?.total))) throw new BoundaryError('STALE_TARGET');
      const end = page.offset + config.contexts.length;
      if (end > config.total || (end < config.total && (config.contexts.length !== page.limit || config.nextOffset !== end))
        || (end === config.total && config.nextOffset !== null)) throw new BoundaryError('STATE_UNAVAILABLE');
      this.#config = config;
      this.#loading = false;
      this.#failed = false;
      this.#show({ phase: 'ready', stale: false, config, offset: page.offset });
    } catch (error) {
      if (!current()) return;
      this.#loading = false;
      this.#failed = true;
      this.#show({ phase: 'error', stale: this.#config !== undefined, error: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE', ...(this.#config ? { config: this.#config } : {}) });
    }
  }

  cancel(): void {
    if (!this.#loading || this.#disposed) return;
    ++this.#revision;
    this.#loading = false;
    this.#failed = true;
    this.#show({ phase: 'error', stale: this.#config !== undefined, error: 'QUERY_CANCELLED', ...(this.#config ? { config: this.#config } : {}) });
  }

  dispose(): void { this.#disposed = true; ++this.#revision; this.#config = undefined; this.#selection = { mode: 'default' }; }
}
