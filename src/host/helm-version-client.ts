// READ-ONLY Helm version client. Never instantiate/call in automated functional tests.
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { helmVersionRequestSchema, helmVersionResponseSchema } from '../shared/helm-version-protocol.ts';
import type { HelmVersionResponse } from '../shared/helm-version-protocol.ts';
import type { TreeTransport } from './tree-source.ts';
export type HelmVersionState = { readonly phase: 'idle' | 'reading' | 'ready' | 'error'; readonly syntax?: 'v2' | 'v3' | 'v4' | 'unknown'; readonly output?: string; readonly code?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class HelmVersionClient {
  readonly #request: TreeTransport; readonly #show: (state: HelmVersionState) => void;
  #revision = 0; #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: HelmVersionState) => void) { this.#request = request; this.#show = show; }
  #paint(phase: HelmVersionState['phase'], value?: HelmVersionResponse, code?: ErrorCode) {
    if (this.#disposed) return;
    this.#show({ phase, ...(value && value.kind === 'helm-version' ? { syntax: value.syntax, output: value.output } : {}), ...(code ? { code } : {}) });
  }
  async read(): Promise<void> {
    if (this.#disposed || this.#calls >= 1) return;
    const revision = ++this.#revision, current = () => !this.#disposed && revision === this.#revision;
    this.#paint('reading'); this.#calls++;
    try {
      const request = helmVersionRequestSchema.parse({ protocol: 2, kind: 'read' });
      const response = await this.#request({ method: 'POST', path: '/v2/helm/version', body: JSON.stringify(request) });
      if (!current()) return;
      if (response.body.length > 32_768) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = helmVersionResponseSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (parsed.data.kind === 'helm-version-unavailable') throw new BoundaryError(parsed.data.code);
      this.#paint('ready', parsed.data);
    } catch (error) {
      if (current()) this.#paint('error', undefined, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE');
    } finally { this.#calls--; }
  }
  reset() { ++this.#revision; this.#paint('idle'); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
