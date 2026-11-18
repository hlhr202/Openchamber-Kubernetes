// Pure bounded text/filter functions only. No DOM SDK/bridge/clipboard/transport/worker or operation/session controls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileLogFilter, logFilterStepLimit } from '../../src/shared/log-filter.ts';
import { filterLogText, findLogMatch, logSearchParts, logViewerPage, logViewerPageCharacters } from '../../src/shared/log-viewer.ts';
import { logDisplayText } from '../../src/shared/pod-log-protocol.ts';
import { hasWellFormedUnicode } from '../../src/shared/identity.ts';
const match = (pattern: string, text: string) => compileLogFilter(pattern)(text, { remaining: logFilterStepLimit });
test('filter keeps the upstream include/exclude/before-exclusive/after-inclusive modes', () => {
  const text = 'first\nERROR 42\nlast\n';
  assert.equal(filterLogText(text, 'ERROR', 'include'), 'ERROR 42\n');
  assert.equal(filterLogText(text, 'ERROR', 'exclude'), 'first\nlast\n');
  assert.equal(filterLogText(text, 'ERROR', 'before'), 'first\n');
  assert.equal(filterLogText(text, 'ERROR', 'after'), 'ERROR 42\nlast\n');
});
test('empty filter is exactly original text in all four modes including blanks/CRLF/final newline', () => {
  for (const mode of ['include', 'exclude', 'before', 'after'] as const) { const text = '\n\r\n🌏\t\r\nlast'; assert.equal(filterLogText(text, '', mode), text); }
});
test('no match means no include/after, all exclude/before; empty source stays empty', () => {
  for (const mode of ['include', 'after'] as const) assert.equal(filterLogText('one\ntwo', 'absent', mode), '');
  for (const mode of ['exclude', 'before'] as const) assert.equal(filterLogText('one\ntwo', 'absent', mode), 'one\ntwo');
  assert.equal(filterLogText('', 'x', 'include'), '');
});
test('zero-width anchor match handles empty rows and does not discard blank log lines', () => {
  assert.equal(filterLogText('a\n\nb\n', '^$', 'include'), '\n');
  assert.equal(filterLogText('\n\nb\n', '^$', 'before'), '');
  assert.equal(filterLogText('a\n\nb\n', '^$', 'after'), '\nb\n');
});
test('CRLF is excluded from line matching but preserved exactly in projected and copied source text', () => {
  assert.equal(filterLogText('a\r\nb\r\n', '^a$', 'include'), 'a\r\n');
  assert.equal(filterLogText('a\r\nb\r\n', '^b$', 'after'), 'b\r\n');
});
test('filter recomputes after a partial line is appended without fabricating a delimiter', () => {
  assert.equal(filterLogText('pre\nERR', 'ERROR', 'include'), '');
  assert.equal(filterLogText('pre\nERROR\npost', 'ERROR', 'include'), 'ERROR\n');
});
test('before/after start fresh for the current retained Follow window after loss or eviction', () => {
  assert.equal(filterLogText('old\nanchor\nlater\n', 'anchor', 'after'), 'anchor\nlater\n');
  assert.equal(filterLogText('later\nnew\n', 'anchor', 'after'), '');
  assert.equal(filterLogText('later\nnew\n', 'anchor', 'before'), 'later\nnew\n');
});
test('regular subset supports groups, alternation, classes, anchors and greedy quantifiers without backtracking', () => {
  for (const text of ['ERROR 42', 'WARN 2', 'INFO']) assert.equal(match('^(ERROR|WARN) [0-9]+$', text), text !== 'INFO');
  assert.equal(match('ab?c', 'ac'), true); assert.equal(match('ab*c', 'abbbc'), true); assert.equal(match('ab+c', 'ac'), false);
  assert.equal(match('a.*z', 'xa😀z!'), true); assert.equal(match('^x[^0-9]+$', 'xabc'), true); assert.equal(match('^x[^0-9]+$', 'xa1'), false);
});
test('escape classes, escaped metacharacters, tabs and whitespace are code-unit regular predicates', () => {
  assert.equal(match('^\\w+\\s\\d+$', 'abc_1\t42'), true); assert.equal(match('^\\D\\W\\S$', 'a#z'), true);
  assert.equal(match('^\\[a\\]\\.$', '[a].'), true); assert.equal(match('^[\\d]+$', '32'), true);
  assert.equal(match('^\\f\\v$', '\f\v'), true);
});
test('Unicode whitespace is compatible with the regular subset, unsupported escapes fail explicitly', () => {
  for (const text of ['\u00a0', '\u2005', '\u2028', '\ufeff']) assert.equal(match('^\\s$', text), true);
  for (const pattern of ['\\cA', '\\a', '\\q']) assert.throws(() => compileLogFilter(pattern), /FILTER_UNSUPPORTED/);
});
test('filter matching is case-sensitive and anchors apply to each current row', () => {
  assert.equal(filterLogText('error\nERROR\n', '^ERROR$', 'include'), 'ERROR\n');
});
test('ambiguous nested repetition is an NFA rather than exponential backtracking', () => {
  assert.equal(match('^(a+)+b$', 'a'.repeat(12_000)), false);
  assert.equal(match('^(a|aa)*b$', 'a'.repeat(12_000)), false);
});
test('epsilon cycles terminate and nullable alternatives never loop forever', () => {
  assert.equal(match('()*', 'anything'), true); assert.equal(match('^(a?)*$', 'aaaa'), true);
  assert.equal(match('a|', 'zzz'), true); assert.equal(match('(a*)*b', 'zzb'), true);
});
test('invalid syntax returns a fixed error, not an exception containing the pattern or logs', () => {
  for (const pattern of ['[', '(', 'a)', '*', '[z-a]', '[]', '\\']) assert.throws(() => compileLogFilter(pattern), /^Error: FILTER_INVALID$/);
});
test('unsupported backrefs/lookaround/counted repeats/flags are explicit instead of silently changing regex meaning', () => {
  for (const pattern of ['(a)\\1', '(?=a)', '(?:a)', '(?!a)', '(?<=a)', 'a{2}', 'a+?', '\\p{Letter}', '\\bword', '[\\d-a]']) assert.throws(() => compileLogFilter(pattern), /^Error: FILTER_UNSUPPORTED$/);
});
test('pattern/state/total transition budgets fail closed, never display an unfiltered success on failure', () => {
  assert.throws(() => compileLogFilter('x'.repeat(129)), /FILTER_BUDGET/);
  assert.throws(() => compileLogFilter('a'.repeat(128))('a'.repeat(128), { remaining: 1 }), /FILTER_BUDGET/);
  assert.throws(() => filterLogText('a'.repeat(1_048_576), '(a|aa|aaa|aaaa)*z', 'include'), /FILTER_BUDGET/);
});
test('aggregate row cap bounds filtered projections while unfiltered million-newline text remains page-accessible', () => {
  const text = '\n'.repeat(40_000); assert.throws(() => filterLogText(text, '^$', 'include'), /FILTER_BUDGET/);
  assert.equal(filterLogText(text, '', 'include'), text);
});
test('source is capped at the existing 1MiB client envelope and rejects malformed Unicode', () => {
  assert.throws(() => filterLogText('x'.repeat(1_048_577), '', 'include'), /FILTER_BUDGET/);
  assert.throws(() => filterLogText('\ud800', '', 'include'), /FILTER_BUDGET/);
  assert.throws(() => compileLogFilter('\ud800'), /FILTER_INVALID/);
});
test('page navigation is bounded, clamps stale page indexes and never silently drops long lines', () => {
  const text = 'x'.repeat(200_000), parts: string[] = [];
  for (let page = 0; page < logViewerPage(text, 0).count; page++) { const value = logViewerPage(text, page); assert.ok(value.text.length <= logViewerPageCharacters + 1); parts.push(value.text); }
  assert.equal(parts.join(''), text); assert.equal(logViewerPage(text, -8).page, 0); assert.equal(logViewerPage(text, Number.NaN).page, 0); assert.equal(logViewerPage(text, 999).page, 12);
});
test('UTF-16 surrogate crossing a page edge is moved whole without replacement, duplication or omission', () => {
  const text = 'x'.repeat(logViewerPageCharacters - 1) + '🌏' + 'y'.repeat(logViewerPageCharacters);
  const pages = Array.from({ length: logViewerPage(text, 0).count }, (_, n) => logViewerPage(text, n));
  for (const page of pages) assert.equal(hasWellFormedUnicode(page.text), true); assert.equal(pages.map(page => page.text).join(''), text);
});
test('empty and exact-edge pages do not add a phantom final page', () => {
  assert.deepEqual(logViewerPage('', 50), { page: 0, count: 1, start: 0, end: 0, text: '' }); assert.equal(logViewerPage('a'.repeat(logViewerPageCharacters), 0).count, 1);
});
test('literal search treats regex/HTML metacharacters as text and preserves the full original page', () => {
  const text = '<script>.*(a+)+</script>\n'; const parts = logSearchParts(text, '.*(a+)+');
  assert.equal(parts.filter(part => part.match).length, 1); assert.equal(parts.map(part => part.text).join(''), text);
  assert.equal(logSearchParts('Error', 'error').some(part => part.match), false);
});
test('find next/previous wrap through all retained filtered text rather than only the visible page', () => {
  const text = 'hit ' + 'x'.repeat(20_000) + ' hit';
  assert.equal(findLogMatch(text, 'hit', -1, false), 0); assert.equal(findLogMatch(text, 'hit', 0, false), text.length - 3);
  assert.equal(findLogMatch(text, 'hit', text.length - 3, false), 0); assert.equal(findLogMatch(text, 'hit', 0, true), text.length - 3);
  assert.equal(findLogMatch(text, 'hit', text.length - 3, true), 0); assert.equal(findLogMatch(text, 'absent', -1, false), -1);
});
test('literal search locates a match spanning page boundaries without interpreting a pattern', () => {
  const text = 'x'.repeat(logViewerPageCharacters - 2) + '[match]' + 'last'; const hit = findLogMatch(text, '[match]', -1, false);
  assert.equal(hit, logViewerPageCharacters - 2); assert.equal(logViewerPage(text, Math.floor(hit / logViewerPageCharacters)).text.slice(-2), '[m');
  assert.equal(findLogMatch(text, '', -1, false), -1); assert.throws(() => findLogMatch(text, 'x'.repeat(129), -1, false), /FILTER_BUDGET/);
});
test('search highlights are capped at 128 with at most 257 text/mark fragments, preserving even repetitive text', () => {
  const text = 'a'.repeat(logViewerPageCharacters); const parts = logSearchParts(text, 'a'); assert.equal(parts.filter(part => part.match).length, 128); assert.ok(parts.length <= 257); assert.equal(parts.map(part => part.text).join(''), text);
});
test('search query budget and well-formed Unicode reject pathological input', () => {
  assert.throws(() => logSearchParts('hello', 'x'.repeat(129)), /FILTER_BUDGET/); assert.throws(() => logSearchParts('hello', '\udc00'), /FILTER_BUDGET/);
});
test('display/copy projection only escapes controls, never parses ANSI or HTML and fits bounded SDK page payload', () => {
  const text = '\x1b[31m<script>\x00'.repeat(3000); const page = logViewerPage(text, 0), visible = logDisplayText(page.text);
  assert.ok(visible.includes('\\u001b')); assert.ok(visible.includes('<script>')); assert.equal(visible.includes('\x1b'), false); assert.ok(visible.length <= 98_310);
});
test('rejected filtering does not mutate source text and supports a clean explicit reset', () => {
  const text = 'SYNTHETIC_LOG\n'; assert.throws(() => filterLogText(text, '(?=x)', 'include'), /FILTER_UNSUPPORTED/); assert.equal(filterLogText(text, '', 'include'), text);
});
test('regular subset agrees with JavaScript regular matching for bounded deterministic fixture cross-products', () => {
  // Trusted fixed expressions only in this test oracle. Production never executes user RegExp.
  const patterns = ['a', 'ab', '^a', 'a$', 'a|b', '(ab|b)*c', 'a?b+c*', '[a-c]+', '[^b]', 'a.*b', '(a?)*b', '^$', '^a+$'];
  const texts = ['', 'a', 'b', 'abc', 'aab', 'bbb', 'ac', 'abbc', 'cc', '🌏'];
  for (const pattern of patterns) for (const text of texts) assert.equal(match(pattern, text), new RegExp(pattern).test(text), `${pattern} / fixture`);
});
