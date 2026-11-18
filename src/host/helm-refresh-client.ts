// User-triggered Helm repo refresh client (writes ONLY the plugin-isolated cache). Never auto-invoked.
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { helmRefreshRequestSchema, helmRefreshResponseSchema } from '../shared/helm-refresh-protocol.ts';
import type { TreeTransport } from './tree-source.ts';
export type HelmRefreshState = { readonly phase: 'idle' | 'running' | 'done' | 'error'; readonly code?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class HelmRefreshClient {
  readonly #request: TreeTransport; readonly #show: (state: HelmRefreshState) => void;
  #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: HelmRefreshState) => void) { this.#request = request; this.#show = show; }
  async run(): Promise<void> {
    if (this.#disposed || this.#calls >= 1) return;
    this.#show({ phase: 'running' }); this.#calls++;
    try {
      const request = helmRefreshRequestSchema.parse({ protocol: 2, kind: 'run' });
      const response = await this.#request({ method: 'POST', path: '/v2/helm/repo-refresh', body: JSON.stringify(request) });
      if (response.body.length > 4096) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = helmRefreshResponseSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (parsed.data.kind === 'helm-repo-refresh-unavailable') throw new BoundaryError(parsed.data.code);
      this.#show({ phase: 'done' });
    } catch (error) {
      if (!this.#disposed) this.#show({ phase: 'error', code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    } finally { this.#calls--; }
  }
  reset() { if (!this.#disposed) this.#show({ phase: 'idle' }); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
