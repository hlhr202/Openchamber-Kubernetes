// Pure synthetic text/parameter projections only; no UI, SDK, storage writer, read executor or session.
import assert from 'node:assert/strict';
import test from 'node:test';
import { logDurationSeconds, splitLogDuration, logDurationUnits, logSinceMaximumSeconds } from '../../src/shared/log-duration.ts';
import type { LogDurationUnit } from '../../src/shared/log-duration.ts';
import { logOptionsFromPreferences, defaultLogPreferences } from '../../src/shared/log-preferences.ts';
import { parseLogSgr, selectLogSgrRanges, logSgrDisplayParts, logSgrRunLimit, logSgrPagePartLimit } from '../../src/shared/log-ansi.ts';
import { filterLogRanges, filterLogText, logViewerPage, logSearchParts } from '../../src/shared/log-viewer.ts';
import { logDisplayText } from '../../src/shared/pod-log-protocol.ts';
test('duration unit picker has exactly the fixed upstream second/minute/hour choices', () => { assert.deepEqual(logDurationUnits, ['s', 'm', 'h']); });
test('positive seconds/minutes/hours normalize to the same bounded stored/wire seconds', () => {
  assert.equal(logDurationSeconds('2', 's'), 2); assert.equal(logDurationSeconds('2', 'm'), 120); assert.equal(logDurationSeconds('2', 'h'), 7200);
});
test('blank and non-positive duration values disable filtering regardless of unit', () => {
  for (const unit of logDurationUnits) for (const value of ['', '0', '-1', '-250']) assert.equal(logDurationSeconds(value, unit), -1);
});
test('duration conversion bounds the multiplied result and accepts exact yearly maximum', () => {
  assert.equal(logDurationSeconds('8760', 'h'), logSinceMaximumSeconds); assert.equal(logDurationSeconds('525600', 'm'), logSinceMaximumSeconds);
  assert.throws(() => logDurationSeconds('8761', 'h'), /^BoundaryError: INVALID_INPUT$/); assert.throws(() => logDurationSeconds('525601', 'm'), /^BoundaryError: INVALID_INPUT$/);
});
test('invalid duration grammar cannot become a partial parse, floating point, exponent or CLI option', () => {
  for (const value of ['1.5', '1e2', ' 2 ', '2h', '--since=2', '+2', 'Infinity', '999999999', 'SYNTHETIC_SECRET']) assert.throws(() => logDurationSeconds(value, 'h'), /^BoundaryError: INVALID_INPUT$/);
});
test('invalid runtime units reject even blank values rather than looking up inherited properties', () => {
  for (const unit of ['d', '__proto__', 'constructor', '', 'H']) assert.throws(() => logDurationSeconds('', unit as LogDurationUnit), /^BoundaryError: INVALID_INPUT$/);
});
test('restore/reset chooses hours then minutes then seconds without rounding', () => {
  assert.deepEqual(splitLogDuration(7200), { value: '2', unit: 'h' }); assert.deepEqual(splitLogDuration(5400), { value: '90', unit: 'm' }); assert.deepEqual(splitLogDuration(3601), { value: '3601', unit: 's' });
});
test('no-filter restore uses a blank seconds draft, not a negative unit multiplied by 3600', () => { assert.deepEqual(splitLogDuration(-1), { value: '', unit: 's' }); });
test('stored invalid durations fail fixed rather than being rounded into a different read', () => {
  for (const value of [0, -2, NaN, Infinity, 0.5, 31_536_001]) assert.throws(() => splitLogDuration(value), /^BoundaryError: INVALID_INPUT$/);
});
test('all canonical restored unit drafts roundtrip exactly across representative stored seconds', () => {
  for (const value of [-1, 1, 59, 60, 61, 3599, 3600, 3601, 86400, 31_536_000]) { const split = splitLogDuration(value); assert.equal(logDurationSeconds(split.value, split.unit), value); }
});
test('saving-independent projection still emits existing strict seconds options without persisting display units', () => {
  const options = logOptionsFromPreferences({ ...defaultLogPreferences, since: logDurationSeconds('5', 'm') }); assert.deepEqual(options, { timestamps: false, sinceSeconds: 300, tailLines: null }); assert.equal('unit' in options, false);
});
test('plain/empty/CRLF/emoji log text keeps exact characters and has one default style run at most', () => {
  assert.deepEqual(parseLogSgr(''), { text: '', runs: [] }); const text = '<img src=x>\r\n🌏\t'; const result = parseLogSgr(text); assert.equal(result.text, text); assert.deepEqual(result.runs, [{ start: 0, end: text.length, style: {} }]);
});
test('SGR basic/bright foreground and background become fixed hex styles, never HTML', () => {
  const result = parseLogSgr('\x1b[31mred\x1b[104mblue-bg\x1b[0mplain'); assert.equal(result.text, 'redblue-bgplain');
  assert.deepEqual(result.runs.map(run => run.style), [{ foreground: '#aa0000' }, { foreground: '#aa0000', background: '#5555ff' }, {}]);
});
test('SGR 256-color cube and grayscale boundaries produce bounded hex colors', () => {
  for (const [index, color] of [[16, '#000000'], [21, '#0000ff'], [231, '#ffffff'], [232, '#080808'], [255, '#eeeeee']] as const) assert.equal(parseLogSgr(`\x1b[38;5;${index}mx`).runs[0]?.style.foreground, color);
});
test('SGR truecolor emits only numeric RGB bytes as hex foreground/background', () => {
  const result = parseLogSgr('\x1b[38;2;1;2;255;48;2;0;128;9mx'); assert.deepEqual(result.runs[0]?.style, { foreground: '#0102ff', background: '#008009' });
});
test('SGR emphasis and corresponding off/reset codes do not hide or blink content', () => {
  const result = parseLogSgr('\x1b[1;2;3;4;7;9ma\x1b[22;23;24;27;29mb\x1b[mz'); assert.equal(result.text, 'abz');
  assert.deepEqual(result.runs[0]?.style, { bold: true, dim: true, italic: true, underline: true, inverse: true, strike: true }); assert.deepEqual(result.runs[1]?.style, {});
});
test('39/49 restore inherited theme colors rather than hard-coded black/white', () => {
  const result = parseLogSgr('\x1b[31;44ma\x1b[39mb\x1b[49mc'); assert.deepEqual(result.runs.map(run=>run.style), [{ foreground: '#aa0000', background: '#0000aa' }, { background: '#0000aa' }, {}]);
});
test('unsupported conceal/blink/cursor/erase/OSC52/OSC8 controls remain inspectable escaped text at the display boundary', () => {
  const text = '\x1b[8mhidden?\x1b[5mblink?\x1b[2J\x1b]52;c;SYNTHETIC\x07\x1b]8;;https://synthetic.invalid\x1b\\link';
  const result = parseLogSgr(text); assert.equal(result.text, text); const display = logDisplayText(result.text); assert.equal(display.includes('\x1b'), false); assert.equal(display.includes('\x07'), false); assert.ok(display.includes('\\u001b]52'));
});
test('OSC/DCS/SOS/PM/APC payloads keep nested SGR wholly literal until their real terminator', () => {
  for (const open of ['\x1b]', '\x1bP', '\x1bX', '\x1b^', '\x1b_', '\x90', '\x98', '\x9d', '\x9e', '\x9f']) {
    const payload = `${open}opaque\x1b[31mvalue\x1b\\`, result = parseLogSgr(payload+'\x1b[32mvisible');
    assert.equal(result.text, payload+'visible'); assert.deepEqual(result.runs[0]?.style, {}); assert.equal(result.runs.at(-1)?.style.foreground, '#00aa00');
  }
});
test('OSC BEL/C1-ST termination and incomplete opaque strings never swallow or interpret nested payload controls', () => {
  for (const end of ['\x07', '\x9c']) { const payload = `\x1b]52;c;\x1b[31mSYNTHETIC${end}`; assert.equal(parseLogSgr(payload+'\x1b[32mx').text, payload+'x'); }
  const incomplete = '\x1b]52;c;\x1b[31mSYNTHETIC'; assert.equal(parseLogSgr(incomplete).text, incomplete);
  const dcs = '\x1bPopaque\x07\x1b[31mtail'; assert.equal(parseLogSgr(dcs).text, dcs); // BEL only terminates OSC, not DCS.
});
test('malformed/oversized/unsupported SGR is not partially applied or silently removed', () => {
  for (const sequence of ['\x1b[1;999m', '\x1b[38;5;256m', '\x1b[38;2;1;2m', '\x1b[38;2;1;2;999m', '\x1b[38:2:1:2:3m', '\x1b['+'1;'.repeat(40)+'31m', '\x1b[0031m', '\x1b[31']) {
    const result = parseLogSgr(`${sequence}value`); assert.equal(result.text, `${sequence}value`); assert.deepEqual(result.runs[0]?.style, {});
  }
});
test('split incomplete SGR remains literal until a later complete retained snapshot arrives', () => {
  assert.equal(parseLogSgr('head\x1b[3').text, 'head\x1b[3'); const result = parseLogSgr('head\x1b[31mred'); assert.equal(result.text, 'headred'); assert.equal(result.runs.at(-1)?.style.foreground, '#aa0000');
});
test('parsing a fresh retained/lost/source window never inherits a hidden style from previous logs', () => {
  parseLogSgr('\x1b[31mold'); assert.deepEqual(parseLogSgr('new').runs[0]?.style, {});
});
test('read-only SGR parsing does not mutate or alias already returned frozen styles', () => {
  const result = parseLogSgr('\x1b[31ma\x1b[32mb'); assert.equal(Object.isFrozen(result.runs[0]?.style), true); assert.equal(result.runs[0]?.style.foreground, '#aa0000'); assert.equal(result.runs[1]?.style.foreground, '#00aa00');
});
test('styling budgets reject dense runs explicitly but user-disabled styling preserves the entire raw input', () => {
  const text = '\x1b[31ma\x1b[32mb'.repeat(logSgrRunLimit / 2 + 1); assert.throws(() => parseLogSgr(text), /^LogStyleFailure: LOG_STYLE_BUDGET$/);
  const plain = parseLogSgr(text, false); assert.equal(plain.text, text); assert.equal(plain.runs.length, 1);
});
test('invisible style-only sequences do not exhaust the retained run budget', () => {
  const result = parseLogSgr('\x1b[31m'.repeat(20_000) + 'x'); assert.equal(result.text, 'x'); assert.equal(result.runs.length, 1);
});
test('input budget and malformed UTF-16 fail fixed before unsafe display projection', () => {
  assert.throws(() => parseLogSgr('x'.repeat(1_048_577)), /^LogStyleFailure: LOG_STYLE_BUDGET$/); assert.throws(() => parseLogSgr('\ud800'), /^LogStyleFailure: LOG_STYLE_BUDGET$/);
});
test('filters run on visible SGR-stripped text and preserve selected line colors across excluded rows', () => {
  const source = parseLogSgr('\x1b[31mkeep\n\x1b[32mdrop\nkeep\n'), ranges = filterLogRanges(source.text, 'keep', 'include');
  const result = selectLogSgrRanges(source, ranges); assert.equal(result.text, 'keep\nkeep\n'); assert.deepEqual(result.runs.map(run => run.style.foreground), ['#aa0000', '#00aa00']);
});
test('before/after/include/exclude range projection exactly matches existing filter text semantics', () => {
  const source = parseLogSgr('\x1b[31ma\r\n\x1b[32mb\r\n\x1b[34mc');
  for (const mode of ['include', 'exclude', 'before', 'after'] as const) assert.equal(selectLogSgrRanges(source, filterLogRanges(source.text, 'b', mode)).text, filterLogText(source.text, 'b', mode));
});
test('literal search crosses ANSI style boundaries while retaining both highlighted colors', () => {
  const source = parseLogSgr('he\x1b[31mll\x1b[32mo'); const parts = logSgrDisplayParts(source, 0, logSearchParts(source.text, 'hello'));
  assert.equal(parts.map(part=>part.text).join(''), 'hello'); assert.ok(parts.every(part=>part.match)); assert.deepEqual(parts.map(part=>part.style.foreground), [undefined, '#aa0000', '#00aa00']);
});
test('page boundaries retain active SGR style and UTF-16-safe text without reinterpreting escape fragments', () => {
  const source = parseLogSgr('\x1b[31m'+'x'.repeat(16_383)+'🌏end'), page = logViewerPage(source.text, 1);
  const parts = logSgrDisplayParts(source, page.start, [{ text: page.text, match: false }]); assert.equal(parts.map(part=>part.text).join(''), page.text); assert.ok(parts.every(part=>part.style.foreground === '#aa0000')); assert.ok(page.text.startsWith('🌏'));
});
test('dense styled page has a fixed DOM-part admission, not unbounded span creation', () => {
  const source = parseLogSgr('\x1b[31ma\x1b[32mb'.repeat(logSgrPagePartLimit / 2 + 1)); assert.throws(() => logSgrDisplayParts(source, 0, [{ text: source.text, match: false }]), /^LogStyleFailure: LOG_STYLE_BUDGET$/);
});
test('invalid overlapping or out-of-range style selections fail instead of duplicating or inventing source bytes', () => {
  const source = parseLogSgr('abcdef'); for (const ranges of [[{ start: 2, end: 1 }], [{ start: -1, end: 2 }], [{ start: 0, end: 7 }], [{ start: 0, end: 3 }, { start: 2, end: 4 }]]) assert.throws(() => selectLogSgrRanges(source, ranges), /^LogStyleFailure: LOG_STYLE_BUDGET$/);
});
test('arbitrary HTML/URLs/CSS remain text only and cannot become style keys or values', () => {
  const text = '<img onerror=bad()>url(https://synthetic.invalid)background:red;'; const source = parseLogSgr('\x1b[31m'+text); assert.equal(source.text, text); assert.deepEqual(source.runs[0]?.style, { foreground: '#aa0000' });
});
