// User-triggered chart lint client (canonical workspace chart directory; findings are a result).
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { helmLintRequestSchema, helmLintResponseSchema } from '../shared/helm-lint-protocol.ts';
import type { TreeTransport } from './tree-source.ts';
export type HelmLintState = { readonly phase: 'idle' | 'reading' | 'ready' | 'error'; readonly failed?: boolean; readonly content?: string; readonly code?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class HelmLintClient {
  readonly #request: TreeTransport; readonly #show: (state: HelmLintState) => void;
  #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: HelmLintState) => void) { this.#request = request; this.#show = show; }
  async lint(root: string, path: string): Promise<void> {
    if (this.#disposed || this.#calls >= 1) return;
    const parsed = helmLintRequestSchema.safeParse({ protocol: 2, kind: 'read', root, path });
    if (!parsed.success) { if (!this.#disposed) this.#show({ phase: 'error', code: 'INVALID_INPUT' }); return; }
    this.#show({ phase: 'reading' }); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/helm/lint', body: JSON.stringify(parsed.data) });
      if (response.body.length > 32_768) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const failureParsed = failure.safeParse(value); throw new BoundaryError(failureParsed.success ? failureParsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const responseParsed = helmLintResponseSchema.safeParse(value); if (!responseParsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (responseParsed.data.kind === 'helm-lint-unavailable') throw new BoundaryError(responseParsed.data.code);
      if (!this.#disposed) this.#show({ phase: 'ready', failed: responseParsed.data.failed, content: responseParsed.data.content });
    } catch (error) {
      if (!this.#disposed) this.#show({ phase: 'error', code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    } finally { this.#calls--; }
  }
  reset() { if (!this.#disposed) this.#show({ phase: 'idle' }); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
