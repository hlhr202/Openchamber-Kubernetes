// Explicit READ-only target/container selection, independent of session execution.
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { forwardSelectionKey, sessionSelectionSchema } from '../shared/session-target.ts';
import type { SessionTargetState } from '../shared/session-target.ts';
import { logContainersResponseSchema, podLogReferenceId } from '../shared/pod-log-protocol.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class SessionTargetClient {
  readonly #request: TreeTransport; readonly #show: (state: SessionTargetState) => void;
  #state: SessionTargetState = { phase: 'idle', containers: [] }; #revision = 0; #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: SessionTargetState) => void) { this.#request = request; this.#show = show; }
  get state(): SessionTargetState { return this.#state; }
  #emit(state: SessionTargetState) { this.#state = state; if (!this.#disposed) this.#show(state); }
  async select(input: unknown, containers = true, forwardPorts?: readonly number[]): Promise<void> {
    if (this.#disposed) return;
    const revision = ++this.#revision, parsed = sessionSelectionSchema.safeParse(input);
    if (!parsed.success) { this.#emit({ phase: 'error', containers: [], error: 'INVALID_INPUT' }); return; }
    const source = parsed.data;
    if (!containers) { this.#emit({ ...source, phase: 'ready', containers: [], ...(forwardPorts ? { forwardPorts } : {}) }); return; }
    if (source.reference.type.resource !== 'pods') { this.#emit({ ...source, phase: 'error', containers: [], error: 'INVALID_INPUT' }); return; }
    const hints = forwardSelectionKey({ ...source, phase: 'ready', containers: [] }) === forwardSelectionKey(this.#state) ? this.#state.forwardPorts : undefined;
    this.#emit({ ...source, phase: 'loading', containers: [] });
    let admitted = false;
    try {
      if (this.#calls >= 2) throw new BoundaryError('QUERY_LIMIT');
      const reference = { resource: 'pods' as const, namespace: source.reference.namespace!, name: source.reference.name, uid: source.reference.uid, resourceVersion: source.reference.resourceVersion };
      this.#calls++; admitted = true;
      const response = await this.#request({ method: 'POST', path: '/v2/logs/read', body: JSON.stringify({ protocol: 2, kind: 'containers', target: source.target, selection: source.selection, reference }) });
      if (this.#disposed || revision !== this.#revision) return;
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      const value: unknown = JSON.parse(response.body);
      if (response.status !== 200) { const error = failure.safeParse(value); throw new BoundaryError(error.success ? error.data.error.code : 'STATE_UNAVAILABLE'); }
      const page = logContainersResponseSchema.parse(value);
      if (!sameTarget(page.target, source.target) || podLogReferenceId(page.reference) !== podLogReferenceId(reference) || page.origin) throw new BoundaryError('STALE_TARGET');
      const names = page.containers.filter(container => container.kind === 'regular').map(container => container.name);
      if (!names.length || new Set(names).size !== names.length) throw new BoundaryError('NOT_FOUND');
      this.#emit({ ...source, phase: 'ready', containers: names, ...(names.length === 1 ? { container: names[0]! } : {}), ...(hints ? { forwardPorts: hints } : {}) });
    } catch (error) {
      if (!this.#disposed && revision === this.#revision) this.#emit({ ...source, phase: 'error', containers: [], error: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    } finally { if (admitted) this.#calls--; }
  }
  choose(container: string): void {
    if (this.#disposed || this.#state.phase !== 'ready' || !this.#state.containers.includes(container)) return;
    this.#emit({ ...this.#state, container });
  }
  reject(error: ErrorCode): void { ++this.#revision; this.#emit({ phase: 'error', containers: [], error }); }
  reset(): void { ++this.#revision; this.#emit({ phase: 'idle', containers: [] }); }
  dispose(): void { this.#disposed = true; this.reset(); }
}
