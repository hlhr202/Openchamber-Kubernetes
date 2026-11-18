// User-triggered packaging client (canonical chart directory and destination; workspace write).
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { helmPackageRequestSchema, helmPackageResponseSchema } from '../shared/helm-package-protocol.ts';
import type { TreeTransport } from './tree-source.ts';
export type HelmPackageState = { readonly phase: 'idle' | 'running' | 'done' | 'error'; readonly content?: string; readonly code?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class HelmPackageClient {
  readonly #request: TreeTransport; readonly #show: (state: HelmPackageState) => void;
  #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: HelmPackageState) => void) { this.#request = request; this.#show = show; }
  async run(root: string, path: string, destinationRoot: string, destinationPath: string): Promise<void> {
    if (this.#disposed || this.#calls >= 1) return;
    const parsed = helmPackageRequestSchema.safeParse({ protocol: 2, kind: 'run', root, path, destinationRoot, destinationPath });
    if (!parsed.success) { if (!this.#disposed) this.#show({ phase: 'error', code: 'INVALID_INPUT' }); return; }
    this.#show({ phase: 'running' }); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/helm/package', body: JSON.stringify(parsed.data) });
      if (response.body.length > 32_768) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const failureParsed = failure.safeParse(value); throw new BoundaryError(failureParsed.success ? failureParsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const responseParsed = helmPackageResponseSchema.safeParse(value); if (!responseParsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (responseParsed.data.kind === 'helm-package-unavailable') throw new BoundaryError(responseParsed.data.code);
      if (!this.#disposed) this.#show({ phase: 'done', content: responseParsed.data.content });
    } catch (error) {
      if (!this.#disposed) this.#show({ phase: 'error', code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    } finally { this.#calls--; }
  }
  reset() { if (!this.#disposed) this.#show({ phase: 'idle' }); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
