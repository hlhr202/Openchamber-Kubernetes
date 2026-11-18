import { hasWellFormedUnicode } from './identity.ts';
import { logBytes } from './pod-log-protocol.ts';
export type LogSgrStyle = { foreground?: string; background?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; inverse?: boolean };
export type LogSgrRun = { start: number; end: number; style: Readonly<LogSgrStyle> };
export type LogSgrText = { text: string; runs: readonly LogSgrRun[] };
export const logSgrRunLimit = 4096, logSgrPagePartLimit = 2048;
export class LogStyleFailure extends Error { readonly code = 'LOG_STYLE_BUDGET'; constructor() { super('LOG_STYLE_BUDGET'); this.name = 'LogStyleFailure'; } }
const palette = Object.freeze(['#000000', '#aa0000', '#00aa00', '#aa5500', '#0000aa', '#aa00aa', '#00aaaa', '#aaaaaa', '#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff']);
function rgb(red: number, green: number, blue: number): string { return `#${[red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('')}`; }
function indexedColor(value: number): string {
  if (value < 16) return palette[value] ?? '#000000';
  if (value >= 232) { const gray = 8 + (value - 232) * 10; return rgb(gray, gray, gray); }
  const index = value - 16, channel = (n: number) => n === 0 ? 0 : 55 + n * 40;
  return rgb(channel(Math.floor(index / 36)), channel(Math.floor(index / 6) % 6), channel(index % 6));
}
function sgr(current: LogSgrStyle, body: string): LogSgrStyle | null {
  if (!/^[\d;]*$/.test(body)) return null;
  const fields = body.split(';'); if (fields.length > 16 || fields.some(value => value.length > 3)) return null;
  const codes = fields.map(value => value === '' ? 0 : Number(value)); let style = { ...current };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) style = {};
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 9) style.strike = true;
    else if (code === 22) { delete style.bold; delete style.dim; }
    else if (code === 23) delete style.italic;
    else if (code === 24) delete style.underline;
    else if (code === 27) delete style.inverse;
    else if (code === 29) delete style.strike;
    else if (code === 39) delete style.foreground;
    else if (code === 49) delete style.background;
    else if (code !== undefined && code >= 30 && code <= 37) style.foreground = indexedColor(code - 30);
    else if (code !== undefined && code >= 90 && code <= 97) style.foreground = indexedColor(code - 90 + 8);
    else if (code !== undefined && code >= 40 && code <= 47) style.background = indexedColor(code - 40);
    else if (code !== undefined && code >= 100 && code <= 107) style.background = indexedColor(code - 100 + 8);
    else if (code === 38 || code === 48) {
      const mode = codes[++i]; let color: string;
      if (mode === 5) { const index = codes[++i]; if (index === undefined || index > 255) return null; color = indexedColor(index); }
      else if (mode === 2) { const red = codes[++i], green = codes[++i], blue = codes[++i]; if (red === undefined || green === undefined || blue === undefined || red > 255 || green > 255 || blue > 255) return null; color = rgb(red, green, blue); }
      else return null;
      if (code === 38) style.foreground = color; else style.background = color;
    } else return null; // No blinking, concealment, URLs, arbitrary CSS, OSC or terminal commands.
  }
  return style;
}
function pushRun(runs: LogSgrRun[], start: number, end: number, style: Readonly<LogSgrStyle>) {
  if (end <= start) return;
  const last = runs.at(-1);
  if (last?.end === start && JSON.stringify(last.style) === JSON.stringify(style)) last.end = end;
  else { if (runs.length >= logSgrRunLimit) throw new LogStyleFailure(); runs.push({ start, end, style }); }
}
// Pure display projection only. Recognized SGR becomes typed styles, never HTML or terminal-parser input.
// Other controls remain in text and MUST still pass logDisplayText at the DOM/copy boundary.
export function parseLogSgr(input: string, enabled = true): LogSgrText {
  if (input.length > logBytes || !hasWellFormedUnicode(input)) throw new LogStyleFailure();
  if (!enabled) return { text: input, runs: input ? [{ start: 0, end: input.length, style: Object.freeze({}) }] : [] };
  const chunks: string[] = [], runs: LogSgrRun[] = []; let style: Readonly<LogSgrStyle> = Object.freeze({}), start = 0, offset = 0;
  function flush(end: number) { if (end <= start) return; const text = input.slice(start, end); chunks.push(text); pushRun(runs, offset, offset + text.length, style); offset += text.length; }
  for (let at = 0; at < input.length; at++) {
    const code = input.charCodeAt(at), introducer = input[at + 1];
    const opaque = code === 27 && (introducer === ']' || introducer === 'P' || introducer === 'X' || introducer === '^' || introducer === '_') || code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f;
    if (opaque) {
      const osc = code === 0x9d || code === 27 && introducer === ']'; let end = at + (code === 27 ? 2 : 1);
      // Keep unsupported control strings, including nested SGR, completely literal through their terminator.
      for (; end < input.length; end++) {
        if (input.charCodeAt(end) === 0x9c || osc && input.charCodeAt(end) === 7) break;
        if (input.charCodeAt(end) === 27 && input[end + 1] === '\\') { end++; break; }
      }
      at = end; continue;
    }
    if (code !== 27 || introducer !== '[') continue;
    let end = at + 2;
    while (end < input.length && end - at <= 64 && (input[end] === ';' || (input.charCodeAt(end) >= 48 && input.charCodeAt(end) <= 57))) end++;
    if (end - at > 64 || input[end] !== 'm') continue;
    const next = sgr(style, input.slice(at + 2, end)); if (!next) continue;
    flush(at); style = Object.freeze(next); start = end + 1; at = end;
  }
  flush(input.length); return { text: chunks.join(''), runs };
}
export function selectLogSgrRanges(source: LogSgrText, ranges: readonly { start: number; end: number }[]): LogSgrText {
  const chunks: string[] = [], runs: LogSgrRun[] = []; let index = 0, offset = 0, previous = 0;
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < previous || range.end < range.start || range.end > source.text.length) throw new LogStyleFailure(); previous = range.end;
    chunks.push(source.text.slice(range.start, range.end));
    while (index < source.runs.length && (source.runs[index]?.end ?? 0) <= range.start) index++;
    for (let at = index; at < source.runs.length; at++) {
      const run = source.runs[at]; if (!run || run.start >= range.end) break;
      const start = Math.max(run.start, range.start), end = Math.min(run.end, range.end);
      pushRun(runs, offset + start - range.start, offset + end - range.start, run.style);
    }
    offset += range.end - range.start;
  }
  return { text: chunks.join(''), runs };
}
export function logSgrDisplayParts(source: LogSgrText, start: number, parts: readonly { text: string; match: boolean }[]) {
  const output: Array<{ text: string; match: boolean; style: Readonly<LogSgrStyle> }> = []; let offset = start, index = 0;
  while (index < source.runs.length && (source.runs[index]?.end ?? 0) <= offset) index++;
  for (const part of parts) {
    const end = offset + part.text.length;
    while (offset < end) {
      const run = source.runs[index]; if (!run || run.start > offset || run.end <= offset || output.length >= logSgrPagePartLimit) throw new LogStyleFailure();
      const next = Math.min(end, run.end); output.push({ text: source.text.slice(offset, next), match: part.match, style: run.style }); offset = next;
      if (offset === run.end) index++;
    }
  }
  return output;
}
