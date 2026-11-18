// User-triggered dependency listing client (fetch writes ONLY plugin-owned dirs; temp is cleaned).
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { helmDependenciesRequestSchema, helmDependenciesResponseSchema } from '../shared/helm-dependencies-protocol.ts';
import type { TreeTransport } from './tree-source.ts';
export type HelmDependenciesState = { readonly phase: 'idle' | 'reading' | 'ready' | 'error'; readonly chart?: string; readonly headers?: readonly string[]; readonly rows?: readonly (readonly string[])[]; readonly code?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class HelmDependenciesClient {
  readonly #request: TreeTransport; readonly #show: (state: HelmDependenciesState) => void;
  #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: HelmDependenciesState) => void) { this.#request = request; this.#show = show; }
  async list(chart: string, version?: string): Promise<void> {
    if (this.#disposed || this.#calls >= 1) return;
    const parsed = helmDependenciesRequestSchema.safeParse({ protocol: 2, kind: 'read', chart, ...(version ? { version } : {}) });
    if (!parsed.success) { if (!this.#disposed) this.#show({ phase: 'error', code: 'INVALID_INPUT' }); return; }
    this.#show({ phase: 'reading' }); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/helm/dependencies', body: JSON.stringify(parsed.data) });
      if (response.body.length > 32_768) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const failureParsed = failure.safeParse(value); throw new BoundaryError(failureParsed.success ? failureParsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const responseParsed = helmDependenciesResponseSchema.safeParse(value); if (!responseParsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (responseParsed.data.kind === 'helm-dependencies-unavailable') throw new BoundaryError(responseParsed.data.code);
      if (!this.#disposed) this.#show({ phase: 'ready', chart: responseParsed.data.chart, headers: responseParsed.data.headers, rows: responseParsed.data.rows });
    } catch (error) {
      if (!this.#disposed) this.#show({ phase: 'error', chart: parsed.data.chart, code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    } finally { this.#calls--; }
  }
  reset() { if (!this.#disposed) this.#show({ phase: 'idle' }); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
