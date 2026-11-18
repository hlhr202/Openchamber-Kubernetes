// Pure computation client; nothing is edited, written or inserted anywhere automatically.
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { helmParameteriseRequestSchema, helmParameteriseResponseSchema } from '../shared/helm-parameterise-protocol.ts';
import type { TreeTransport } from './tree-source.ts';
export type HelmParameteriseState = { readonly phase: 'idle' | 'reading' | 'ready' | 'error'; readonly document?: string; readonly entry?: string; readonly code?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class HelmParameteriseClient {
  readonly #request: TreeTransport; readonly #show: (state: HelmParameteriseState) => void;
  #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: HelmParameteriseState) => void) { this.#request = request; this.#show = show; }
  async run(template: string, field: string, value: string, document: string): Promise<void> {
    if (this.#disposed || this.#calls >= 1) return;
    const parsed = helmParameteriseRequestSchema.safeParse({ protocol: 2, kind: 'read', template, field, value, document });
    if (!parsed.success) { if (!this.#disposed) this.#show({ phase: 'error', code: 'INVALID_INPUT' }); return; }
    this.#show({ phase: 'reading' }); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/helm/parameterise', body: JSON.stringify(parsed.data) });
      if (response.body.length > 96_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value_: unknown; try { value_ = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const failureParsed = failure.safeParse(value_); throw new BoundaryError(failureParsed.success ? failureParsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const responseParsed = helmParameteriseResponseSchema.safeParse(value_); if (!responseParsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (responseParsed.data.kind === 'helm-parameterised-unavailable') throw new BoundaryError(responseParsed.data.code);
      if (!this.#disposed) this.#show({ phase: 'ready', document: responseParsed.data.document, entry: responseParsed.data.entry });
    } catch (error) {
      if (!this.#disposed) this.#show({ phase: 'error', code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    } finally { this.#calls--; }
  }
  reset() { if (!this.#disposed) this.#show({ phase: 'idle' }); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
