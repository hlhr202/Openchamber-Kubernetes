import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { namespaceRequestSchema, namespaceResponseSchema } from '../shared/namespace-protocol.ts';
import type { NamespaceGrant, NamespaceOutcome, NamespaceRequest, NamespaceResponse } from '../shared/namespace-protocol.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { configSelectionSchema } from '../shared/configuration.ts';
import { utf8ByteLength } from '../shared/identity.ts';
import type { ConfigurationIdentity } from '../shared/configuration-identity.ts';
import type { TreeTransport } from './tree-source.ts';

export type NamespaceState = { readonly phase: 'idle' | 'preparing' | 'confirm' | 'submitting' | 'result' | 'error'; readonly history: readonly NamespaceOutcome[];
  readonly outcome?: NamespaceOutcome; readonly expiresAt?: number; readonly next?: string | null; readonly error?: ErrorCode };
export type NamespaceSwitchState = { readonly phase: 'idle' }
  | { readonly phase: 'switching' | 'reloading'; readonly namespace: string }
  | { readonly phase: 'error'; readonly namespace: string; readonly error: ErrorCode; readonly written?: true };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
const sameConfiguration = (a: ConfigurationIdentity, b: ConfigurationIdentity) => a.serviceGeneration === b.serviceGeneration && a.projectId === b.projectId && a.configIdentity === b.configIdentity;
const same = (left: NamespaceOutcome, right: NamespaceOutcome) => left.id === right.id && left.serviceGeneration === right.serviceGeneration && sameConfiguration(left.configuration, right.configuration) && left.context === right.context
  && left.path === right.path && left.version === right.version && left.previous === right.previous && left.namespace === right.namespace
  && left.contextOrigin === right.contextOrigin && left.contextAction === right.contextAction && JSON.stringify(left.sources) === JSON.stringify(right.sources);
// WRITE controller: inert constructor. Never imported/instantiated/called by automatic tests.
export class NamespaceClient {
  readonly #request: TreeTransport; readonly #show: (state: NamespaceState) => void;
  #grant: NamespaceGrant | undefined; #outcome: NamespaceOutcome | undefined; #history: readonly NamespaceOutcome[] = []; #next: string | null = null;
  #phase: NamespaceState['phase'] = 'idle'; #revision = 0; #historyRevision = 0; #calls = 0; #disposed = false;
  #error: ErrorCode | undefined;
  constructor(request: TreeTransport, show: (state: NamespaceState) => void) { this.#request = request; this.#show = show; }
  get error() { return this.#error; }
  #emit(phase: NamespaceState['phase'], error?: ErrorCode) {
    this.#phase = phase; this.#error = error;
    if (!this.#disposed) this.#show({ phase, history: this.#history, next: this.#next, ...(this.#outcome ? { outcome: this.#outcome } : {}),
      ...(this.#grant && phase === 'confirm' ? { expiresAt: this.#grant.expiresAt } : {}), ...(error ? { error } : {}) });
  }
  async #rpc(input: NamespaceRequest) {
    if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT');
    const request = namespaceRequestSchema.safeParse(input); if (!request.success) throw new BoundaryError('INVALID_INPUT');
    const body = JSON.stringify(request.data); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
    this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/operations/namespace', body });
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const error = failure.safeParse(value); throw new BoundaryError(error.success ? error.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = namespaceResponseSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); return parsed.data;
    } finally { this.#calls--; }
  }
  #release(grant: NamespaceGrant | undefined) { if (grant) void this.#rpc({ protocol: 2, kind: 'cancel', grant }).catch(() => {}); }
  async prepare(configuration: ConfigurationIdentity | undefined, selection: ConfigSelection, context: string, namespace: string, direct = false) {
    if (this.#disposed || this.#phase === 'submitting') return;
    this.reset(); const revision = ++this.#revision, current = () => !this.#disposed && revision === this.#revision;
    this.#emit('preparing');
    try {
      if (!configuration) throw new BoundaryError('INVALID_INPUT');
      const response = await this.#rpc({ protocol: 2, kind: 'prepare', selection: configSelectionSchema.parse(selection), configuration, context, namespace });
      if (response.kind !== 'confirmation') throw new BoundaryError('STATE_UNAVAILABLE');
      if (!current()) { this.#release(response.grant); return; }
      if (response.grant.id !== response.outcome.id || response.grant.serviceGeneration !== configuration.serviceGeneration || response.outcome.serviceGeneration !== configuration.serviceGeneration
        || !sameConfiguration(response.outcome.configuration, configuration) || response.outcome.context !== context || response.outcome.namespace !== namespace || response.outcome.phase !== 'prepared'
        || (selection.mode === 'file' && response.outcome.path !== selection.path)) { this.#release(response.grant); throw new BoundaryError('STALE_TARGET'); }
      const paths = response.outcome.sources.map(source => source.path);
      if ((selection.mode === 'merge' && JSON.stringify(paths) !== JSON.stringify([...new Set(selection.paths)]))
        || (selection.mode === 'file' && paths.length !== 1)) { this.#release(response.grant); throw new BoundaryError('STALE_TARGET'); }
      if (direct && response.outcome.contextAction !== 'update') { this.#release(response.grant); throw new BoundaryError('STALE_TARGET'); }
      this.#grant = response.grant; this.#outcome = response.outcome;
      if (direct) this.#phase = 'confirm'; else this.#emit('confirm');
    } catch (error) { if (current()) this.#emit('error', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async switchTo(configuration: ConfigurationIdentity, selection: ConfigSelection, context: string, namespace: string, stillCurrent: () => boolean) {
    const preparation = this.prepare(configuration, selection, context, namespace, true), revision = this.#revision;
    await preparation;
    if (this.#disposed || revision !== this.#revision) return;
    if (!stillCurrent()) { this.reset(); return; }
    return this.submit();
  }
  async submit(): Promise<NamespaceOutcome | undefined> {
    if (this.#disposed || this.#phase !== 'confirm' || !this.#grant || !this.#outcome) return;
    const grant = this.#grant, original = this.#outcome, revision = ++this.#revision; this.#emit('submitting');
    const current = () => !this.#disposed && revision === this.#revision;
    const accept = (response: NamespaceResponse) => {
      if (response.kind !== 'outcome' || !same(response.outcome, original)) throw new BoundaryError('OPERATION_UNKNOWN');
      this.#outcome = response.outcome;
    };
    try {
      try {
        const response = await this.#rpc({ protocol: 2, kind: 'submit', grant });
        if (!current()) return;
        accept(response);
      } catch { /* A missing acknowledgement permits status, never a second submit. */ }
      const deadline = performance.now() + 12_000;
      for (let attempt = 0; current(); attempt++) {
        const outcome = this.#outcome;
        if (outcome && ['succeeded', 'failed', 'cancelled', 'unknown'].includes(outcome.phase)) { this.#emit('result'); return outcome; }
        if (attempt >= 40 || performance.now() >= deadline) break;
        await new Promise<void>(resolve => setTimeout(resolve, 250));
        if (!current() || performance.now() >= deadline) break;
        const response = await this.#rpc({ protocol: 2, kind: 'status', grant });
        if (!current()) return;
        accept(response);
      }
    } catch { /* Unknown readback is visible, with the original result retained for diagnostics. */ }
    if (current()) this.#emit('error', 'OPERATION_UNKNOWN');
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
  dispose() { this.reset(); this.#disposed = true; ++this.#historyRevision; }
}
