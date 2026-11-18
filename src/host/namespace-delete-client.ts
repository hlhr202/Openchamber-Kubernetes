import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { namespaceDeleteRequestSchema, namespaceDeleteResponseSchema } from '../shared/namespace-delete-protocol.ts';
import type { NamespaceDeleteGrant, NamespaceDeleteOutcome, NamespaceDeleteRequest } from '../shared/namespace-delete-protocol.ts';
import { configSelectionSchema } from '../shared/configuration.ts';
import { namespaceDeleteReferenceSchema } from '../shared/namespace-inventory.ts';
import type { NamespaceDeleteReference } from '../shared/namespace-inventory.ts';
import { documentReferenceId } from '../shared/document-protocol.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import type { TargetIdentity } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';

type Intent = { target: TargetIdentity; selection: ConfigSelection; reference: NamespaceDeleteReference };
export type NamespaceDeleteState = { phase: 'idle' | 'initial' | 'preparing' | 'confirm' | 'submitting' | 'result' | 'error'; history: readonly NamespaceDeleteOutcome[];
  intent?: Intent; outcome?: NamespaceDeleteOutcome; expiresAt?: number; next?: string | null; error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
const same = (a: NamespaceDeleteOutcome, b: NamespaceDeleteOutcome) => a.id === b.id && a.serviceGeneration === b.serviceGeneration && sameTarget(a.target, b.target)
  && documentReferenceId(a.reference) === documentReferenceId(b.reference) && a.inventory.digest === b.inventory.digest && a.path === b.path
  && a.contextOrigin === b.contextOrigin && a.version === b.version && JSON.stringify(a.sources) === JSON.stringify(b.sources);
// WRITE controller: constructors/open only show intent. Never instantiated/called by automatic tests.
export class NamespaceDeleteClient {
  readonly #request: TreeTransport; readonly #show: (state: NamespaceDeleteState) => void;
  #intent: Intent | undefined; #grant: NamespaceDeleteGrant | undefined; #outcome: NamespaceDeleteOutcome | undefined; #history: readonly NamespaceDeleteOutcome[] = [];
  #next: string | null = null; #phase: NamespaceDeleteState['phase'] = 'idle'; #revision = 0; #historyRevision = 0; #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: NamespaceDeleteState) => void) { this.#request = request; this.#show = show; }
  #emit(phase: NamespaceDeleteState['phase'], error?: ErrorCode) {
    this.#phase = phase; if (!this.#disposed) this.#show({ phase, history: this.#history, next: this.#next, ...(this.#intent ? { intent: this.#intent } : {}), ...(this.#outcome ? { outcome: this.#outcome } : {}),
      ...(phase === 'confirm' && this.#grant ? { expiresAt: this.#grant.expiresAt } : {}), ...(error ? { error } : {}) });
  }
  async #rpc(input: NamespaceDeleteRequest) {
    if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT');
    const parsed = namespaceDeleteRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
    const body = JSON.stringify(parsed.data); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED'); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/operations/namespace-delete', body });
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const error = failure.safeParse(value); throw new BoundaryError(error.success ? error.data.error.code : 'STATE_UNAVAILABLE'); }
      const result = namespaceDeleteResponseSchema.safeParse(value); if (!result.success) throw new BoundaryError('STATE_UNAVAILABLE'); return result.data;
    } finally { this.#calls--; }
  }
  #release(grant: NamespaceDeleteGrant | undefined) { if (grant) void this.#rpc({ protocol: 2, kind: 'cancel', grant }).catch(() => {}); }
  open(target: TargetIdentity | undefined, selection: ConfigSelection, reference: unknown) {
    if (this.#disposed || this.#phase === 'submitting') return; this.reset();
    try {
      if (!target) throw new BoundaryError('INVALID_INPUT');
      const chosen = configSelectionSchema.safeParse(selection), ref = namespaceDeleteReferenceSchema.safeParse(reference);
      if (!chosen.success || !ref.success) throw new BoundaryError('INVALID_INPUT');
      this.#intent = { target: { ...target }, selection: chosen.data, reference: ref.data }; this.#emit('initial');
    } catch (error) { this.#emit('error', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async prepare(acknowledgeDelete: boolean, acknowledgeDefault: boolean) {
    if (this.#disposed || this.#phase !== 'initial' || !this.#intent || !acknowledgeDelete) return;
    const intent = this.#intent, revision = ++this.#revision; this.#emit('preparing');
    try {
      const response = await this.#rpc({ protocol: 2, kind: 'prepare', target: intent.target, selection: configSelectionSchema.parse(intent.selection), reference: intent.reference, acknowledgeDelete: true, acknowledgeDefault });
      if (response.kind !== 'confirmation') throw new BoundaryError('STATE_UNAVAILABLE');
      if (this.#disposed || revision !== this.#revision) { this.#release(response.grant); return; }
      const value = response.outcome;
      if (response.grant.id !== value.id || response.grant.serviceGeneration !== intent.target.serviceGeneration || value.serviceGeneration !== intent.target.serviceGeneration || !sameTarget(value.target, intent.target)
        || documentReferenceId(value.reference) !== documentReferenceId(intent.reference) || documentReferenceId(value.inventory.reference) !== documentReferenceId(intent.reference) || value.phase !== 'prepared') {
        this.#release(response.grant); throw new BoundaryError('STALE_TARGET');
      }
      const paths = value.sources.map(source => source.path), selection = intent.selection;
      if ((selection.mode === 'merge' && JSON.stringify(paths) !== JSON.stringify([...new Set(selection.paths)]))
        || (selection.mode === 'file' && paths.length !== 1) || (selection.mode === 'file' && value.contextOrigin !== selection.path)) {
        this.#release(response.grant); throw new BoundaryError('STALE_TARGET');
      }
      this.#outcome = value; this.#grant = response.grant; this.#emit('confirm');
    } catch (error) { if (!this.#disposed && revision === this.#revision) this.#emit('error', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async submit(acknowledgeContents: boolean) {
    if (this.#disposed || this.#phase !== 'confirm' || !this.#grant || !this.#outcome) return;
    const grant = this.#grant, original = this.#outcome, revision = ++this.#revision; this.#emit('submitting');
    try {
      const response = await this.#rpc({ protocol: 2, kind: 'submit', grant, acknowledgeContents });
      if (this.#disposed || revision !== this.#revision) return;
      if (response.kind !== 'outcome' || !same(response.outcome, original)) throw new BoundaryError('OPERATION_UNKNOWN');
      this.#outcome = response.outcome; this.#emit('result');
    } catch { if (!this.#disposed && revision === this.#revision) this.#emit('error', 'OPERATION_UNKNOWN'); } // Never retry a submission automatically.
  }
  async outcomes(older = false) {
    if (this.#disposed) return; const revision = ++this.#historyRevision;
    try {
      const response = await this.#rpc({ protocol: 2, kind: 'outcomes', ...(older && this.#next ? { after: this.#next } : {}) });
      if (this.#disposed || revision !== this.#historyRevision) return;
      if (response.kind !== 'outcomes' || new Set(response.outcomes.map(value => value.id)).size !== response.outcomes.length
        || response.outcomes.some(value => value.serviceGeneration !== response.serviceGeneration || value.target.serviceGeneration !== response.serviceGeneration)) throw new BoundaryError('STATE_UNAVAILABLE');
      const matching = response.outcomes.find(value => value.id === this.#outcome?.id); if (matching && this.#outcome && !same(matching, this.#outcome)) throw new BoundaryError('STALE_TARGET');
      this.#history = response.outcomes; this.#next = response.next; if (matching) this.#outcome = matching; this.#emit(this.#phase);
    } catch (error) { if (!this.#disposed && revision === this.#historyRevision) this.#emit(this.#phase, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  reset() { ++this.#revision; ++this.#historyRevision; this.#release(this.#grant); this.#grant = undefined; this.#intent = undefined; this.#outcome = undefined; this.#emit('idle'); }
  dispose() { this.reset(); this.#disposed = true; ++this.#historyRevision; }
}
