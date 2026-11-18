// READ-ONLY requirement lookup client; nothing is inserted anywhere automatically.
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { helmRequirementRequestSchema, helmRequirementResponseSchema } from '../shared/helm-requirement-protocol.ts';
import type { TreeTransport } from './tree-source.ts';
export type HelmRequirementState = { readonly phase: 'idle' | 'reading' | 'ready' | 'error'; readonly text?: string; readonly code?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class HelmRequirementClient {
  readonly #request: TreeTransport; readonly #show: (state: HelmRequirementState) => void;
  #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: HelmRequirementState) => void) { this.#request = request; this.#show = show; }
  async lookup(repository: string, chart: string): Promise<void> {
    if (this.#disposed || this.#calls >= 1) return;
    const parsed = helmRequirementRequestSchema.safeParse({ protocol: 2, kind: 'read', repository, chart });
    if (!parsed.success) { if (!this.#disposed) this.#show({ phase: 'error', code: 'INVALID_INPUT' }); return; }
    this.#show({ phase: 'reading' }); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/helm/requirement', body: JSON.stringify(parsed.data) });
      if (response.body.length > 4096) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const failureParsed = failure.safeParse(value); throw new BoundaryError(failureParsed.success ? failureParsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const responseParsed = helmRequirementResponseSchema.safeParse(value); if (!responseParsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
      if (responseParsed.data.kind === 'helm-requirement-unavailable') throw new BoundaryError(responseParsed.data.code);
      if (!this.#disposed) this.#show({ phase: 'ready', text: responseParsed.data.text });
    } catch (error) {
      if (!this.#disposed) this.#show({ phase: 'error', code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    } finally { this.#calls--; }
  }
  reset() { if (!this.#disposed) this.#show({ phase: 'idle' }); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
