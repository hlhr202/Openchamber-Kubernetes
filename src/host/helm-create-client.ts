// User-triggered chart scaffolding client (canonical parent location; workspace write only there).
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { helmCreateRequestSchema, helmCreateResponseSchema } from '../shared/helm-create-protocol.ts';
import type { TreeTransport } from './tree-source.ts';
export type HelmCreateState = { readonly phase: 'idle' | 'running' | 'done' | 'error'; readonly name?: string; readonly content?: string; readonly code?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class HelmCreateClient {
  readonly #request: TreeTransport; readonly #show: (state: HelmCreateState) => void;
  #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: HelmCreateState) => void) { this.#request = request; this.#show = show; }
  async run(root: string, path: string, name: string): Promise<void> {
    if (this.#disposed || this.#calls >= 1) return;
    const parsed = helmCreateRequestSchema.safeParse({ protocol: 2, kind: 'run', root, path, name });
    if (!parsed.success) { if (!this.#disposed) this.#show({ phase: 'error', code: 'INVALID_INPUT' }); return; }
    this.#show({ phase: 'running' }); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/helm/create', body: JSON.stringify(parsed.data) });
      if (response.body.length > 32_768) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const failureParsed = failure.safeParse(value); throw new BoundaryError(failureParsed.success ? failureParsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const responseParsed = helmCreateResponseSchema.safeParse(value); if (!responseParsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (responseParsed.data.kind === 'helm-chart-create-unavailable') throw new BoundaryError(responseParsed.data.code);
      if (!this.#disposed) this.#show({ phase: 'done', name: responseParsed.data.name, content: responseParsed.data.content });
    } catch (error) {
      if (!this.#disposed) this.#show({ phase: 'error', code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    } finally { this.#calls--; }
  }
  reset() { if (!this.#disposed) this.#show({ phase: 'idle' }); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
