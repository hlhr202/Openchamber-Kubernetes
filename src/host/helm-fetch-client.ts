// User-triggered chart fetch client (canonical destination; untar writes only there).
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { helmFetchRequestSchema, helmFetchResponseSchema } from '../shared/helm-fetch-protocol.ts';
import type { TreeTransport } from './tree-source.ts';
export type HelmFetchState = { readonly phase: 'idle' | 'running' | 'done' | 'error'; readonly chart?: string; readonly content?: string; readonly code?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class HelmFetchClient {
  readonly #request: TreeTransport; readonly #show: (state: HelmFetchState) => void;
  #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: HelmFetchState) => void) { this.#request = request; this.#show = show; }
  async run(chart: string, version: string | undefined, root: string, path: string): Promise<void> {
    if (this.#disposed || this.#calls >= 1) return;
    const parsed = helmFetchRequestSchema.safeParse({ protocol: 2, kind: 'run', chart, ...(version ? { version } : {}), root, path });
    if (!parsed.success) { if (!this.#disposed) this.#show({ phase: 'error', code: 'INVALID_INPUT' }); return; }
    this.#show({ phase: 'running' }); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/helm/fetch', body: JSON.stringify(parsed.data) });
      if (response.body.length > 32_768) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const failureParsed = failure.safeParse(value); throw new BoundaryError(failureParsed.success ? failureParsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const responseParsed = helmFetchResponseSchema.safeParse(value); if (!responseParsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (responseParsed.data.kind === 'helm-fetch-unavailable') throw new BoundaryError(responseParsed.data.code);
      if (!this.#disposed) this.#show({ phase: 'done', chart: responseParsed.data.chart, content: responseParsed.data.content });
    } catch (error) {
      if (!this.#disposed) this.#show({ phase: 'error', chart: parsed.data.chart, code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    } finally { this.#calls--; }
  }
  reset() { if (!this.#disposed) this.#show({ phase: 'idle' }); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
