// User-triggered dependency update client (canonical chart directory; workspace writes stay inside
// the chart directory; downloads go ONLY to the plugin-isolated cache).
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { helmDepUpRequestSchema, helmDepUpResponseSchema } from '../shared/helm-depup-protocol.ts';
import type { TreeTransport } from './tree-source.ts';
export type HelmDepUpState = { readonly phase: 'idle' | 'running' | 'done' | 'error'; readonly content?: string; readonly code?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class HelmDepUpClient {
  readonly #request: TreeTransport; readonly #show: (state: HelmDepUpState) => void;
  #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: HelmDepUpState) => void) { this.#request = request; this.#show = show; }
  async run(root: string, path: string): Promise<void> {
    if (this.#disposed || this.#calls >= 1) return;
    const parsed = helmDepUpRequestSchema.safeParse({ protocol: 2, kind: 'run', root, path });
    if (!parsed.success) { if (!this.#disposed) this.#show({ phase: 'error', code: 'INVALID_INPUT' }); return; }
    this.#show({ phase: 'running' }); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/helm/dep-up', body: JSON.stringify(parsed.data) });
      if (response.body.length > 32_768) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const failureParsed = failure.safeParse(value); throw new BoundaryError(failureParsed.success ? failureParsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const responseParsed = helmDepUpResponseSchema.safeParse(value); if (!responseParsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (responseParsed.data.kind === 'helm-dep-up-unavailable') throw new BoundaryError(responseParsed.data.code);
      if (!this.#disposed) this.#show({ phase: 'done', content: responseParsed.data.content });
    } catch (error) {
      if (!this.#disposed) this.#show({ phase: 'error', code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    } finally { this.#calls--; }
  }
  reset() { if (!this.#disposed) this.#show({ phase: 'idle' }); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
