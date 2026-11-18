// User-triggered chart inspection client (downloads go ONLY to the plugin-isolated cache).
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { helmInspectRequestSchema, helmInspectResponseSchema } from '../shared/helm-inspect-protocol.ts';
import type { TreeTransport } from './tree-source.ts';
export type HelmInspectState = { readonly phase: 'idle' | 'reading' | 'ready' | 'error'; readonly chart?: string; readonly content?: string; readonly code?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class HelmInspectClient {
  readonly #request: TreeTransport; readonly #show: (state: HelmInspectState) => void;
  #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: HelmInspectState) => void) { this.#request = request; this.#show = show; }
  async inspect(chart: string, version?: string): Promise<void> {
    if (this.#disposed || this.#calls >= 1) return;
    const parsed = helmInspectRequestSchema.safeParse({ protocol: 2, kind: 'read', chart, ...(version ? { version } : {}) });
    if (!parsed.success) { if (!this.#disposed) this.#show({ phase: 'error', code: 'INVALID_INPUT' }); return; }
    this.#show({ phase: 'reading' }); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/helm/inspect-chart', body: JSON.stringify(parsed.data) });
      if (response.body.length > 32_768) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const failureParsed = failure.safeParse(value); throw new BoundaryError(failureParsed.success ? failureParsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const responseParsed = helmInspectResponseSchema.safeParse(value); if (!responseParsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (responseParsed.data.kind === 'helm-chart-inspect-unavailable') throw new BoundaryError(responseParsed.data.code);
      if (!this.#disposed) this.#show({ phase: 'ready', chart: responseParsed.data.chart, content: responseParsed.data.content });
    } catch (error) {
      if (!this.#disposed) this.#show({ phase: 'error', chart: parsed.data.chart, code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    } finally { this.#calls--; }
  }
  reset() { if (!this.#disposed) this.#show({ phase: 'idle' }); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
