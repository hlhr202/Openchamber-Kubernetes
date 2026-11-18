// M5 session service: Terminal / Exec / Port Forward over the real K8s WebSocket subprotocol
// plus the approved B-01 bounded dashboard proxy. WRITE/session surface: never imported or
// invoked by automated functional tests. Poll-based I/O (the watch model): every request
// re-authorizes the capability; only explicit activity renews the lease. Capacity is reserved
// before upstream effects, fast completions retain their original result, and nothing retries.
import { get as httpGet } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { SessionRegistry, sessionLimits } from '../../shared/session-registry.ts';
import type { SessionKind, SessionState } from '../../shared/session-registry.ts';
import { channelFrame, parseChannelFrame, execChannels, parseExitStatus, resizeFrame } from '../../shared/k8s-websocket-protocol.ts';
import { sessionQuery } from '../../shared/session-wire.ts';
import { openK8sPortForward } from '../adapters/k8s-port-forward.ts';
import { forwardOriginalSchema } from '../queries/forward-target.ts';
import { sessionIdentifier } from '../../shared/session-identifier.ts';
import { openK8sWebsocket } from '../adapters/k8s-websocket.ts';
import { websocketTransport } from '../adapters/k8s-websocket.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { bindResourceTarget } from '../queries/resource-target.ts';
import type { createResourceGateway } from '../queries/resource-gateway.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import { configSelectionSchema } from '../../shared/configuration.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { namespaceName, dnsName, boundedName, targetSchema } from '../../shared/identity.ts';

const base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const sessionTargetSchema = z.object({ namespace: namespaceName, pod: dnsName, podUid: boundedName, podResourceVersion: boundedName, container: namespaceName.optional() }).strict();
export const sessionRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(1), kind: z.literal('open'), selection: configSelectionSchema, target: targetSchema, session: sessionTargetSchema.optional(),
    sessionKind: z.enum(['terminal', 'exec', 'port-forward']),
    command: z.array(z.string().max(256)).min(1).max(16).refine(parts => !!parts[0]).optional(),
    ports: z.array(z.object({ local: z.number().int().min(1).max(65535), remote: z.number().int().min(1).max(65535) })).min(1).max(8)
      .refine(ports => new Set(ports.map(port => port.local)).size === ports.length && new Set(ports.map(port => port.remote)).size === ports.length).optional(),
    // Approved batch-8 target union: a Service/Deployment ORIGINAL resolves to its single live
    // backend Pod (fresh uid/rv proofs both sides) before the socket opens; the panel never
    // supplies a fabricated pod for these.
    original: forwardOriginalSchema.optional() }).strict().refine(request => request.sessionKind === 'port-forward'
      ? !!request.ports?.length && (!!request.session !== !!request.original)
      : !!request.session?.container && !request.original && !!request.command?.length),
  z.object({ protocol: z.literal(1), kind: z.literal('io'), id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), input: base64.max(8_192).optional(),
    columns: z.number().int().min(1).max(1000).optional(), rows: z.number().int().min(1).max(1000).optional() }).strict()
    .refine(value => (value.columns === undefined) === (value.rows === undefined) && (value.input !== undefined || value.columns !== undefined)),
  z.object({ protocol: z.literal(1), kind: z.literal('poll'), id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), renew: z.boolean().optional() }).strict(),
  z.object({ protocol: z.literal(1), kind: z.literal('detach'), id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ protocol: z.literal(1), kind: z.literal('reattach'), id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ protocol: z.literal(1), kind: z.literal('close'), id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().max(128).optional() }).strict(),
  z.object({ protocol: z.literal(1), kind: z.literal('list') }).strict(),
  z.object({ protocol: z.literal(1), kind: z.literal('proxy'), id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().max(1024).regex(/^\//) }).strict(),
]);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Buffers = {
  stdout: Uint8Array[]; stderr: Uint8Array[]; stdoutBytes: number; stderrBytes: number; dropped: boolean;
  exitCode: number | null; exitMessage: string | null; exitSeen: boolean;
  close: () => void; send: (frame: Uint8Array) => void;
  forwarded?: { readonly local: number; readonly remote: number }[]; listeners?: { close(): void }[];
  disconnected?: boolean; error?: ErrorCode;
  verifyControl?: (signal: AbortSignal) => Promise<void>;
};
export function createSessionService(options: { serviceGeneration: string; config: ReturnType<typeof createConfigReader>; resources: ReturnType<typeof createResourceGateway> }) {
  const registry = new SessionRegistry();
  const sessions = new Map<string, Buffers>();
  let closed = false, opening = 0;
  const expiry = setInterval(() => {
    for (const id of registry.sweep(Date.now())) { sessions.get(id)?.close(); sessions.delete(id); }
  }, 1000);
  expiry.unref();
  const push = (list: 'stdout' | 'stderr', state: Buffers, chunk: Uint8Array) => {
    const total = list === 'stdout' ? 'stdoutBytes' : 'stderrBytes';
    if (state[total] + chunk.length > sessionLimits.outputBufferBytes) { state.dropped = true; return; }
    state[list].push(chunk); state[total] += chunk.length;
  };
  const decode = (value: string | undefined, limit: number): Buffer | undefined => {
    if (value === undefined) return undefined;
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value || !bytes.length || bytes.length > limit) throw new BoundaryError('INVALID_INPUT');
    return bytes;
  };
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<unknown> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = sessionRequestSchema.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const request = parsed.data;
      const now = Date.now();
      if (request.kind === 'list') return { protocol: 1, kind: 'sessions', sessions: registry.list().map((session: SessionState) => ({ id: session.id, kind: session.kind, target: session.target, detached: session.detached, closed: session.closed, leaseExpiresAt: session.leaseExpiresAt, ...(sessions.get(session.id)?.forwarded ? { forwarded: sessions.get(session.id)!.forwarded } : {}) })), events: registry.events() };
      if (request.kind === 'open') {
        if (opening >= 2) throw new BoundaryError('QUERY_LIMIT');
        opening++;
        try {
        for (const expired of registry.sweep(now)) { sessions.get(expired)?.close(); sessions.delete(expired); }
        const selection = request.selection as ConfigSelection, clusterTarget = request.target as TargetIdentity;
        // Fresh pod proof before any socket opens: the pinned UID must still be the live pod.
        const bound = bindResourceTarget(clusterTarget, await options.config.read(selection, signal), options.serviceGeneration);
        let selected = request.session, forwardPorts = request.ports;
        if (request.original) {
          const resolved = await options.resources.resolveForwardTarget({ selection, target: bound, original: request.original }, signal);
          selected = { namespace: request.original.namespace, pod: resolved.name, podUid: resolved.uid, podResourceVersion: resolved.resourceVersion };
          if (request.original.resource === 'services') forwardPorts = request.ports?.map(port => {
            const matches = resolved.servicePorts?.filter(value => value.service === port.remote) ?? [];
            if (matches.length !== 1) throw new BoundaryError('NOT_FOUND');
            return { local: port.local, remote: matches[0]!.backend };
          });
        }
        if (!selected) throw new BoundaryError('INVALID_INPUT');
        const pod = selected;
        const verify = async (check: AbortSignal) => {
          bindResourceTarget(clusterTarget, await options.config.read(selection, check), options.serviceGeneration);
          if (request.original) {
            const resolved = await options.resources.resolveForwardTarget({ selection, target: bound, original: request.original }, check);
            if (resolved.name !== pod.pod || resolved.uid !== pod.podUid) throw new BoundaryError('STALE_TARGET');
          }
          await options.resources.verifyReference({ selection, target: bound,
            reference: { type: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' }, name: pod.pod, namespace: pod.namespace, uid: pod.podUid, resourceVersion: pod.podResourceVersion } }, check);
        };
        await verify(signal);
        const id = sessionIdentifier(Date.now(), randomBytes(16)), capability = randomBytes(32).toString('hex');
        const buffers: Buffers = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0, dropped: false, exitCode: null, exitMessage: null, exitSeen: false, close: () => {}, send: () => {} };
        buffers.verifyControl = async check => { bindResourceTarget(clusterTarget, await options.config.read(selection, check), options.serviceGeneration); };
        const owner = new AbortController(), cancelOpening = () => owner.abort();
        // Reserve admission synchronously BEFORE any Exec/upgrade/listener effect.
        // The reservation also lets shutdown/expiry abort an opening connection.
        registry.open({ id, kind: request.sessionKind, target: { podName: pod.pod, podUid: pod.podUid, namespace: pod.namespace,
          ...(pod.container ? { container: pod.container } : {}), ...(request.original ? { original: request.original } : {}) },
          owner: bound.projectId, capabilityDigest: digest(capability), now: Date.now() });
        buffers.close = () => owner.abort();
        sessions.set(id, buffers);
        const originalResult = () => {
          try { return { protocol: 1, kind: 'session',
            session: registry.authorize(id, digest(capability), Date.now(), true, false), capability,
            ...(buffers.forwarded ? { forwarded: buffers.forwarded } : {}) }; }
          catch { throw new BoundaryError('OPERATION_UNKNOWN'); }
        };
        signal.addEventListener('abort', cancelOpening, { once: true });
        if (signal.aborted) owner.abort();
        try {
          if (request.sessionKind === 'port-forward') {
            const forward = await openK8sPortForward({
              path: `/api/v1/namespaces/${pod.namespace}/pods/${pod.pod}/portforward`, ports: forwardPorts!, signal: owner.signal,
              transport: check => websocketTransport(options.config, { target: bound, selection }, check), verify,
              error: code => { buffers.error = code; },
              ended: code => { buffers.error = code; buffers.disconnected = true; registry.observeEnded(id, code, Date.now()); },
            });
            buffers.forwarded = request.ports!.map(port => ({ ...port })); buffers.close = () => { owner.abort(); forward.close(); };
          } else {
            const transport = await websocketTransport(options.config, { target: bound, selection }, owner.signal);
            try {
              const connection = await openK8sWebsocket(transport, `/api/v1/namespaces/${pod.namespace}/pods/${pod.pod}/exec`,
                sessionQuery(request.sessionKind, pod.container, request.command), owner.signal, frame => {
                  const channel = parseChannelFrame(frame.payload); if (!channel) throw new BoundaryError('CONTENT_INVALID');
                  if (channel.channel === execChannels.stdout) push('stdout', buffers, channel.payload);
                  else if (channel.channel === execChannels.stderr) push('stderr', buffers, channel.payload);
                  else if (channel.channel === execChannels.error && !buffers.exitSeen) { const status = parseExitStatus(channel.payload); buffers.exitCode = status.exitCode; buffers.exitMessage = status.message; buffers.exitSeen = true; }
                }, { onClose: error => { buffers.disconnected = true; if (error) buffers.error = error;
                  registry.observeEnded(id, error ?? 'remote-ended', Date.now()); } });
              buffers.close = () => { owner.abort(); connection.close(); }; buffers.send = connection.send;
            } finally { transport.ca?.fill(0); }
          }
          // A fast Exec may finish in upgrade head bytes. Return its ORIGINAL
          // capability/result, not a retryable admission failure.
          if (owner.signal.aborted) throw new BoundaryError('OPERATION_UNKNOWN');
          return originalResult();
        } catch (error) {
          owner.abort(); buffers.close();
          const code = error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE';
          if (code === 'OPERATION_UNKNOWN' || buffers.disconnected) {
            buffers.disconnected = true; buffers.error = 'OPERATION_UNKNOWN';
            registry.observeEnded(id, 'OPERATION_UNKNOWN', Date.now());
            return originalResult();
          }
          registry.close(id, digest(capability), 'admission-rejected', Date.now());
          sessions.delete(id);
          throw error;
        }
        finally { signal.removeEventListener('abort', cancelOpening); }
        } finally { opening--; }
      }
      if (request.kind === 'proxy') {
        // Approved B-01 read path: one bounded single-shot HTTP GET against the session's own
        // forwarded local port; <=4MiB body, private loopback response and chunked workspace delivery.
        const session = registry.authorize(request.id, digest(request.capability), now);
        if (session.kind !== 'port-forward') throw new BoundaryError('INVALID_INPUT');
        const buffers = sessions.get(request.id);
        if (!buffers || session.detached || buffers.disconnected) throw new BoundaryError('FORBIDDEN');
        await buffers.verifyControl?.(signal);
        const current = registry.authorize(request.id, digest(request.capability), Date.now(), false, false);
        if (signal.aborted || current.detached || buffers.disconnected || sessions.get(request.id) !== buffers) throw new BoundaryError('STALE_TARGET');
        const port = buffers?.forwarded?.[0]?.local;
        if (!port) throw new BoundaryError('STATE_UNAVAILABLE');
        return await new Promise<{ protocol: number; kind: string; status: number; body: string; code?: ErrorCode }>(resolve => {
          const request0 = httpGet(`http://127.0.0.1:${port}${request.path}`, { timeout: 7000 }, response => {
            if (response.statusCode !== 200 || response.headers.location !== undefined) { response.destroy(); resolve({ protocol: 1, kind: 'proxy', status: response.statusCode ?? 0, body: '' }); return; }
            const chunks: Buffer[] = []; let total = 0;
            response.on('data', (chunk: Buffer) => { total += chunk.length; if (total > 4_194_304) { resolve({ protocol: 1, kind: 'proxy', status: 413, body: '', code: 'BUDGET_EXCEEDED' }); request0.destroy(); } else chunks.push(chunk); });
            response.once('end', () => resolve({ protocol: 1, kind: 'proxy', status: 200, body: Buffer.concat(chunks).toString('base64') }));
          });
          request0.once('error', () => resolve({ protocol: 1, kind: 'proxy', status: 0, body: '' }));
          request0.once('timeout', () => { request0.destroy(); resolve({ protocol: 1, kind: 'proxy', status: 0, body: '' }); });
        });
      }
      const authorize = () => registry.authorize(request.id, digest(request.capability), now);
      if (request.kind === 'io') {
        const session = authorize(), buffers = sessions.get(request.id);
        if (!buffers || session.closed) throw new BoundaryError('SERVICE_CLOSED');
        if (session.kind !== 'terminal' || session.detached || buffers.disconnected) throw new BoundaryError('FORBIDDEN');
        await buffers.verifyControl?.(signal);
        const current = registry.authorize(request.id, digest(request.capability), Date.now(), false, false);
        if (signal.aborted || current.detached || buffers.disconnected || sessions.get(request.id) !== buffers) throw new BoundaryError('STALE_TARGET');
        const input = decode(request.input, 8_192);
        if (input) buffers.send(channelFrame(execChannels.stdin, input));
        if (request.columns && request.rows) buffers.send(resizeFrame(request.columns, request.rows));
        return { protocol: 1, kind: 'accepted' };
      }
      if (request.kind === 'poll') {
        const session = registry.authorize(request.id, digest(request.capability), now, true, request.renew === true), buffers = sessions.get(request.id);
        if (!buffers) {
          if (session.closed) return { protocol: 1, kind: 'output', session, stdout: { data: '', bytes: 0 }, stderr: { data: '', bytes: 0 }, dropped: false, exitCode: null, exitMessage: null, exitSeen: false };
          throw new BoundaryError('NOT_FOUND');
        }
        const drain = (list: 'stdout' | 'stderr') => {
          const chunks: Uint8Array[] = []; let remaining = sessionLimits.outputChunk;
          while (remaining > 0 && chunks.length < 16 && buffers[list].length) {
            const first = buffers[list][0]!, count = Math.min(first.length, remaining);
            chunks.push(first.subarray(0, count)); remaining -= count;
            if (count === first.length) buffers[list].shift(); else buffers[list][0] = first.subarray(count);
          }
          const bytes = list === 'stdout' ? 'stdoutBytes' : 'stderrBytes';
          let size = 0; for (const chunk of chunks) size += chunk.length;
          buffers[bytes] -= size;
          return { data: Buffer.concat(chunks).toString('base64'), bytes: size };
        };
        const stdout = drain('stdout'), stderr = drain('stderr');
        return { protocol: 1, kind: 'output', session: { ...session, closed: session.closed || buffers.disconnected === true }, stdout, stderr,
          pending: buffers.stdoutBytes > 0 || buffers.stderrBytes > 0, dropped: buffers.dropped,
          exitCode: buffers.exitCode, exitMessage: buffers.exitMessage, exitSeen: buffers.exitSeen, ...(buffers.error ? { error: buffers.error } : {}) };
      }
      if (request.kind === 'detach') return { protocol: 1, kind: 'session', session: registry.detach(request.id, digest(request.capability), now) };
      if (request.kind === 'reattach') {
        const current = authorize(), buffers = sessions.get(request.id);
        if (!buffers || buffers.disconnected) throw new BoundaryError('SESSION_DISCONNECTED');
        await buffers.verifyControl?.(signal);
        if (signal.aborted || buffers.disconnected || sessions.get(request.id) !== buffers) throw new BoundaryError('STALE_TARGET');
        const session = registry.reattach(request.id, digest(request.capability), current.target, Date.now());
        return { protocol: 1, kind: 'session', session };
      }
      if (request.kind === 'close') {
        const state = registry.close(request.id, digest(request.capability), request.reason ?? 'user', now);
        const buffers = sessions.get(request.id);
        buffers?.listeners?.forEach(listener => listener.close());
        buffers?.close();
        sessions.delete(request.id);
        return { protocol: 1, kind: 'session', session: state };
      }
      throw new BoundaryError('INVALID_INPUT');
    },
    close(): void {
      closed = true;
      clearInterval(expiry);
      for (const buffers of sessions.values()) { buffers.listeners?.forEach(listener => listener.close()); buffers.close(); }
      sessions.clear();
      registry.closeAll(Date.now(), 'service-close');
    },
    get state() { return { sessions: registry.list().length, closed }; },
    // Stop-gate aggregate: counts only, never session content/targets/capabilities.
    gateStatus() {
      const all = registry.list();
      return { live: all.filter(session => !session.closed && !session.detached).length,
        detached: all.filter(session => !session.closed && session.detached).length,
        closed: all.filter(session => session.closed).length, leases: all.filter(session => !session.closed && session.leaseExpiresAt <= Date.now() + 60_000).length };
    },
  };
}
export type SessionService = ReturnType<typeof createSessionService>;
export type { SessionKind };
export const sessionErrorCode = (code: string): ErrorCode => (['QUERY_LIMIT', 'FORBIDDEN', 'VIEW_EXPIRED', 'STALE_TARGET', 'SERVICE_CLOSED'].includes(code) ? code as ErrorCode : 'STATE_UNAVAILABLE');
