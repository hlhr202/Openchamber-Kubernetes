// Pure Kubernetes wire values. No connections, execution, authentication or timers.
import { BoundaryError } from './errors.ts';
export const execWebsocketProtocols = ['v5.channel.k8s.io', 'v4.channel.k8s.io'] as const;
// The legacy kubelet binary port-forward protocol is v4, not exec v5.
// Kubernetes v1.35 kubelet/pkg/cri/streaming/portforward/websocket.go.
export const forwardWebsocketProtocols = ['v4.channel.k8s.io'] as const;
export const sessionProxyResponseBytes = 6_000_000; // 4MiB body, base64 plus a small envelope; loopback only.
export function sessionQuery(kind: 'terminal' | 'exec' | 'port-forward', container: string | undefined,
  command: readonly string[] = [], ports: readonly { remote: number }[] = []): [string, string][] {
  if (kind === 'port-forward') {
    if (!ports.length || ports.some(port => !Number.isInteger(port.remote) || port.remote < 1 || port.remote > 65535)) throw new BoundaryError('INVALID_INPUT');
    return ports.map(port => ['ports', String(port.remote)]);
  }
  if (!container || !command.length) throw new BoundaryError('INVALID_INPUT');
  return [['container', container], ['stdin', kind === 'terminal' ? 'true' : 'false'], ['stdout', 'true'],
    ['stderr', kind === 'terminal' ? 'false' : 'true'], ['tty', kind === 'terminal' ? 'true' : 'false'],
    ...command.map(part => ['command', part] as [string, string])];
}
// Channel prefix has already been removed. The first TWO payload bytes on
// both data and error streams announce the port; they can be split across frames.
export class ForwardChannelDecoder {
  readonly #port: number; readonly #prefix = new Map<number, number[]>();
  constructor(port: number) { this.#port = port; }
  accept(channel: number, payload: Uint8Array): { kind: 'announcement' | 'data' | 'error'; payload: Uint8Array } {
    if (channel !== 0 && channel !== 1) throw new BoundaryError('CONTENT_INVALID');
    const prefix = this.#prefix.get(channel) ?? []; let offset = 0;
    while (prefix.length < 2 && offset < payload.length) prefix.push(payload[offset++]!);
    this.#prefix.set(channel, prefix);
    if (prefix.length < 2) return { kind: 'announcement', payload: new Uint8Array() };
    if ((prefix[0]! | prefix[1]! << 8) !== this.#port) throw new BoundaryError('CONTENT_INVALID');
    const body = payload.subarray(offset);
    return { kind: body.length ? channel === 0 ? 'data' : 'error' : 'announcement', payload: body };
  }
}
