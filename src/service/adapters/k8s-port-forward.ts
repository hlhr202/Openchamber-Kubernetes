// Operation adapter. Never imported or invoked by automatic functional tests.
// Each explicit local TCP connection gets its own legacy v4 Kubernetes stream.
// This is not an Exec channel, a server-side shell or a public listener.
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { channelFrame, parseChannelFrame } from '../../shared/k8s-websocket-protocol.ts';
import { ForwardChannelDecoder, forwardWebsocketProtocols, sessionQuery } from '../../shared/session-wire.ts';
import { openK8sWebsocket } from './k8s-websocket.ts';
import type { OnceConnection } from './https-once.ts';
type Connection = Awaited<ReturnType<typeof openK8sWebsocket>>;
export async function openK8sPortForward(options: {
  path: string; ports: readonly { local: number; remote: number }[]; signal: AbortSignal;
  transport(signal: AbortSignal): Promise<OnceConnection>;
  verify(signal: AbortSignal): Promise<void>;
  error(code: ErrorCode): void;
  ended(code: ErrorCode): void;
}) {
  const servers: Server[] = [], sockets = new Set<Socket>(), connections = new Set<Connection>();
  const lifetime = new AbortController(); let closed = false, active = 0;
  const close = () => {
    if (closed) return; closed = true; lifetime.abort();
    options.signal.removeEventListener('abort', close);
    for (const server of servers) server.close();
    for (const socket of sockets) socket.destroy();
    for (const connection of connections) connection.close();
    sockets.clear(); connections.clear();
  };
  options.signal.addEventListener('abort', close, { once: true });
  if (options.signal.aborted) { close(); throw new BoundaryError('QUERY_CANCELLED'); }
  const create = async (remote: number, socket?: Socket) => {
    const decoder = new ForwardChannelDecoder(remote), pending: Uint8Array[] = [];
    let pendingBytes = 0, ended = false, peer = socket;
    const transport = await options.transport(lifetime.signal);
    let connection: Connection;
    try {
      connection = await openK8sWebsocket(transport, options.path, sessionQuery('port-forward', undefined, [], [{ remote }]), lifetime.signal, frame => {
        const channel = parseChannelFrame(frame.payload); if (!channel) throw new BoundaryError('CONTENT_INVALID');
        const next = decoder.accept(channel.channel, channel.payload);
        if (next.kind === 'error') throw new BoundaryError('REMOTE_FORWARD_FAILED');
        if (next.kind !== 'data') return;
        if (peer) {
          if (peer.destroyed || peer.writableLength + next.payload.length > 262_144) throw new BoundaryError('BUDGET_EXCEEDED');
          peer.write(next.payload);
        } else {
          pendingBytes += next.payload.length; if (pendingBytes > 262_144) throw new BoundaryError('BUDGET_EXCEEDED');
          pending.push(next.payload.slice());
        }
      }, { protocols: forwardWebsocketProtocols, onClose: error => {
        ended = true; peer?.destroy();
        if (connection) connections.delete(connection);
        if (!closed && error) options.error(error);
      } });
    } finally { transport.ca?.fill(0); }
    if (closed || ended) { connection.close(); throw new BoundaryError('SESSION_DISCONNECTED'); }
    connections.add(connection);
    return {
      attach(value: Socket) {
        peer = value;
        for (const part of pending) value.write(part);
        pending.length = 0; pendingBytes = 0;
      },
      connection,
      get ended() { return ended; },
      release() { connections.delete(connection); connection.close(); },
    };
  };
  try {
    // Reserve loopback ports before opening any upstream sockets. EADDRINUSE
    // must reject admission, not crash the service asynchronously after success.
    for (const port of options.ports) {
      const server = createServer(); servers.push(server);
      const rejectEarly = (socket: Socket) => socket.destroy(); server.on('connection', rejectEarly);
      await new Promise<void>((resolve, reject) => {
        const clean = () => { clearTimeout(timer); server.removeListener('error', failed); lifetime.signal.removeEventListener('abort', cancelled); };
        const cancelled = () => { clean(); reject(new BoundaryError('QUERY_CANCELLED')); };
        const failed = (error: NodeJS.ErrnoException) => { clean(); reject(new BoundaryError(error.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'STATE_UNAVAILABLE')); };
        const timer = setTimeout(() => { clean(); reject(new BoundaryError('QUERY_TIMEOUT')); }, 5000);
        lifetime.signal.addEventListener('abort', cancelled, { once: true });
        server.once('error', failed);
        if (lifetime.signal.aborted) { cancelled(); return; }
        server.listen(port.local, '127.0.0.1', () => { clean(); resolve(); });
      });
      server.on('error', () => { if (!closed) { options.ended('SESSION_DISCONNECTED'); close(); } });
      let reserved: Awaited<ReturnType<typeof create>> | undefined = await create(port.remote);
      server.removeListener('connection', rejectEarly);
      server.on('connection', socket => {
        if (closed || active >= 8 || socket.remoteAddress !== '127.0.0.1') { socket.destroy(); return; }
        active++; sockets.add(socket); socket.pause();
        socket.on('error', () => socket.destroy());
        let stream: Awaited<ReturnType<typeof create>> | undefined;
        socket.once('close', () => { sockets.delete(socket); active--; stream?.release(); });
        void (async () => {
          await options.verify(lifetime.signal);
          if (socket.destroyed || closed) return;
          if (reserved && !reserved.ended) { stream = reserved; reserved = undefined; stream.attach(socket); }
          else {
            reserved?.release(); reserved = undefined;
            // A new explicit TCP connection is not a retry of an old stream.
            stream = await create(port.remote, socket);
          }
          if (socket.destroyed || closed) { stream.release(); return; }
          socket.on('data', (data: Buffer) => {
            try {
              for (let offset = 0; offset < data.length; offset += 65_536) stream?.connection.send(channelFrame(0, data.subarray(offset, offset + 65_536)));
            } catch (error) { options.error(error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); socket.destroy(); }
          });
          socket.resume();
        })().catch(error => { if (!closed) options.error(error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); socket.destroy(); });
      });
    }
    return { close, forwarded: options.ports.map(port => ({ ...port })) };
  } catch (error) { close(); throw error; }
}
