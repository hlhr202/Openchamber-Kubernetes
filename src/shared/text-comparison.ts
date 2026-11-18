import { BoundaryError } from './errors.ts';
import { hasWellFormedUnicode, utf8ByteLength } from './identity.ts';
export type ComparisonRange = { readonly kind: 'equal' | 'local-only' | 'live-only'; readonly localStart: number; readonly localEnd: number; readonly liveStart: number; readonly liveEnd: number };
export type TextComparison = { readonly equal: boolean; readonly alignment: 'identical' | 'bounded-lines' | 'omitted-budget'; readonly ranges: readonly ComparisonRange[] };
// Pure literal text comparison, NOT server-side dry-run, Apply prediction, semantic equality or a minimal-edit guarantee.
export function compareDocumentText(local: string, live: string): TextComparison {
  for (const text of [local, live]) if (!hasWellFormedUnicode(text) || text.includes('\0') || utf8ByteLength(text) > 1_048_576) throw new BoundaryError('CONTENT_INVALID');
  if (local === live) return { equal: true, alignment: 'identical', ranges: [] };
  const omitted = (): TextComparison => ({ equal: false, alignment: 'omitted-budget', ranges: [] });
  function lines(text: string): string[] | undefined {
    const result: string[] = []; let start = 0;
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') { if (result.length >= 20_000) return undefined; result.push(text.slice(start, i + 1)); start = i + 1; }
    if (start < text.length) result.push(text.slice(start)); return result.length <= 20_000 ? result : undefined;
  }
  const left = lines(local), right = lines(live); if (!left || !right) return omitted();
  const ranges: ComparisonRange[] = []; let i = 0, j = 0, work = 0;
  function add(kind: ComparisonRange['kind'], endI: number, endJ: number) {
    if (i === endI && j === endJ) return;
    const previous = ranges.at(-1);
    if (previous?.kind === kind && previous.localEnd === i && previous.liveEnd === j) ranges[ranges.length - 1] = { ...previous, localEnd: endI, liveEnd: endJ };
    else ranges.push({ kind, localStart: i, localEnd: endI, liveStart: j, liveEnd: endJ }); i = endI; j = endJ;
  }
  while (i < left.length || j < right.length) {
    if (++work > 1_000_000 || ranges.length >= 4096) return omitted();
    if (i < left.length && j < right.length && left[i] === right[j]) { add('equal', i + 1, j + 1); continue; }
    if (i === left.length) { add('live-only', i, right.length); continue; }
    if (j === right.length) { add('local-only', left.length, j); continue; }
    let a = -1, b = -1;
    for (let distance = 1; distance <= 64 && a < 0; distance++) for (let di = 0; di <= distance; di++) {
      if (++work > 1_000_000) return omitted(); const dj = distance - di;
      if (i + di < left.length && j + dj < right.length && left[i + di] === right[j + dj]) { a = di; b = dj; break; }
    }
    if (a < 0) { add('local-only', i + 1, j); add('live-only', i, j + 1); }
    else { add('local-only', i + a, j); add('live-only', i, j + b); }
  }
  return { equal: false, alignment: 'bounded-lines', ranges };
}
