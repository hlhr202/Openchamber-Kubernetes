// Pure RFC 6455 WebSocket frame codec for the Kubernetes subprotocol channels
// (v5.channel.k8s.io / v4.channel.k8s.io). No IO, no sockets: encode/decode pure functions only,
// fully covered by read-only suites; the real connection lives in service adapters.
import { BoundaryError } from './errors.ts';
export const k8sChannelSubprotocols = ['v5.channel.k8s.io', 'v4.channel.k8s.io'] as const;
export type K8sChannelSubprotocol = typeof k8sChannelSubprotocols[number];
// Kubernetes exec channel numbers (SPDY/WebSocket channel protocol contract).
export const execChannels = Object.freeze({ stdin: 0, stdout: 1, stderr: 2, error: 3, resize: 4, close: 255 });
// Portforward: the i-th requested port uses data channel 2i and error channel 2i+1.
export function portForwardChannels(portIndex: number): { readonly data: number; readonly error: number } {
  if (!Number.isInteger(portIndex) || portIndex < 0 || portIndex > 30) throw new BoundaryError('INVALID_INPUT');
  return { data: 2 * portIndex, error: 2 * portIndex + 1 };
}
// The 2-byte little-endian port announcement sent as the FIRST frame on each portforward channel.
export function portAnnouncement(channel: number, port: number): Uint8Array {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BoundaryError('INVALID_INPUT');
  return Uint8Array.from([channel, port & 0xff, (port >> 8) & 0xff]);
}
export function parsePortAnnouncement(payload: Uint8Array): { readonly channel: number; readonly port: number } | undefined {
  if (payload.length !== 3) return undefined;
  const port = payload[1]! | (payload[2]! << 8);
  return port >= 1 && port <= 65535 ? { channel: payload[0]!, port } : undefined;
}
// A channel-prefixed binary payload: channel byte followed by the stream bytes.
export function channelFrame(channel: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(channel) || channel < 0 || channel > 255) throw new BoundaryError('INVALID_INPUT');
  if (payload.length > 1_048_576) throw new BoundaryError('BUDGET_EXCEEDED');
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = channel;
  frame.set(payload, 1);
  return frame;
}
export function parseChannelFrame(frame: Uint8Array): { readonly channel: number; readonly payload: Uint8Array } | undefined {
  if (!frame.length || frame.length > 1_048_577) return undefined;
  return { channel: frame[0]!, payload: frame.subarray(1) };
}
// ---- RFC 6455 framing ----
export const websocketOpcodes = Object.freeze({ continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa });
export type WebsocketFrame = { readonly fin: boolean; readonly opcode: number; readonly payload: Uint8Array };
const mask = (payload: Uint8Array, key: Uint8Array): Uint8Array => {
  const masked = new Uint8Array(payload.length);
  for (let index = 0; index < payload.length; index++) masked[index] = payload[index]! ^ key[index % 4]!;
  return masked;
};
// Client frames MUST be masked; the mask key is supplied (crypto-random at the call site).
export function encodeClientFrame(input: { readonly fin: boolean; readonly opcode: number; readonly payload: Uint8Array; readonly maskKey: Uint8Array }): Uint8Array {
  const { fin, opcode, payload } = input;
  const key = input.maskKey;
  if (key.length !== 4 || !Number.isInteger(opcode) || opcode < 0 || opcode > 0xf) throw new BoundaryError('INVALID_INPUT');
  if (payload.length > 4_194_304) throw new BoundaryError('BUDGET_EXCEEDED');
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length < 65536 ? 4 : 10;
  const frame = new Uint8Array(headerLength + 4 + length);
  frame[0] = (fin ? 0x80 : 0) | opcode;
  if (length < 126) frame[1] = 0x80 | length;
  else if (length < 65536) { frame[1] = 0x80 | 126; frame[2] = length >> 8; frame[3] = length & 0xff; }
  else { frame[1] = 0x80 | 127; let value = length; for (let index = 9; index >= 2; index--) { frame[index] = value & 0xff; value = Math.floor(value / 256); } }
  frame.set(key, headerLength);
  frame.set(mask(payload, key), headerLength + 4);
  return frame;
}
// Incremental server-frame parser: feed bytes, get complete unmasked frames back (server frames
// are never masked; masked server frames are a fixed protocol violation). Buffers the remainder.
export function decodeServerFrames(buffer: Uint8Array): { readonly frames: readonly WebsocketFrame[]; readonly remainder: Uint8Array } {
  const frames: WebsocketFrame[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]!, second = buffer[offset + 1]!;
    const fin = (first & 0x80) !== 0, opcode = first & 0x0f, masked = (second & 0x80) !== 0;
    let length = second & 0x7f, headerLength = 2;
    if (length === 126) { if (offset + 4 > buffer.length) break; length = (buffer[offset + 2]! << 8) | buffer[offset + 3]!; headerLength = 4; }
    else if (length === 127) { if (offset + 10 > buffer.length) break; let value = 0; for (let index = offset + 2; index < offset + 10; index++) value = value * 256 + buffer[index]!; length = value; headerLength = 10; }
    if (masked || length > 4_194_304) throw new BoundaryError('CONTENT_INVALID'); // server frames are unmasked and bounded
    if (offset + headerLength + length > buffer.length) break;
    frames.push({ fin, opcode, payload: buffer.subarray(offset + headerLength, offset + headerLength + length) });
    offset += headerLength + length;
  }
  return { frames, remainder: buffer.subarray(offset) };
}
// Minimal portable UTF-8 (no TextEncoder/TextDecoder dependency in the shared lib target).
function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | code >> 6, 0x80 | code & 63);
    else if (code < 0x10000) bytes.push(0xe0 | code >> 12, 0x80 | code >> 6 & 63, 0x80 | code & 63);
    else bytes.push(0xf0 | code >> 18, 0x80 | code >> 12 & 63, 0x80 | code >> 6 & 63, 0x80 | code & 63);
  }
  return Uint8Array.from(bytes);
}
function utf8Decode(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index]!;
    let length = 1, code = first;
    if (first < 0x80) code = first;
    else if (first < 0xe0) { length = 2; code = first & 0x1f; }
    else if (first < 0xf0) { length = 3; code = first & 0x0f; }
    else { length = 4; code = first & 0x07; }
    for (let offset = 1; offset < length && index + offset < bytes.length; offset++) code = code * 64 + (bytes[index + offset]! & 63);
    result += String.fromCodePoint(code);
    index += length;
  }
  return result;
}
// Terminal resize channel payload (channel 4): {"Width":cols,"Height":rows}.
export function resizeFrame(columns: number, rows: number): Uint8Array {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns > 1000 || rows > 1000) throw new BoundaryError('INVALID_INPUT');
  return channelFrame(execChannels.resize, utf8Encode(JSON.stringify({ Width: columns, Height: rows })));
}
// v5 half-close signal: [255, channel].
export function closeChannelFrame(channel: number): Uint8Array {
  if (!Number.isInteger(channel) || channel < 0 || channel > 255) throw new BoundaryError('INVALID_INPUT');
  return Uint8Array.of(execChannels.close, channel);
}
// Exit status (channel 3): metav1.Status JSON; success is {"status":"Success"}.
export function parseExitStatus(payload: Uint8Array): { readonly exitCode: number | null; readonly message: string | null } {
  let value: unknown;
  try { value = JSON.parse(utf8Decode(payload)) as unknown; } catch { return { exitCode: null, message: null }; }
  if (typeof value !== 'object' || value === null || !('status' in value)) return { exitCode: null, message: null };
  const status = value as { status?: unknown; message?: unknown; details?: { causes?: { reason?: unknown; message?: unknown }[] } };
  if (status.status === 'Success') return { exitCode: 0, message: null };
  const cause = Array.isArray(status.details?.causes) ? status.details?.causes?.find(item => item?.reason === 'ExitCode') : undefined;
  const code = typeof cause?.message === 'string' && /^\d+$/.test(cause.message) ? Number(cause.message) : null;
  return { exitCode: code, message: typeof status.message === 'string' ? status.message.slice(0, 256) : null };
}

// Server-side helpers for the bootstrap test control plane (scripts/bootstrap-cluster):
// unmasked server frame encoding and masked CLIENT frame decoding (the mirror direction of
// decodeServerFrames; used only by the isolated test cluster, never by the plugin itself).
export function encodeServerFrame(input: { readonly fin: boolean; readonly opcode: number; readonly payload: Uint8Array }): Uint8Array {
  const { fin, opcode, payload } = input;
  if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0xf) throw new BoundaryError('INVALID_INPUT');
  if (payload.length > 4_194_304) throw new BoundaryError('BUDGET_EXCEEDED');
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length < 65536 ? 4 : 10;
  const frame = new Uint8Array(headerLength + length);
  frame[0] = (fin ? 0x80 : 0) | opcode;
  if (length < 126) frame[1] = length;
  else if (length < 65536) { frame[1] = 126; frame[2] = length >> 8; frame[3] = length & 0xff; }
  else { frame[1] = 127; let value = length; for (let index = 9; index >= 2; index--) { frame[index] = value & 0xff; value = Math.floor(value / 256); } }
  frame.set(payload, headerLength);
  return frame;
}
export function decodeClientFrames(buffer: Uint8Array): { readonly frames: readonly WebsocketFrame[]; readonly remainder: Uint8Array } {
  const frames: WebsocketFrame[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]!, second = buffer[offset + 1]!;
    const fin = (first & 0x80) !== 0, opcode = first & 0x0f, masked = (second & 0x80) !== 0;
    let length = second & 0x7f, headerLength = 2;
    if (length === 126) { if (offset + 4 > buffer.length) break; length = (buffer[offset + 2]! << 8) | buffer[offset + 3]!; headerLength = 4; }
    else if (length === 127) { if (offset + 10 > buffer.length) break; let value = 0; for (let index = offset + 2; index < offset + 10; index++) value = value * 256 + buffer[index]!; length = value; headerLength = 10; }
    if (!masked || length > 4_194_304) throw new BoundaryError('CONTENT_INVALID'); // client frames MUST be masked
    if (offset + headerLength + 4 + length > buffer.length) break;
    const key = buffer.subarray(offset + headerLength, offset + headerLength + 4);
    const payload = new Uint8Array(length);
    for (let index = 0; index < length; index++) payload[index] = buffer[offset + headerLength + 4 + index]! ^ key[index % 4]!;
    frames.push({ fin, opcode, payload });
    offset += headerLength + 4 + length;
  }
  return { frames, remainder: buffer.subarray(offset) };
}
