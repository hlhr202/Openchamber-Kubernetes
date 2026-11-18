// WRITE UI controller for file-based delete. Never instantiate/call in automated functional tests.
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { fileDeleteParametersSchema, fileDeleteResponseSchema } from '../shared/file-delete-protocol.ts';
import type { FileDeleteOutcome, FileDeleteRequest, FileDeleteResponse, FileDeleteViewGrant } from '../shared/file-delete-protocol.ts';
import { saveContentSnapshot } from '../shared/save-content.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { configSelectionSchema } from '../shared/configuration.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import type { TargetIdentity } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';
export type FileDeleteState = { readonly phase: 'idle' | 'preparing' | 'confirm' | 'submitting' | 'result' | 'error'; readonly history: readonly FileDeleteOutcome[];
  readonly outcome?: FileDeleteOutcome; readonly expiresAt?: number; readonly next?: string | null; readonly error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
type Confirmation = Extract<FileDeleteResponse, { kind: 'confirmation' }>;
export class FileDeleteClient {
  readonly #request: TreeTransport; readonly #show: (state: FileDeleteState) => void;
  #grant: FileDeleteViewGrant | undefined; #confirmation: Confirmation | undefined; #outcome: FileDeleteOutcome | undefined;
  #history: readonly FileDeleteOutcome[] = []; #next: string | null = null; #phase: FileDeleteState['phase'] = 'idle'; #revision = 0; #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: FileDeleteState) => void) { this.#request = request; this.#show = show; }
  #emit(phase: FileDeleteState['phase'], error?: ErrorCode) {
    this.#phase = phase; if (!this.#disposed) this.#show({ phase, history: this.#history, next: this.#next,
      ...(this.#outcome ? { outcome: this.#outcome } : {}), ...(this.#confirmation ? { expiresAt: this.#confirmation.expiresAt } : {}), ...(error ? { error } : {}) });
  }
  async #rpc(request: FileDeleteRequest): Promise<FileDeleteResponse> {
    if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT');
    const body = JSON.stringify(request); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
    this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/operations/file-delete', body });
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = fileDeleteResponseSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); return parsed.data;
    } finally { this.#calls--; }
  }
  #release(grant: FileDeleteViewGrant | undefined) { if (grant) void this.#rpc({ protocol: 2, kind: 'close', grant }).catch(() => {}); }
  async prepare(target: TargetIdentity | undefined, selection: ConfigSelection, file: { root: string; path: string; version: string; identity: string; proof: string } | undefined, text: string) {
    if (this.#disposed || this.#phase === 'submitting') return;
    this.reset(); const revision = ++this.#revision, current = () => !this.#disposed && revision === this.#revision;
    this.#emit('preparing');
    try {
      if (!target || !file) throw new BoundaryError('INVALID_INPUT');
      const snapshot = saveContentSnapshot(text); try { if (snapshot.digest !== file.identity) throw new BoundaryError('CONFLICT'); } finally { snapshot.bytes.fill(0); }
      const parameters = fileDeleteParametersSchema.parse({ file: { root: file.root, path: file.path, version: file.version, identity: file.identity, format: file.path.endsWith('.json') ? 'json' : 'yaml' }, sourceDigest: file.identity });
      const opened = await this.#rpc({ protocol: 2, kind: 'open', target, selection: configSelectionSchema.parse(selection) });
      if (opened.kind !== 'view' || opened.grant.serviceGeneration !== target.serviceGeneration) throw new BoundaryError('STALE_TARGET');
      if (!current()) { this.#release(opened.grant); return; } this.#grant = opened.grant;
      const result = await this.#rpc({ protocol: 2, kind: 'prepare', grant: opened.grant, parameters, fileProof: file.proof });
      if (!current()) return;
      if (result.kind !== 'confirmation' || !sameTarget(result.outcome.target, target) || !result.outcome.reference
        || result.outcome.owner !== opened.grant.id || result.outcome.phase !== 'prepared') throw new BoundaryError('STALE_TARGET');
      this.#confirmation = result; this.#outcome = result.outcome; this.#emit('confirm');
    } catch (error) { if (current()) this.#emit('error', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async submit() {
    if (this.#disposed || this.#phase !== 'confirm' || !this.#grant || !this.#confirmation) return;
    const grant = this.#grant, confirmation = this.#confirmation, revision = ++this.#revision;
    this.#emit('submitting');
    try {
      const result = await this.#rpc({ protocol: 2, kind: 'submit', grant, id: confirmation.outcome.id, proof: confirmation.proof, confirmation: 'file-delete-exact-pinned-object' });
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
