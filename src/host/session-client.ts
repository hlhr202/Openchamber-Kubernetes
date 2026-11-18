// M5 session UI client (Terminal/Exec/PortForward + dashboard proxy). One explicit open per
// session, capability-held poll/io like the watch model; no auto reconnect, no submit replay.
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { configSelectionSchema } from '../shared/configuration.ts';
import type { TargetIdentity } from '../shared/identity.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';
import type { SessionOpenTarget } from '../shared/session-target.ts';
import type { SessionTarget } from '../shared/session-registry.ts';
import { sessionPublicTargetSchema } from '../shared/session-target.ts';
import { sessionProxyResponseBytes } from '../shared/session-wire.ts';
import { appendSessionOutput } from '../shared/session-terminal-output.ts';
import { samePresentation } from '../shared/presentation-state.ts';
export type SessionClientState = { readonly phase: 'idle' | 'opening' | 'ready' | 'error'; readonly error?: ErrorCode;
  readonly id?: string; readonly kind?: 'terminal' | 'exec' | 'port-forward'; readonly detached?: boolean; readonly closed?: boolean; readonly inputBlocked?: boolean; readonly controlSuspended?: boolean;
  readonly exitCode?: number | null; readonly exitMessage?: string | null; readonly output: string; readonly outputStart?: number; readonly dropped: boolean; readonly forwarded?: readonly { local: number; remote: number }[]; readonly target?: SessionTarget; readonly preview?: string; readonly scope?: TargetIdentity; readonly controlRevoked?: boolean };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class SessionClient {
  readonly #request: TreeTransport; readonly #show: (state: SessionClientState) => void;
  #capability: string | undefined; #id: string | undefined; #calls = 0; #revision = 0; #disposed = false;
  #output = ''; #dropped = false;
  #kind: SessionClientState['kind']; #detached = false; #closed = false; #opening = false; #openUnknown = false;
  #forwarded: SessionClientState['forwarded'];
  #target: SessionTarget | undefined; #stdoutDecoder = new TextDecoder(); #stderrDecoder = new TextDecoder();
  #preview: string | undefined;
  #scope: TargetIdentity | undefined; #controlRevoked = false;
  #cancelPoll: (() => void) | undefined; #polling = false;
  #tailPending = false; #controlRevision = 0;
  #closing = false;
  #outputStart = 0; #inputTail: Promise<boolean> = Promise.resolve(true); #inputBytes = 0; #inputJobs = 0; #inputBlocked = false; #inputError: ErrorCode | undefined;
  #available = true; #phase: SessionClientState['phase'] = 'idle'; #lastError: ErrorCode | undefined;
  #lastPresentation: SessionClientState | undefined;
  #exitCode: number | null | undefined; #exitMessage: string | null | undefined;
  availability(value: boolean) {
    if (this.#available === value) return;
    this.#available = value;
    if (this.#id) this.#emit(this.#phase, {}, this.#lastError);
  }
  #forget() {
    this.#id = undefined; this.#capability = undefined; this.#kind = undefined; this.#forwarded = undefined; this.#target = undefined;
    this.#preview = undefined; this.#detached = false; this.#closed = false;
    this.#scope = undefined; this.#controlRevoked = false;
    this.#tailPending = false;
  }
  observeScope(target: TargetIdentity | undefined): void {
    if (!this.#id || !this.#capability || !this.#scope || this.#controlRevoked || target && sameTarget(target, this.#scope)) return;
    this.#controlRevoked = true; ++this.#controlRevision; this.#cancelPoll?.(); this.#cancelPoll = undefined; this.#emit('error', {}, 'STALE_TARGET');
    const id = this.#id, capability = this.#capability;
    // Genuine config/target revocation only. Viewer/project navigation never
    // calls this path. Close owned local resources; do not claim remote undo.
    void this.#rpc({ protocol: 1, kind: 'close', id, capability, reason: 'scope-changed' }).then(() => {
      if (this.#id !== id || this.#disposed) return;
      this.#closed = true; this.#emit('ready', {}, 'STALE_TARGET');
    }).catch(() => { if (this.#id === id) this.#emit('error', {}, 'OPERATION_UNKNOWN'); });
  }
  #schedulePoll() {
    this.#cancelPoll?.(); this.#cancelPoll = undefined;
    if (this.#disposed || !this.#id || this.#closing || (this.#closed && !this.#tailPending) || this.#detached || this.#controlRevoked) return;
    const timer = setTimeout(() => { this.#cancelPoll = undefined; void this.poll(false); }, 500);
    this.#cancelPoll = () => clearTimeout(timer);
  }
  constructor(request: TreeTransport, show: (state: SessionClientState) => void) { this.#request = request; this.#show = show; }
  #emit(phase: SessionClientState['phase'], extra: Partial<SessionClientState> = {}, error?: ErrorCode) {
    if (this.#disposed) return;
    this.#phase = phase; this.#lastError = error;
    if (extra.exitCode !== undefined) this.#exitCode = extra.exitCode;
    if (extra.exitMessage !== undefined) this.#exitMessage = extra.exitMessage;
    const state: SessionClientState = { phase, output: this.#output, outputStart: this.#outputStart, dropped: this.#dropped,
      ...(this.#id ? { id: this.#id, ...(this.#kind ? { kind: this.#kind } : {}), detached: this.#detached, closed: this.#closed } : {}),
      ...(this.#forwarded ? { forwarded: this.#forwarded } : {}), ...(this.#target ? { target: this.#target } : {}),
      ...(this.#scope ? { scope: this.#scope } : {}), ...(this.#controlRevoked ? { controlRevoked: true } : {}),
      ...(this.#inputBlocked ? { inputBlocked: true } : {}),
      ...(this.#exitCode !== undefined ? { exitCode: this.#exitCode } : {}), ...(this.#exitMessage !== undefined ? { exitMessage: this.#exitMessage } : {}),
      ...(!this.#available ? { controlSuspended: true } : {}),
      ...(this.#preview !== undefined ? { preview: this.#preview } : {}), ...extra,
      ...(this.#openUnknown ? { error: 'OPERATION_UNKNOWN' as const } : this.#inputBlocked && this.#inputError ? { error: this.#inputError } : error ? { error } : {}) };
    if (samePresentation(this.#lastPresentation, state)) return;
    this.#lastPresentation = state; this.#show(state);
  }
  async #rpc(request: unknown): Promise<unknown> {
    if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT');
    const body = JSON.stringify(request); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
    this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/sessions/handle', body });
      const maximum = typeof request === 'object' && request !== null && (request as { kind?: unknown }).kind === 'proxy' ? sessionProxyResponseBytes : 512_000;
      if (utf8ByteLength(response.body) > maximum) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      return value;
    } finally { this.#calls--; }
  }
  reject(error: ErrorCode): Promise<void> { this.#emit('error', {}, this.#openUnknown ? 'OPERATION_UNKNOWN' : error); return Promise.resolve(); }
  async open(target: TargetIdentity | undefined, selection: ConfigSelection, session: SessionOpenTarget,
    kind: 'terminal' | 'exec' | 'port-forward', options: { command?: readonly string[]; ports?: readonly { local: number; remote: number }[] } = {}) {
    if (this.#disposed || this.#capability || this.#opening || this.#openUnknown) return;
    this.#opening = true;
    const revision = ++this.#revision, current = () => !this.#disposed && revision === this.#revision;
    this.#exitCode = undefined; this.#exitMessage = undefined;
    this.#output = ''; this.#outputStart = 0; this.#inputBlocked = false; this.#inputError = undefined; this.#preview = undefined; this.#dropped = false; this.#stdoutDecoder = new TextDecoder(); this.#stderrDecoder = new TextDecoder(); this.#emit('opening');
    try {
      if (!target) throw new BoundaryError('INVALID_INPUT');
      const value = await this.#rpc({ protocol: 1, kind: 'open', selection: configSelectionSchema.parse(selection), target,
        ...('original' in session ? { original: session.original } : { session: { ...session } }),
        sessionKind: kind, ...(options.command ? { command: options.command } : {}), ...(options.ports ? { ports: options.ports } : {}) });
      const opened = z.object({ protocol: z.literal(1), kind: z.literal('session'), session: z.object({ id: z.string().uuid(), closed: z.boolean(), target: sessionPublicTargetSchema }).passthrough(),
        capability: z.string().regex(/^[a-f0-9]{64}$/), forwarded: z.array(z.object({ local: z.number(), remote: z.number() })).optional() }).strict().parse(value);
      if (!current()) { void this.#rpc({ protocol: 1, kind: 'close', id: opened.session.id, capability: opened.capability, reason: 'superseded' }).catch(() => {}); return; }
      this.#id = opened.session.id; this.#capability = opened.capability;
      this.#kind = kind; this.#detached = false; this.#closed = opened.session.closed; this.#forwarded = opened.forwarded;
      this.#scope = { ...target }; this.#controlRevoked = false;
      const pinned = opened.session.target;
      this.#target = { namespace: pinned.namespace, podName: pinned.podName, podUid: pinned.podUid,
        ...(pinned.container ? { container: pinned.container } : {}), ...(pinned.original ? { original: pinned.original } : {}) };
      this.#emit('ready', { id: opened.session.id, kind, ...(opened.forwarded ? { forwarded: opened.forwarded } : {}) });
      // Even already-ended Exec gets an original-result read. No new execution.
      await this.poll(false);
    } catch (error) {
      if (current()) {
        const code = error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE';
        this.#openUnknown = ['STATE_UNAVAILABLE', 'QUERY_TIMEOUT', 'QUERY_CANCELLED', 'OPERATION_UNKNOWN',
          'SESSION_DISCONNECTED', 'WEBSOCKET_UPGRADE_FAILED', 'BUDGET_EXCEEDED'].includes(code);
        this.#emit('error', {}, this.#openUnknown ? 'OPERATION_UNKNOWN' : code);
      }
    } finally { this.#opening = false; }
  }
  async write(input: string, size?: { columns: number; rows: number }) {
    if (this.#disposed || !this.#id || !this.#capability || !this.#available || this.#closing || this.#closed || this.#detached || this.#controlRevoked || this.#kind !== 'terminal') return false;
    const bytes = new TextEncoder().encode(input), id = this.#id, capability = this.#capability, revision = this.#controlRevision;
    if ((!bytes.length && !size) || bytes.length > 16_384 || this.#inputBytes + bytes.length > 32_768 || this.#inputJobs >= 64) {
      this.#inputBlocked = true; this.#inputError = 'BUDGET_EXCEEDED';
      return this.reject('BUDGET_EXCEEDED').then(() => false);
    }
    this.#inputBytes += bytes.length; this.#inputJobs++;
    // Keystrokes, paste and explicit resize share ONE ordered bounded queue.
    // A failed write is never replayed; pending input stops on unknown outcome.
    const result = this.#inputTail.then(async () => {
      try {
        if (!this.#available || this.#inputBlocked || this.#id !== id || this.#controlRevision !== revision || this.#closed || this.#closing || this.#controlRevoked || this.#detached) return false;
        for (let offset = 0; offset < Math.max(1, bytes.length); offset += 4096) {
          if (!this.#available || this.#inputBlocked || this.#id !== id || this.#controlRevision !== revision || this.#closed || this.#closing || this.#controlRevoked || this.#detached) return false;
          const chunk = bytes.subarray(offset, offset + 4096);
          await this.#rpc({ protocol: 1, kind: 'io', id, capability,
            ...(chunk.length ? { input: btoa(String.fromCharCode(...chunk)) } : {}),
            ...(size && offset === 0 ? { columns: size.columns, rows: size.rows } : {}) });
        }
        return true;
      } catch (error) {
        const code = error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE';
        this.#inputBlocked = true; this.#inputError = code;
        const unknown = ['STATE_UNAVAILABLE', 'QUERY_TIMEOUT', 'QUERY_CANCELLED', 'OPERATION_UNKNOWN', 'SESSION_DISCONNECTED'].includes(code);
        if (unknown) this.#openUnknown = true;
        this.#emit('error', {}, unknown ? 'OPERATION_UNKNOWN' : code);
        return false;
      } finally { this.#inputBytes -= bytes.length; this.#inputJobs--; }
    });
    this.#inputTail = result;
    return result;
  }
  async poll(renew = true) {
    if (this.#disposed || !this.#id || !this.#capability || this.#closing || this.#polling) return;
    const id = this.#id, controlRevision = this.#controlRevision;
    this.#polling = true;
    try {
      const value = await this.#rpc({ protocol: 1, kind: 'poll', id: this.#id, capability: this.#capability, renew: renew && !this.#controlRevoked });
      if (this.#disposed || this.#id !== id || this.#controlRevoked) return;
      const parsed = z.object({ protocol: z.literal(1), kind: z.literal('output'), session: z.object({ detached: z.boolean(), closed: z.boolean() }).passthrough(),
        stdout: z.object({ data: z.string(), bytes: z.number() }), stderr: z.object({ data: z.string(), bytes: z.number() }), dropped: z.boolean(),
        exitCode: z.number().int().nullable(), exitMessage: z.string().max(256).nullable(), exitSeen: z.boolean(), pending: z.boolean().optional(), error: z.enum(errorCodes).optional() }).strict().parse(value);
      const decode = (data: string, decoder: { decode(input: Uint8Array, options: { stream: boolean }): string }) => { const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0)); return decoder.decode(bytes, { stream: !parsed.session.closed || parsed.pending === true }); };
      const output = appendSessionOutput(this.#output, this.#outputStart, decode(parsed.stdout.data, this.#stdoutDecoder) + decode(parsed.stderr.data, this.#stderrDecoder));
      this.#output = output.output; this.#outputStart = output.start;
      this.#dropped = this.#dropped || parsed.dropped || output.dropped;
      if (parsed.error === 'OPERATION_UNKNOWN') this.#openUnknown = true;
      this.#tailPending = parsed.pending === true;
      if (controlRevision === this.#controlRevision) this.#detached = parsed.session.detached;
      this.#closed = this.#closed || parsed.session.closed;
      this.#emit('ready', { exitCode: parsed.exitCode, exitMessage: parsed.exitMessage }, parsed.error);
      this.#schedulePoll();
    } catch (error) {
      if (this.#disposed || this.#id !== id || this.#controlRevoked) return;
      const code = error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE';
      if (['SERVICE_CLOSED', 'VIEW_EXPIRED', 'SESSION_DISCONNECTED'].includes(code)) this.#closed = true;
      this.#cancelPoll?.(); this.#cancelPoll = undefined;
      this.#emit('error', {}, code); // No automatic retry/reconnect after a failed poll.
    } finally { this.#polling = false; }
  }
  async detach() {
    if (!this.#id || !this.#capability || this.#closing) return;
    const id = this.#id; ++this.#controlRevision;
    try { await this.#rpc({ protocol: 1, kind: 'detach', id, capability: this.#capability }); if (this.#id !== id || this.#controlRevoked) return; this.#detached = true; this.#cancelPoll?.(); this.#cancelPoll = undefined; this.#emit('ready'); }
    catch (error) { this.#emit('error', {}, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async reattach() {
    if (!this.#available) return this.reject('STATE_UNAVAILABLE');
    if (this.#controlRevoked) return this.reject('STALE_TARGET');
    if (!this.#id || !this.#capability || this.#closing) return;
    const id = this.#id; ++this.#controlRevision;
    try { await this.#rpc({ protocol: 1, kind: 'reattach', id, capability: this.#capability }); if (this.#id !== id || this.#controlRevoked || this.#closed) return; this.#detached = false; this.#emit('ready'); this.#schedulePoll(); }
    catch (error) { this.#emit('error', {}, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async close(reason = 'user') {
    if (!this.#id || !this.#capability || this.#closing) return;
    this.#closing = true;
    ++this.#controlRevision;
    this.#cancelPoll?.(); this.#cancelPoll = undefined;
    const id = this.#id, capability = this.#capability;
    try {
      await this.#rpc({ protocol: 1, kind: 'close', id, capability, reason });
      this.#forget();
      this.#emit('idle');
    } catch (error) {
      if (this.#closed && error instanceof BoundaryError && ['FORBIDDEN', 'VIEW_EXPIRED', 'SERVICE_CLOSED', 'NOT_FOUND'].includes(error.code)) { this.#forget(); this.#emit('idle', {}, error.code); }
      else this.#emit('error', {}, 'OPERATION_UNKNOWN');
    } finally { this.#closing = false; }
  }
  // Approved B-01 remote-web path: one bounded single-shot proxy GET through the service.
  async dashboardProxy(path: string): Promise<string | undefined> {
    if (!this.#available) { this.reject('STATE_UNAVAILABLE'); return undefined; }
    if (this.#controlRevoked) { this.reject('STALE_TARGET'); return undefined; }
    if (this.#disposed || !this.#id || !this.#capability || this.#closing || this.#closed || this.#detached) return undefined;
    const id = this.#id;
    try {
      const value = await this.#rpc({ protocol: 1, kind: 'proxy', id: this.#id, capability: this.#capability, path });
      if (this.#id !== id || this.#controlRevoked || this.#closing || this.#closed || this.#disposed) return undefined;
      const parsed = z.object({ protocol: z.literal(1), kind: z.literal('proxy'), status: z.number(), body: z.string(), code: z.enum(errorCodes).optional() }).strict().parse(value);
      if (parsed.code) throw new BoundaryError(parsed.code);
      if (parsed.status !== 200) throw new BoundaryError(parsed.status === 403 ? 'FORBIDDEN' : parsed.status === 404 ? 'NOT_FOUND' : 'STATE_UNAVAILABLE');
      this.#preview = new TextDecoder().decode(Uint8Array.from(atob(parsed.body), character => character.charCodeAt(0)));
      this.#emit('ready'); return this.#preview;
    } catch (error) { this.#emit('error', {}, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); return undefined; }
  }
  get capability() { return this.#capability; }
  get id() { return this.#id; }
  reset() { void this.close('reset'); }
  dispose() { this.#disposed = true; this.#cancelPoll?.(); this.#cancelPoll = undefined; void this.close('dispose'); }
}
