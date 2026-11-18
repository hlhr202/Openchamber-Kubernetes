import { hasWellFormedUnicode } from './identity.ts';
import { logBytes } from './pod-log-protocol.ts';
import { compileLogFilter, LogFilterFailure, logFilterStepLimit } from './log-filter.ts';

export const logViewerPageCharacters = 16_384;
export const logViewerSearchLimit = 128;
export const logViewerHighlightLimit = 128;
export type LogFilterMode = 'include' | 'exclude' | 'before' | 'after';
export type LogTextRange = { start: number; end: number };
// Always project the currently retained source, never a hidden unbounded history or a persisted query.
export function filterLogText(text: string, pattern: string, mode: LogFilterMode): string {
  return filterLogRanges(text, pattern, mode).map(range => text.slice(range.start, range.end)).join('');
}
export function filterLogRanges(text: string, pattern: string, mode: LogFilterMode): LogTextRange[] {
  if (text.length > logBytes || !hasWellFormedUnicode(text)) throw new LogFilterFailure('FILTER_BUDGET');
  if (!['include', 'exclude', 'before', 'after'].includes(mode)) throw new LogFilterFailure('FILTER_INVALID');
  if (!pattern) return text ? [{ start: 0, end: text.length }] : [];
  const matches = compileLogFilter(pattern), budget = { remaining: logFilterStepLimit }, parts: LogTextRange[] = []; let start = 0, rows = 0, found = false;
  while (start < text.length) {
    if (++rows > 32_768) throw new LogFilterFailure('FILTER_BUDGET');
    const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(start, newline < 0 ? end : end - (text[end - 2] === '\r' ? 2 : 1));
    const matched = found && mode === 'after' ? true : matches(line, budget);
    if (mode === 'before' && matched) break;
    if (mode === 'after' && matched) found = true;
    if (mode === 'include' && matched || mode === 'exclude' && !matched || mode === 'before' || mode === 'after' && found) {
      const previous = parts.at(-1); if (previous?.end === start) previous.end = end; else parts.push({ start, end });
    }
    start = end;
  }
  return parts;
}
export function logViewerPage(text: string, requested: number) {
  const count = Math.max(1, Math.ceil(text.length / logViewerPageCharacters));
  const page = Number.isFinite(requested) ? Math.min(count - 1, Math.max(0, Math.floor(requested))) : 0;
  const boundary = (offset: number) => { const code = text.charCodeAt(offset); return code >= 0xDC00 && code <= 0xDFFF ? offset - 1 : offset; };
  const start = boundary(page * logViewerPageCharacters), end = boundary(Math.min(text.length, (page + 1) * logViewerPageCharacters));
  return { page, count, start, end, text: text.slice(start, end) };
}
export function logSearchParts(text: string, query: string): { text: string; match: boolean }[] {
  if (query.length > logViewerSearchLimit || !hasWellFormedUnicode(query)) throw new LogFilterFailure('FILTER_BUDGET');
  if (!query) return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = []; let start = 0;
  for (let n = 0; n < logViewerHighlightLimit; n++) { const at = text.indexOf(query, start); if (at < 0) break;
    if (at > start) parts.push({ text: text.slice(start, at), match: false }); parts.push({ text: query, match: true }); start = at + query.length;
  }
  if (start < text.length) parts.push({ text: text.slice(start), match: false }); return parts;
}
export function findLogMatch(text: string, query: string, current: number, backward: boolean): number {
  if (!query) return -1;
  if (query.length > logViewerSearchLimit || !hasWellFormedUnicode(query)) throw new LogFilterFailure('FILTER_BUDGET');
  const start = current < 0 ? backward ? text.length : 0 : current + (backward ? -1 : query.length);
  const found = backward ? start < 0 ? -1 : text.lastIndexOf(query, start) : text.indexOf(query, start);
  return found < 0 ? backward ? text.lastIndexOf(query) : text.indexOf(query) : found;
}
