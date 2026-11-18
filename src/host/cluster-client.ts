// M7 cluster/debug UI client: minikube status probe + G4-gated lifecycle and the debug chain.
// No auto-install, no retry loops, capability-held like the other write clients.
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { configSelectionSchema } from '../shared/configuration.ts';
import type { TargetIdentity } from '../shared/identity.ts';
import { utf8ByteLength } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';
export type ClusterState = { readonly phase: 'idle' | 'preparing' | 'confirm' | 'submitting' | 'result' | 'error'; readonly error?: ErrorCode; readonly debugMessages?: readonly string[];
  readonly outcome?: { id: string; phase: string; code?: string; details?: { output?: string; stage?: string; port?: number; mode?: string } }; readonly statusOutput?: string };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class ClusterClient {
  readonly #request: TreeTransport; readonly #show: (state: ClusterState) => void;
  #grant: unknown; #confirmation: unknown; #calls = 0; #disposed = false; #scope: 'minikube' | 'debug' | undefined; #submitted = false;
  #outcome: ClusterState['outcome']; #statusOutput: string | undefined; #debugMessages: readonly string[] | undefined; #revision = 0;
  constructor(request: TreeTransport, show: (state: ClusterState) => void) { this.#request = request; this.#show = show; }
  #emit(phase: ClusterState['phase'], extra: { outcome?: ClusterState['outcome'] | undefined; statusOutput?: string | undefined; debugMessages?: readonly string[] | undefined } = {}, error?: ErrorCode) {
    if (extra.outcome) this.#outcome = extra.outcome;
    if (extra.statusOutput !== undefined) this.#statusOutput = extra.statusOutput;
    if (extra.debugMessages) this.#debugMessages = extra.debugMessages;
    if (!this.#disposed) this.#show({ phase, ...(this.#outcome ? { outcome: this.#outcome } : {}),
      ...(this.#statusOutput !== undefined ? { statusOutput: this.#statusOutput } : {}),
      ...(this.#debugMessages ? { debugMessages: this.#debugMessages } : {}), ...(error ? { error } : {}) });
  }
  #canPrepare() {
    return !this.#submitted || ['accepted', 'failed', 'cancelled', 'rejected', 'expired'].includes(this.#outcome?.phase ?? '');
  }
  reject(error: ErrorCode) { this.#emit('error', {}, error); }
  invalidateDraft() { if (!this.#submitted) this.reset(); }
  async #rpc(request: unknown): Promise<unknown> {
    if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT');
    const body = JSON.stringify(request); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
    this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/operations/cluster', body });
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      return value;
    } finally { this.#calls--; }
  }
  async minikubeStatus() {
    this.#emit('preparing');
    try {
      const value = await this.#rpc({ protocol: 1, kind: 'minikube-status' });
      const parsed = z.object({ protocol: z.literal(1), kind: z.literal('minikube-status'), output: z.string().max(8_192), exitCode: z.number() }).strict().safeParse(value);
      if (!parsed.success) {
        const code = z.object({ code: z.enum(errorCodes) }).passthrough().safeParse(value);
        return this.#emit('error', {}, code.success ? code.data.code : 'STATE_UNAVAILABLE');
      }
      this.#emit(parsed.data.exitCode === 0 ? 'result' : 'error', { statusOutput: parsed.data.output }, parsed.data.exitCode === 0 ? undefined : 'STATE_UNAVAILABLE');
    } catch (error) { this.#emit('error', {}, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async minikubePrepare(target: TargetIdentity, selection: ConfigSelection, action: 'start' | 'stop', driver?: string) {
    if (!this.#canPrepare()) return this.reject('OPERATION_UNKNOWN');
    const revision = ++this.#revision;
    this.#outcome = undefined; this.#statusOutput = undefined; this.#debugMessages = undefined;
    this.#scope = 'minikube'; this.#submitted = false; this.#grant = undefined; this.#confirmation = undefined;
    this.#emit('preparing');
    try {
      const opened = await this.#rpc({ protocol: 2, kind: 'minikube-open', selection: configSelectionSchema.parse(selection), target });
      if (revision !== this.#revision || this.#disposed) return;
      const grant = z.object({ kind: z.literal('view'), grant: z.object({ capability: z.string() }).passthrough() }).passthrough().parse(opened);
      this.#grant = grant.grant;
      const value = await this.#rpc({ protocol: 2, kind: 'minikube-prepare', grant: this.#grant, action, ...(driver ? { driver } : {}) });
      if (revision !== this.#revision || this.#disposed) return;
      const parsed = z.object({ kind: z.literal('confirmation'), outcome: z.object({ id: z.string().uuid(), phase: z.string() }).passthrough(), proof: z.string(), expiresAt: z.number() }).passthrough().parse(value);
      this.#confirmation = parsed; this.#emit('confirm', { outcome: parsed.outcome as ClusterState['outcome'] });
    } catch (error) { if (revision === this.#revision) this.#emit('error', {}, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async debugPrepare(target: TargetIdentity, selection: ConfigSelection, mode: 'attach' | 'launch', language: string, pod: { namespace: string; name: string; uid: string; resourceVersion: string; container: string }) {
    if (!this.#canPrepare()) return this.reject('OPERATION_UNKNOWN');
    const revision = ++this.#revision;
    this.#outcome = undefined; this.#statusOutput = undefined; this.#debugMessages = undefined;
    this.#scope = 'debug'; this.#submitted = false; this.#grant = undefined; this.#confirmation = undefined;
    this.#emit('preparing');
    try {
      const opened = await this.#rpc({ protocol: 2, kind: 'debug-open', selection: configSelectionSchema.parse(selection), target });
      if (revision !== this.#revision || this.#disposed) return;
      const grant = z.object({ kind: z.literal('view'), grant: z.object({ capability: z.string() }).passthrough() }).passthrough().parse(opened);
      this.#grant = grant.grant;
      const value = await this.#rpc({ protocol: 2, kind: 'debug-prepare', grant: this.#grant, mode, language: z.enum(['node', 'python', 'go', 'dotnet', 'java']).parse(language), pod });
      if (revision !== this.#revision || this.#disposed) return;
      const parsed = z.object({ kind: z.literal('confirmation'), outcome: z.object({ id: z.string().uuid(), phase: z.string() }).passthrough(), proof: z.string(), expiresAt: z.number() }).passthrough().parse(value);
      this.#confirmation = parsed; this.#emit('confirm', { outcome: parsed.outcome as ClusterState['outcome'] });
    } catch (error) { if (revision === this.#revision) this.#emit('error', {}, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async submit() {
    if (!this.#grant || !this.#confirmation || !this.#scope || this.#submitted) return;
    this.#submitted = true;
    const confirmation = this.#confirmation as { outcome: { id: string }; proof: string };
    this.#emit('submitting');
    try {
      const value = await this.#rpc({ protocol: 2, kind: this.#scope === 'debug' ? 'debug-submit' : 'minikube-submit', grant: this.#grant, id: confirmation.outcome.id, proof: confirmation.proof, confirmation: this.#scope === 'debug' ? 'debug-exact-pod-language' : 'minikube-exact-lifecycle' });
      const parsed = z.object({ kind: z.literal('outcome'), outcome: z.object({ id: z.string().uuid(), phase: z.string() }).passthrough() }).passthrough().parse(value);
      this.#emit('result', { outcome: parsed.outcome as ClusterState['outcome'] });
    } catch { this.#emit('error', {}, 'OPERATION_UNKNOWN'); }
  }
  async cancel() {
    if (!this.#grant || !this.#confirmation || this.#submitted || !this.#scope) return;
    const confirmation = this.#confirmation as { outcome: { id: string } };
    try {
      const value = await this.#rpc({ protocol: 2, kind: this.#scope === 'debug' ? 'debug-cancel' : 'minikube-cancel', grant: this.#grant, id: confirmation.outcome.id });
      const parsed = z.object({ kind: z.literal('outcome'), outcome: z.object({ id: z.string().uuid(), phase: z.string() }).passthrough() }).passthrough().parse(value);
      this.#submitted = true; this.#emit('result', { outcome: parsed.outcome as ClusterState['outcome'] });
    } catch (error) { this.#emit('error', {}, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async status() {
    if (!this.#grant || !this.#confirmation || !this.#scope) return this.reject('NOT_FOUND');
    const id = (this.#confirmation as { outcome: { id: string } }).outcome.id;
    try {
      const value = await this.#rpc({ protocol: 2, kind: 'operation-status', scope: this.#scope, grant: this.#grant, id });
      const parsed = z.object({ kind: z.literal('outcome'), outcome: z.object({ id: z.string().uuid(), phase: z.string() }).passthrough() }).passthrough().parse(value);
      this.#emit('result', { outcome: parsed.outcome as ClusterState['outcome'] });
    } catch (error) { this.#emit('error', {}, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async debugRemove(id?: string) {
    const original = id ?? (this.#confirmation as { outcome?: { id?: string } } | undefined)?.outcome?.id;
    if (!this.#grant || !original || this.#scope !== 'debug') return this.reject('NOT_FOUND');
    try { await this.#rpc({ protocol: 2, kind: 'debug-remove', grant: this.#grant, id: original }); this.reset(); }
    catch (error) { this.#emit('error', {}, error instanceof BoundaryError ? error.code : 'OPERATION_UNKNOWN'); }
  }
  async debugSend(command: string, args?: { lines: number[] }) {
    if (!this.#grant || !this.#confirmation || this.#scope !== 'debug') return this.reject('SERVICE_CLOSED');
    const id = (this.#confirmation as { outcome: { id: string } }).outcome.id;
    try { await this.#rpc({ protocol: 2, kind: 'debug-send', grant: this.#grant, id, command, ...(args ? { arguments: args } : {}) }); }
    catch (error) { this.#emit('error', {}, error instanceof BoundaryError ? error.code : 'OPERATION_UNKNOWN'); }
  }
  async debugPoll() {
    if (!this.#grant || !this.#confirmation || this.#scope !== 'debug') return this.reject('SERVICE_CLOSED');
    const id = (this.#confirmation as { outcome: { id: string } }).outcome.id;
    try {
      const value = await this.#rpc({ protocol: 2, kind: 'debug-poll', grant: this.#grant, id });
      const parsed = z.object({ kind: z.literal('debug-messages'), messages: z.array(z.string().max(4_096)).max(16) }).strict().passthrough().parse(value);
      this.#emit('result', { debugMessages: parsed.messages });
    } catch (error) { this.#emit('error', {}, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  reset() { ++this.#revision; this.#grant = undefined; this.#confirmation = undefined; this.#scope = undefined; this.#submitted = false; this.#outcome = undefined; this.#statusOutput = undefined; this.#debugMessages = undefined; this.#emit('idle'); }
  dispose() { this.#disposed = true; this.reset(); }
}
