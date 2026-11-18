import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { deleteParametersSchema, deleteResponseSchema } from '../shared/delete-protocol.ts';
import type { DeleteOutcome, DeleteParameters, DeleteRequest, DeleteResponse, ViewGrant } from '../shared/delete-protocol.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { configSelectionSchema } from '../shared/configuration.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import type { TargetIdentity } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';
import { documentReferenceId } from '../shared/document-protocol.ts';

export type DeleteState = { readonly phase: 'idle' | 'preparing' | 'confirm' | 'submitting' | 'result' | 'error'; readonly history: readonly DeleteOutcome[];
  readonly outcome?: DeleteOutcome; readonly expiresAt?: number; readonly next?: string | null; readonly error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
type Confirmation = Extract<DeleteResponse, { kind: 'confirmation' }>;
// WRITE UI controller: no constructor action. Never instantiate/call in automated functional tests.
export class DeleteClient {
  readonly #request: TreeTransport; readonly #show: (state: DeleteState) => void;
  #grant: ViewGrant | undefined; #confirmation: Confirmation | undefined; #outcome: DeleteOutcome | undefined;
  #history: readonly DeleteOutcome[] = []; #next: string | null = null; #phase: DeleteState['phase'] = 'idle'; #revision = 0; #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: DeleteState) => void) { this.#request = request; this.#show = show; }
  #emit(phase: DeleteState['phase'], error?: ErrorCode) {
    this.#phase = phase; if (!this.#disposed) this.#show({ phase, history: this.#history, next: this.#next,
      ...(this.#outcome ? { outcome: this.#outcome } : {}), ...(this.#confirmation ? { expiresAt: this.#confirmation.expiresAt } : {}), ...(error ? { error } : {}) });
  }
  async #rpc(request: DeleteRequest): Promise<DeleteResponse> {
    if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT');
    const body = JSON.stringify(request); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
    this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/operations/delete', body });
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = deleteResponseSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); return parsed.data;
    } finally { this.#calls--; }
  }
  #release(grant: ViewGrant | undefined) { if (grant) void this.#rpc({ protocol: 2, kind: 'close', grant }).catch(() => {}); } // Own unsubmitted intent only; fixed lease expires if proxy unavailable.
  async prepare(target: TargetIdentity | undefined, selection: ConfigSelection, parameters: DeleteParameters) {
    if (this.#disposed || this.#phase === 'submitting') return;
    this.reset(); const revision = ++this.#revision, current = () => !this.#disposed && revision === this.#revision;
    this.#emit('preparing');
    try {
      if (!target || !deleteParametersSchema.safeParse(parameters).success) throw new BoundaryError('INVALID_INPUT');
      const opened = await this.#rpc({ protocol: 2, kind: 'open', target, selection: configSelectionSchema.parse(selection) });
      if (opened.kind !== 'view' || opened.grant.serviceGeneration !== target.serviceGeneration) throw new BoundaryError('STALE_TARGET');
      if (!current()) { this.#release(opened.grant); return; } this.#grant = opened.grant;
      const result = await this.#rpc({ protocol: 2, kind: 'prepare', grant: opened.grant, parameters });
      if (!current()) return;
      if (result.kind !== 'confirmation' || !sameTarget(result.outcome.target, target) || result.outcome.parameters.mode !== parameters.mode || documentReferenceId(result.outcome.parameters.reference) !== documentReferenceId(parameters.reference)
        || result.outcome.owner !== opened.grant.id || result.outcome.phase !== 'prepared') throw new BoundaryError('STALE_TARGET');
      this.#confirmation = result; this.#outcome = result.outcome; this.#emit('confirm');
    } catch (error) { if (current()) this.#emit('error', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async submit() {
    if (this.#disposed || this.#phase !== 'confirm' || !this.#grant || !this.#confirmation) return;
    const grant = this.#grant, confirmation = this.#confirmation, revision = ++this.#revision;
    this.#emit('submitting');
    try {
      const result = await this.#rpc({ protocol: 2, kind: 'submit', grant, id: confirmation.outcome.id, proof: confirmation.proof });
      if (this.#disposed || revision !== this.#revision) return;
      if (result.kind !== 'outcome' || result.outcome.id !== confirmation.outcome.id || result.outcome.owner !== grant.id
        || !sameTarget(result.outcome.target, confirmation.outcome.target) || result.outcome.parameters.mode !== confirmation.outcome.parameters.mode
        || documentReferenceId(result.outcome.parameters.reference) !== documentReferenceId(confirmation.outcome.parameters.reference)) throw new BoundaryError('OPERATION_UNKNOWN');
      this.#outcome = result.outcome; this.#confirmation = undefined; this.#emit('result');
    } catch { if (!this.#disposed && revision === this.#revision) { this.#confirmation = undefined; this.#emit('error', 'OPERATION_UNKNOWN'); } } // No automatic submit retry, including lost HTTP responses.
  }
  async outcomes(older = false) {
    if (this.#disposed) return;
    try {
      const response = await this.#rpc({ protocol: 2, kind: 'outcomes', ...(older && this.#next ? { after: this.#next } : {}) });
      if (this.#disposed) return;
      if (response.kind !== 'outcomes') throw new BoundaryError('STATE_UNAVAILABLE');
      this.#history = response.outcomes; this.#next = response.next;
      const matching = response.outcomes.find(value => value.id === this.#outcome?.id); if (matching) this.#outcome = matching;
      this.#emit(this.#phase);
    } catch (error) { if (!this.#disposed) this.#emit(this.#phase, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  reset() { ++this.#revision; this.#release(this.#grant); this.#grant = undefined; this.#confirmation = undefined; this.#outcome = undefined; this.#emit('idle'); }
  dispose() { this.reset(); this.#disposed = true; }
}
