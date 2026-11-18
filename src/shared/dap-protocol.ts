// Pure DAP (Debug Adapter Protocol) frame codec: Content-Length JSON-RPC framing per the
// Microsoft DAP specification. No IO — the session bridge owns sockets; read-only suites cover
// every branch. Session-model helpers (request/response/event sequencing) stay pure here too.
import { BoundaryError } from './errors.ts';
export const dapMaxFrameBytes = 1_048_576;
export type DapMessage = { readonly seq: number; readonly type: 'request' | 'response' | 'event'; readonly command: string } & Record<string, unknown>;
// Encode one wire frame: `Content-Length: N\r\n\r\n{json}` (UTF-8, N = body bytes).
export function encodeDapFrame(message: DapMessage): Uint8Array {
  const body = JSON.stringify(message);
  const bytes = new TextEncoderShim().encode(body);
  if (bytes.length > dapMaxFrameBytes) throw new BoundaryError('BUDGET_EXCEEDED');
  const header = `Content-Length: ${bytes.length}\r\n\r\n`;
  const head = new TextEncoderShim().encode(header);
  const frame = new Uint8Array(head.length + bytes.length);
  frame.set(head); frame.set(bytes, head.length);
  return frame;
}
// Incremental frame parser: feed bytes, receive complete messages plus the remainder buffer.
export function decodeDapFrames(buffer: Uint8Array): { readonly messages: readonly DapMessage[]; readonly remainder: Uint8Array } {
  const messages: DapMessage[] = [];
  let offset = 0;
  for (;;) {
    const headerEnd = findHeaderEnd(buffer, offset);
    if (headerEnd < 0) break;
    // The delimiter \r\n\r\n is already proven by findHeaderEnd; the header slice carries at
    // most one trailing \r\n, so match the fixed field without line-ending assumptions.
    const header = ascii(buffer.subarray(offset, headerEnd)).replace(/[\r\n]+$/, '');
    const match = /^Content-Length: (\d+)$/.exec(header);
    if (!match) throw new BoundaryError('CONTENT_INVALID'); // exactly one fixed header, DAP has no others
    const length = Number(match[1]);
    if (!Number.isInteger(length) || length < 0 || length > dapMaxFrameBytes) throw new BoundaryError('CONTENT_INVALID');
    const bodyStart = headerEnd + 4; // \r\n\r\n
    if (buffer.length < bodyStart + length) break;
    let value: unknown;
    try { value = JSON.parse(ascii(buffer.subarray(bodyStart, bodyStart + length))); } catch { throw new BoundaryError('CONTENT_INVALID'); }
    const parsed = dapMessageSchema.safeParse(value);
    if (!parsed.success) throw new BoundaryError('CONTENT_INVALID');
    messages.push(parsed.data);
    offset = bodyStart + length;
  }
  return { messages, remainder: buffer.subarray(offset) };
}
const dapMessageSchema = looseDapMessage();
function looseDapMessage() {
  // Structural validation kept minimal here: seq/type/command presence; the session bridge
  // validates the specific commands it issues.
  const check = (value: unknown): value is DapMessage => typeof value === 'object' && value !== null
    && typeof (value as { seq?: unknown }).seq === 'number' && Number.isInteger((value as { seq: number }).seq)
    && ['request', 'response', 'event'].includes(String((value as { type?: unknown }).type))
    && typeof (value as { command?: unknown }).command === 'string' && (value as { command: string }).command.length > 0;
  return { safeParse: (value: unknown) => ({ success: check(value), data: value as DapMessage }) };
}
function findHeaderEnd(buffer: Uint8Array, offset: number): number {
  for (let index = offset; index + 3 < buffer.length; index++) if (buffer[index] === 13 && buffer[index + 1] === 10 && buffer[index + 2] === 13 && buffer[index + 3] === 10) return index;
  return -1;
}
function ascii(bytes: Uint8Array): string { let result = ''; for (const byte of bytes) result += String.fromCharCode(byte); return result; }
class TextEncoderShim {
  encode(text: string): Uint8Array {
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
}
// Pure response correlation for the bridge: a request seq maps to the response whose
// request_seq matches; events pass through uncorrelated.
export function isDapResponseTo(message: DapMessage, requestSeq: number): boolean {
  return message.type === 'response' && (message as { request_seq?: unknown }).request_seq === requestSeq;
}
// The five launch languages the plugin supports (upstream debugSession providers).
export const dapLanguages = ['node', 'python', 'go', 'dotnet', 'java'] as const;
export type DapLanguage = typeof dapLanguages[number];
// Upstream default attach ports per language (node 9229; others adapter-resolved).
export function defaultDebugPort(language: DapLanguage): number | undefined {
  return language === 'node' ? 9229 : undefined;
}
