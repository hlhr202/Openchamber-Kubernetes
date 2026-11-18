// Real service-side Kubernetes WebSocket client (RFC 6455 upgrade over node:https). Never
// imported, constructed or invoked by automatic functional tests. One socket per session, one
// upgrade request, bounded buffers, no retries, no redirects, abort destroys the owned socket.
// The remote container runtime allocates the PTY: this side only relays bytes and control frames.
import { request as httpsRequest } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { BoundaryError } from '../../shared/errors.ts';
import { decodeServerFrames, encodeClientFrame } from '../../shared/k8s-websocket-protocol.ts';
import type { WebsocketFrame } from '../../shared/k8s-websocket-protocol.ts';
import { execWebsocketProtocols } from '../../shared/session-wire.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import type { OnceConnection } from './https-once.ts';
import { directConnection } from './manifest-apply-https.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';

export async function openK8sWebsocket(transport: OnceConnection, path: string, query: readonly [string, string][], signal: AbortSignal,
  onFrame: (frame: WebsocketFrame) => void, options: { protocols?: readonly string[]; onClose?: (error?: ErrorCode) => void } = {}): Promise<{ readonly close: () => void; readonly send: (frame: Uint8Array) => void; readonly opened: boolean }> {
  if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
  const url = new URL(path, transport.server);
  for (const [name, value] of query) url.searchParams.append(name, value);
  const key = randomBytes(16).toString('base64');
  const protocols = options.protocols ?? execWebsocketProtocols;
  return new Promise((resolve, reject) => {
    let settled = false, socket0: Socket | undefined, notified = false, closing = false, finished = false;
    const request = httpsRequest(url, { method: 'GET', agent: false, rejectUnauthorized: true, maxHeaderSize: 16_384,
      ...(transport.ca ? { ca: transport.ca } : {}),
      headers: { Authorization: `Bearer ${transport.token}`, Connection: 'Upgrade', Upgrade: 'websocket',
         'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Protocol': protocols.join(', '),
        'Accept-Encoding': 'identity' } });
    const finish = (error?: ErrorCode) => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      socket0?.destroy(); request.destroy();
      if (!settled) { settled = true; reject(new BoundaryError(error ?? 'WEBSOCKET_UPGRADE_FAILED')); }
      else if (!notified) { notified = true; options.onClose?.(error); }
    };
    // No HTTP response does NOT prove that the upstream never executed Exec.
    const timer = setTimeout(() => finish('OPERATION_UNKNOWN'), 7000);
    const abort = () => finish('OPERATION_UNKNOWN');
    signal.addEventListener('abort', abort, { once: true });
    request.once('error', () => { if (!settled) finish('OPERATION_UNKNOWN'); });
    request.once('response', response => {
      const status = response.statusCode;
      if (status === 401) transport.credentialsRejected?.();
      response.destroy();
      finish(status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND'
        : status === 400 || status === 426 ? 'WEBSOCKET_UPGRADE_FAILED' : 'OPERATION_UNKNOWN');
    });
    request.once('upgrade', (response: IncomingMessage, socket: Socket, head: Buffer) => {
      if (finished) { socket.destroy(); return; }
      socket0 = socket;
      clearTimeout(timer);
      const protocol = response.headers['sec-websocket-protocol'];
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      if (response.statusCode !== 101 || typeof protocol !== 'string' || !protocols.includes(protocol)
        || response.headers['sec-websocket-accept'] !== accept || response.headers['sec-websocket-extensions']) {
        finish('OPERATION_UNKNOWN'); return;
      }
      let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
      let fragments: Uint8Array[] = [], fragmentBytes = 0;
      const receive = (chunk: Buffer) => {
        if (signal.aborted) { finish('QUERY_CANCELLED'); return; }
        if (buffer.length + chunk.length > 4_194_318) { finish('BUDGET_EXCEEDED'); return; }
        const merged = new Uint8Array(buffer.length + chunk.length);
        merged.set(buffer); merged.set(chunk, buffer.length);
        try {
          const decoded = decodeServerFrames(merged);
          buffer = decoded.remainder;
          for (const frame of decoded.frames) {
            if (frame.opcode >= 8) {
              if (!frame.fin || frame.payload.length > 125) throw new BoundaryError('CONTENT_INVALID');
              if (frame.opcode === 8) { closing = true; finish(); return; }
              if (frame.opcode === 9) socket.write(encodeClientFrame({ fin: true, opcode: 10, payload: frame.payload, maskKey: randomBytes(4) }));
              else if (frame.opcode !== 10) throw new BoundaryError('CONTENT_INVALID');
              continue;
            }
            if (frame.opcode === 2 && !fragments.length && frame.fin) { onFrame(frame); continue; }
            if ((frame.opcode !== 0 && frame.opcode !== 2) || (frame.opcode === 0 && !fragments.length) || (frame.opcode === 2 && fragments.length)) throw new BoundaryError('CONTENT_INVALID');
            fragments.push(frame.payload); fragmentBytes += frame.payload.length;
            if (fragmentBytes > 4_194_304) throw new BoundaryError('BUDGET_EXCEEDED');
            if (frame.fin) {
              const payload = new Uint8Array(fragmentBytes); let offset = 0;
              for (const part of fragments) { payload.set(part, offset); offset += part.length; }
              fragments = []; fragmentBytes = 0; onFrame({ fin: true, opcode: 2, payload });
            }
          }
        } catch (error) { finish(error instanceof BoundaryError ? error.code : 'CONTENT_INVALID'); }
      };
      socket.on('data', receive);
      socket.once('error', () => finish('SESSION_DISCONNECTED'));
      socket.once('close', () => { if (!notified) finish(closing ? undefined : 'SESSION_DISCONNECTED'); });
      if (!settled) {
        settled = true;
        resolve({
          opened: true,
           send: (frame: Uint8Array) => {
             if (socket.destroyed || signal.aborted) throw new BoundaryError('SESSION_DISCONNECTED');
             if (frame.length > 1_048_576 || socket.writableLength + frame.length > 1_048_576) { finish('BUDGET_EXCEEDED'); throw new BoundaryError('BUDGET_EXCEEDED'); }
             socket.write(encodeWire(frame));
           },
           close: () => { closing = true; finish(); },
        });
      }
      if (head.length) receive(head);
    });
    if (signal.aborted) { abort(); return; }
    request.end();
  });
}
// Client frames are masked with a fresh random key per frame.
function encodeWire(payload: Uint8Array): Buffer {
  const frame = encodeClientFrame({ fin: true, opcode: 2, payload, maskKey: randomBytes(4) });
  return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
}
export async function websocketTransport(config: ReturnType<typeof createConfigReader>, input: { target: TargetIdentity; selection: ConfigSelection }, signal: AbortSignal) {
  return directConnection(config, input, signal);
}
