import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { explainRequestSchema, explainResponseSchema } from '../shared/explain-protocol.ts';
import type { ExplainRequest, ExplainResponse } from '../shared/explain-protocol.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';

export type ExplainState = { phase: 'idle' | 'loading' | 'ready' | 'error'; source?: ExplainRequest; page?: ExplainResponse; error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
function freeze(value: unknown): void { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }
export class ExplainClient {
  readonly #request: TreeTransport; readonly #show: (state: ExplainState) => void; #revision = 0; #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: ExplainState) => void) { this.#request = request; this.#show = show; }
  async read(input: unknown) {
    if (this.#disposed) return; const revision = ++this.#revision, current = () => !this.#disposed && revision === this.#revision;
    const parsed = explainRequestSchema.safeParse(input); if (!parsed.success) { this.#show({ phase: 'error', error: 'INVALID_INPUT' }); return; } const source = parsed.data;
    freeze(source); this.#show({ phase: 'loading', source }); let admitted = false;
    try {
      if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT'); const body = JSON.stringify(source); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
      this.#calls++; admitted = true; const result = await this.#request({ method: 'POST', path: '/v2/explain/read', body }); if (!current()) return;
      if (utf8ByteLength(result.body) > 64_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let data: unknown; try { data = JSON.parse(result.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (result.status !== 200) { const error = failure.safeParse(data); throw new BoundaryError(error.success ? error.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = explainResponseSchema.safeParse(data); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); const page = parsed.data;
       if (!sameTarget(page.target, source.target) || JSON.stringify(page.type) !== JSON.stringify(source.type) || JSON.stringify(page.fieldPath) !== JSON.stringify(source.fieldPath)
         || JSON.stringify(page.definition) !== JSON.stringify(source.definition)
        || page.documentIdentity !== source.documentIdentity || page.revision !== source.revision) throw new BoundaryError('STALE_TARGET');
      freeze(page); this.#show({ phase: 'ready', source, page });
    } catch (error) { if (current()) this.#show({ phase: 'error', source, error: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' }); }
    finally { if (admitted) this.#calls--; }
  }
  reset(error?: ErrorCode) { ++this.#revision; if (!this.#disposed) this.#show(error ? { phase: 'error', error } : { phase: 'idle' }); }
  dispose() { this.#disposed = true; ++this.#revision; }
}
