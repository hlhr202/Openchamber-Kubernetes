// WRITE UI controller for the approved D-02 ApplyFile chain. Never instantiate/call in automated
// functional tests; no constructor action. The client only ever sends the workspace file identity
// plus its ORIGINAL read proof — the exact applied bytes are re-read and pinned server-side.
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { applyFileGateResponseSchema } from '../shared/apply-file-protocol.ts';
import type { ApplyFileOutcome, ApplyFileGateRequest, ApplyFileGateResponse, ApplyFileViewGrant } from '../shared/apply-file-protocol.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { configSelectionSchema } from '../shared/configuration.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import type { TargetIdentity } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';
export type ApplyFileState = { readonly phase: 'idle' | 'preparing' | 'confirm' | 'submitting' | 'result' | 'error'; readonly history: readonly ApplyFileOutcome[];
  readonly outcome?: ApplyFileOutcome; readonly expiresAt?: number; readonly next?: string | null; readonly error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
// Browser SubtleCrypto digest of the exact editor/workspace text (async, host-side only).
export async function applyFileSourceDigest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
type Confirmation = Extract<ApplyFileGateResponse, { kind: 'confirmation' }>;
export class ApplyFileClient {
  readonly #request: TreeTransport; readonly #show: (state: ApplyFileState) => void;
  #grant: ApplyFileViewGrant | undefined; #confirmation: Confirmation | undefined; #outcome: ApplyFileOutcome | undefined;
  #history: readonly ApplyFileOutcome[] = []; #next: string | null = null; #phase: ApplyFileState['phase'] = 'idle'; #revision = 0; #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: ApplyFileState) => void) { this.#request = request; this.#show = show; }
  #emit(phase: ApplyFileState['phase'], error?: ErrorCode) {
    this.#phase = phase; if (!this.#disposed) this.#show({ phase, history: this.#history, next: this.#next,
      ...(this.#outcome ? { outcome: this.#outcome } : {}), ...(this.#confirmation ? { expiresAt: this.#confirmation.expiresAt } : {}), ...(error ? { error } : {}) });
  }
  async #rpc(request: ApplyFileGateRequest): Promise<ApplyFileGateResponse> {
    if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT');
    const body = JSON.stringify(request); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
    this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/operations/apply-file', body });
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = applyFileGateResponseSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); return parsed.data;
    } finally { this.#calls--; }
  }
  #release(grant: ApplyFileViewGrant | undefined) { if (grant) void this.#rpc({ protocol: 2, kind: 'close', grant }).catch(() => {}); }
  async prepare(target: TargetIdentity | undefined, selection: ConfigSelection, file: { root: string; path: string; version: string; identity: string; format: 'yaml' | 'json'; proof: string } | undefined, text: string) {
    if (this.#disposed || this.#phase === 'submitting') return;
    this.reset(); const revision = ++this.#revision, current = () => !this.#disposed && revision === this.#revision;
    this.#emit('preparing');
    try {
      if (!target || !file) throw new BoundaryError('INVALID_INPUT');
      // Client-side content digest pins the exact editor/workspace text the user saw.
      const sourceDigest = await applyFileSourceDigest(text);
      const opened = await this.#rpc({ protocol: 2, kind: 'open', target, selection: configSelectionSchema.parse(selection) });
      if (opened.kind !== 'view' || opened.grant.serviceGeneration !== target.serviceGeneration) throw new BoundaryError('STALE_TARGET');
      if (!current()) { this.#release(opened.grant); return; } this.#grant = opened.grant;
      const result = await this.#rpc({ protocol: 2, kind: 'prepare', grant: opened.grant,
        file: { root: file.root, path: file.path, version: file.version, identity: file.identity, format: file.format }, sourceDigest, fileProof: file.proof });
      if (!current()) return;
      if (result.kind !== 'confirmation' || !sameTarget(result.outcome.target, target) || result.outcome.owner !== opened.grant.id || result.outcome.phase !== 'prepared'
        || result.outcome.parameters.file.path !== file.path || result.outcome.parameters.documents.length < 1) throw new BoundaryError('STALE_TARGET');
      this.#confirmation = result; this.#outcome = result.outcome; this.#emit('confirm');
    } catch (error) { if (current()) this.#emit('error', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async submit() {
    if (this.#disposed || this.#phase !== 'confirm' || !this.#grant || !this.#confirmation) return;
    const grant = this.#grant, confirmation = this.#confirmation, revision = ++this.#revision;
    this.#emit('submitting');
    try {
      const result = await this.#rpc({ protocol: 2, kind: 'submit', grant, id: confirmation.outcome.id, proof: confirmation.proof, confirmation: 'apply-file-exact-documents' });
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
