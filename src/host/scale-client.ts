// WRITE UI controller for Scale. Never instantiate/call in automated functional tests; no constructor action.
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { scaleParametersSchema, scaleResponseSchema, parseScaleReplicasInput } from '../shared/scale-protocol.ts';
import type { ScaleOutcome, ScaleParameters, ScaleRequest, ScaleResponse, ScaleViewGrant } from '../shared/scale-protocol.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { configSelectionSchema } from '../shared/configuration.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import type { TargetIdentity } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';
import { documentReferenceId } from '../shared/document-protocol.ts';
export type ScaleState = { readonly phase: 'idle' | 'preparing' | 'confirm' | 'submitting' | 'result' | 'error'; readonly history: readonly ScaleOutcome[];
  readonly outcome?: ScaleOutcome; readonly expiresAt?: number; readonly next?: string | null; readonly error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
type Confirmation = Extract<ScaleResponse, { kind: 'confirmation' }>;
export class ScaleClient {
  readonly #request: TreeTransport; readonly #show: (state: ScaleState) => void;
  #grant: ScaleViewGrant | undefined; #confirmation: Confirmation | undefined; #outcome: ScaleOutcome | undefined;
  #history: readonly ScaleOutcome[] = []; #next: string | null = null; #phase: ScaleState['phase'] = 'idle'; #revision = 0; #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: ScaleState) => void) { this.#request = request; this.#show = show; }
  #emit(phase: ScaleState['phase'], error?: ErrorCode) {
    this.#phase = phase; if (!this.#disposed) this.#show({ phase, history: this.#history, next: this.#next,
      ...(this.#outcome ? { outcome: this.#outcome } : {}), ...(this.#confirmation ? { expiresAt: this.#confirmation.expiresAt } : {}), ...(error ? { error } : {}) });
  }
  async #rpc(request: ScaleRequest): Promise<ScaleResponse> {
    if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT');
    const body = JSON.stringify(request); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
    this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/operations/scale', body });
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = scaleResponseSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); return parsed.data;
    } finally { this.#calls--; }
  }
  #release(grant: ScaleViewGrant | undefined) { if (grant) void this.#rpc({ protocol: 2, kind: 'close', grant }).catch(() => {}); } // Own unsubmitted intent only; fixed lease expires if the proxy is unavailable.
  async prepare(target: TargetIdentity | undefined, selection: ConfigSelection, reference: unknown, replicasInput: string) {
    if (this.#disposed || this.#phase === 'submitting') return;
    this.reset(); const revision = ++this.#revision, current = () => !this.#disposed && revision === this.#revision;
    this.#emit('preparing');
    try {
      const replicas = parseScaleReplicasInput(replicasInput); if (replicas === undefined) throw new BoundaryError('INVALID_INPUT');
      if (!target) throw new BoundaryError('STALE_TARGET');
      const parameters: ScaleParameters = scaleParametersSchema.parse({ reference, replicas });
      const opened = await this.#rpc({ protocol: 2, kind: 'open', target, selection: configSelectionSchema.parse(selection) });
      if (opened.kind !== 'view' || opened.grant.serviceGeneration !== target.serviceGeneration) throw new BoundaryError('STALE_TARGET');
      if (!current()) { this.#release(opened.grant); return; } this.#grant = opened.grant;
      const result = await this.#rpc({ protocol: 2, kind: 'prepare', grant: opened.grant, parameters });
      if (!current()) return;
      if (result.kind !== 'confirmation' || !sameTarget(result.outcome.target, target) || result.outcome.parameters.replicas !== replicas
        || documentReferenceId(result.outcome.parameters.reference) !== documentReferenceId(parameters.reference)
        || result.outcome.owner !== opened.grant.id || result.outcome.phase !== 'prepared') throw new BoundaryError('STALE_TARGET');
      this.#confirmation = result; this.#outcome = result.outcome; this.#emit('confirm');
    } catch (error) { if (current()) this.#emit('error', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async submit() {
    if (this.#disposed || this.#phase !== 'confirm' || !this.#grant || !this.#confirmation) return;
    const grant = this.#grant, confirmation = this.#confirmation, revision = ++this.#revision;
    this.#emit('submitting');
    try {
      const result = await this.#rpc({ protocol: 2, kind: 'submit', grant, id: confirmation.outcome.id, proof: confirmation.proof, confirmation: 'scale-exact-target-replicas' });
      if (!this.#disposed && revision === this.#revision) {
        if (result.kind !== 'outcome' || result.outcome.id !== confirmation.outcome.id || !sameTarget(result.outcome.target, confirmation.outcome.target)) throw new BoundaryError('STALE_TARGET');
        this.#outcome = result.outcome; this.#emit('result');
      }
    } catch (error) { if (!this.#disposed && revision === this.#revision) this.#emit('error', error instanceof BoundaryError ? error.code : 'OPERATION_UNKNOWN'); }
  }
  cancel() {
    if (this.#disposed || !this.#grant || !this.#outcome || this.#phase !== 'confirm') return;
    const grant = this.#grant, id = this.#outcome.id; ++this.#revision;
    void this.#rpc({ protocol: 2, kind: 'cancel', grant, id }).catch(() => {});
    this.#emit('result');
  }
  async outcomes(older = false) {
    if (this.#disposed) return;
    try { const page = await this.#rpc({ protocol: 2, kind: 'outcomes', ...(older && this.#next ? { after: this.#next } : {}) }); if (page.kind !== 'outcomes') throw new BoundaryError('STATE_UNAVAILABLE'); this.#history = page.outcomes; this.#next = page.next; this.#emit(this.#phase === 'confirm' ? 'confirm' : 'result'); }
    catch (error) { this.#emit('error', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  reset() { ++this.#revision; this.#grant = undefined; this.#confirmation = undefined; this.#outcome = undefined; this.#history = []; this.#next = null; if (!this.#disposed) this.#emit('idle'); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
