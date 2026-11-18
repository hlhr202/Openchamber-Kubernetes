import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { contextDeleteRequestSchema, contextDeleteResponseSchema } from '../shared/context-delete-protocol.ts';
import type { ContextDeleteOutcome, ContextDeleteRequest } from '../shared/context-delete-protocol.ts';
import type { ContextConfiguration, ContextGrant } from '../shared/context-protocol.ts';
import { configSelectionSchema } from '../shared/configuration.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { utf8ByteLength } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';

export type ContextDeleteState = { readonly phase: 'idle' | 'preparing' | 'confirm' | 'submitting' | 'result' | 'error'; readonly history: readonly ContextDeleteOutcome[];
  readonly outcome?: ContextDeleteOutcome; readonly expiresAt?: number; readonly next?: string | null; readonly error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
const sameConfiguration = (a: ContextConfiguration, b: ContextConfiguration) => a.serviceGeneration === b.serviceGeneration && a.projectId === b.projectId && a.configIdentity === b.configIdentity;
const same = (a: ContextDeleteOutcome, b: ContextDeleteOutcome) => a.id === b.id && a.serviceGeneration === b.serviceGeneration && sameConfiguration(a.configuration, b.configuration)
  && a.path === b.path && a.version === b.version && a.context === b.context && a.currentContextRetained === b.currentContextRetained && a.removesCurrent === b.removesCurrent
  && a.contextRemains === b.contextRemains && JSON.stringify(a.contextAfter) === JSON.stringify(b.contextAfter) && JSON.stringify(a.sources) === JSON.stringify(b.sources)
  && a.steps.every((value, index) => value.id === b.steps[index]?.id && value.name === b.steps[index]?.name && value.reason === b.steps[index]?.reason
    && value.path === b.steps[index]?.path && value.nextOrigin === b.steps[index]?.nextOrigin && value.shadowDefinitions === b.steps[index]?.shadowDefinitions
    && value.sharedReferences === b.steps[index]?.sharedReferences && JSON.stringify(value.dependencies) === JSON.stringify(b.steps[index]?.dependencies));
// WRITE client; inert constructor. Static review only, never imported or invoked by automatic tests.
export class ContextDeleteClient {
  readonly #request: TreeTransport; readonly #show: (state: ContextDeleteState) => void;
  #grant: ContextGrant | undefined; #outcome: ContextDeleteOutcome | undefined; #history: readonly ContextDeleteOutcome[] = []; #next: string | null = null;
  #phase: ContextDeleteState['phase'] = 'idle'; #revision = 0; #historyRevision = 0; #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: ContextDeleteState) => void) { this.#request = request; this.#show = show; }
  #emit(phase: ContextDeleteState['phase'], error?: ErrorCode) {
    this.#phase = phase;
    if (!this.#disposed) this.#show({ phase, history: this.#history, next: this.#next, ...(this.#outcome ? { outcome: this.#outcome } : {}),
      ...(this.#grant && phase === 'confirm' ? { expiresAt: this.#grant.expiresAt } : {}), ...(error ? { error } : {}) });
  }
  async #rpc(input: ContextDeleteRequest) {
    if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT');
    const request = contextDeleteRequestSchema.safeParse(input); if (!request.success) throw new BoundaryError('INVALID_INPUT');
    const body = JSON.stringify(request.data); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED'); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/operations/context-delete', body });
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const error = failure.safeParse(value); throw new BoundaryError(error.success ? error.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = contextDeleteResponseSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); return parsed.data;
    } finally { this.#calls--; }
  }
  #release(grant: ContextGrant | undefined) { if (grant) void this.#rpc({ protocol: 2, kind: 'cancel', grant }).catch(() => {}); }
  async prepare(configuration: ContextConfiguration | undefined, selection: ConfigSelection, context: string) {
    if (this.#disposed || this.#phase === 'submitting') return;
    this.reset(); const revision = ++this.#revision, current = () => !this.#disposed && revision === this.#revision; this.#emit('preparing');
    try {
      if (!configuration) throw new BoundaryError('INVALID_INPUT');
      const response = await this.#rpc({ protocol: 2, kind: 'prepare', selection: configSelectionSchema.parse(selection), configuration, context });
      if (response.kind !== 'confirmation') throw new BoundaryError('STATE_UNAVAILABLE');
      if (!current()) { this.#release(response.grant); return; }
      if (response.grant.id !== response.outcome.id || response.grant.serviceGeneration !== configuration.serviceGeneration || response.outcome.serviceGeneration !== configuration.serviceGeneration
        || !sameConfiguration(response.outcome.configuration, configuration) || response.outcome.context !== context || response.outcome.phase !== 'prepared'
        || (selection.mode === 'file' && response.outcome.path !== selection.path)) { this.#release(response.grant); throw new BoundaryError('STALE_TARGET'); }
      const paths = response.outcome.sources.map(source => source.path);
      if ((selection.mode === 'merge' && JSON.stringify(paths) !== JSON.stringify([...new Set(selection.paths)]))
        || (selection.mode === 'file' && paths.length !== 1)) { this.#release(response.grant); throw new BoundaryError('STALE_TARGET'); }
      this.#grant = response.grant; this.#outcome = response.outcome; this.#emit('confirm');
    } catch (error) { if (current()) this.#emit('error', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async submit() {
    if (this.#disposed || this.#phase !== 'confirm' || !this.#grant || !this.#outcome) return;
    const grant = this.#grant, original = this.#outcome, revision = ++this.#revision; this.#emit('submitting');
    try {
      const response = await this.#rpc({ protocol: 2, kind: 'submit', grant });
      if (this.#disposed || revision !== this.#revision) return;
      if (response.kind !== 'outcome' || !same(response.outcome, original)) throw new BoundaryError('OPERATION_UNKNOWN');
      this.#outcome = response.outcome; this.#emit('result');
    } catch { if (!this.#disposed && revision === this.#revision) this.#emit('error', 'OPERATION_UNKNOWN'); }
  }
  async outcomes(older = false) {
    if (this.#disposed) return; const revision = ++this.#historyRevision;
    try {
      const response = await this.#rpc({ protocol: 2, kind: 'outcomes', ...(older && this.#next ? { after: this.#next } : {}) });
      if (this.#disposed || revision !== this.#historyRevision) return;
      if (response.kind !== 'outcomes' || new Set(response.outcomes.map(value => value.id)).size !== response.outcomes.length
        || response.outcomes.some(value => value.serviceGeneration !== response.serviceGeneration || value.configuration.serviceGeneration !== response.serviceGeneration)) throw new BoundaryError('STATE_UNAVAILABLE');
      const matching = response.outcomes.find(value => value.id === this.#outcome?.id);
      if (matching && this.#outcome && !same(matching, this.#outcome)) throw new BoundaryError('STALE_TARGET');
      this.#history = response.outcomes; this.#next = response.next; if (matching) this.#outcome = matching; this.#emit(this.#phase);
    } catch (error) { if (!this.#disposed && revision === this.#historyRevision) this.#emit(this.#phase, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  reset() { ++this.#revision; ++this.#historyRevision; this.#release(this.#grant); this.#grant = undefined; this.#outcome = undefined; this.#emit('idle'); }
  dispose() { this.reset(); this.#disposed = true; }
}
