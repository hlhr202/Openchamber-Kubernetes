// M7 DAP session bridge: a bounded TCP client to a debug adapter endpoint (the local forwarded
// debug port of the target container), speaking the pure DAP frame codec. Poll-based like the
// M5 sessions; never imported or invoked by automated functional tests.
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import { encodeDapFrame, decodeDapFrames } from '../../shared/dap-protocol.ts';
import type { DapMessage } from '../../shared/dap-protocol.ts';
export const dapBridgeLimits = Object.freeze({ maxBuffered: 256, maxMessageBytes: 1_048_576, connectTimeoutMs: 5_000 });
export type DapBridge = {
  readonly id: string;
  send(message: DapMessage): void;
  drain(): readonly DapMessage[];
  close(): void;
  readonly closed: boolean;
};
export function openDapBridge(host: string, port: number, signal: AbortSignal): Promise<DapBridge> {
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) throw new BoundaryError('INVALID_INPUT');
  return new Promise((resolve, reject) => {
    const socket = connect(port, host);
    const id = randomUUID();
    let settled = false, closed = false;
    const received: DapMessage[] = [];
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    const timer = setTimeout(() => { socket.destroy(); }, dapBridgeLimits.connectTimeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      if (settled) return; settled = true;
      resolve({
        id, closed,
        send: (message: DapMessage) => { if (!socket.destroyed && !closed && !signal.aborted) socket.write(Buffer.from(encodeDapFrame(message))); },
        drain: () => { const drained = received.splice(0, dapBridgeLimits.maxBuffered); return drained; },
        close: () => { closed = true; socket.destroy(); },
      });
    });
    socket.on('data', (chunk: Buffer) => {
      if (signal.aborted || closed) { socket.destroy(); return; }
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer); merged.set(chunk, buffer.length);
      try {
        const decoded = decodeDapFrames(merged);
        buffer = decoded.remainder;
        for (const message of decoded.messages) if (received.length < dapBridgeLimits.maxBuffered) received.push(message);
      } catch { socket.destroy(); } // protocol violation closes the bridge, never a partial read
    });
    socket.once('error', () => { socket.destroy(); if (!settled) { settled = true; clearTimeout(timer); reject(new BoundaryError('STATE_UNAVAILABLE')); } });
    socket.once('close', () => { if (!settled) { settled = true; clearTimeout(timer); reject(new BoundaryError('STATE_UNAVAILABLE')); } });
    const abort = () => socket.destroy();
    signal.addEventListener('abort', abort, { once: true });
  });
}
