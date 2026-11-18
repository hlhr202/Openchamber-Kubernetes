import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('fixed upstream duration choices and exact restoration order are read as text, never executed', async () => {
  const js = await file('tests/fixtures/baseline/kubernetes/src/components/logs/app/main.js.txt'), html = await file('tests/fixtures/baseline/kubernetes/src/components/logs/app/index.html.txt');
  assert.ok(js.includes("{ symbol: 'h', seconds: 3600 }") && js.includes('effectiveSince % seconds === 0'));
  for (const unit of ['s', 'm', 'h']) assert.ok(html.includes(`value="${unit}"`));
});
test('duration picker routes normalized seconds through existing draft/Run/Save without changing preference schema', async () => {
  const code = await file('src/panel/pod-log-view.ts'), schema = await file('src/shared/log-preferences.ts');
  assert.ok(code.includes('since: logDurationSeconds(since, sinceUnit)') && code.includes('splitLogDuration(settings.since)') && code.includes('sinceUnits.dispose()'));
  assert.ok(code.includes("sinceUnit = 's'") && code.includes('if (isLogDurationUnit(value))') && !schema.includes('sinceUnit:'));
});
test('ANSI style parsing only emits typed hex/emphasis runs and has explicit whole-source/page budgets', async () => {
  const code = await file('src/shared/log-ansi.ts'); assert.ok(code.includes('logSgrRunLimit = 4096') && code.includes('logSgrPagePartLimit = 2048') && code.includes('Object.freeze(next)'));
  assert.ok(!/innerHTML|createContextualFragment|new RegExp|eval\(|Function\(|service\/|operations\/|sessions\/|@xterm|@openchamber|console\.|fetch\(/.test(code));
});
test('Webview renders styles on text nodes only, with control escaping and no raw HTML/CSS or terminal execution', async () => {
  const code = await file('src/panel/log-text-view.ts'); assert.ok(code.includes('logSgrDisplayParts(styled, current.start, parts)') && code.includes('node.textContent = logDisplayText(part.text)'));
  assert.ok(code.includes('node.style.color = style.foreground') && code.includes("renderError = 'LOG_STYLE_BUDGET'") && code.includes('pre.replaceChildren()'));
  assert.ok(!/innerHTML|cssText|setAttribute\(['"]style|createContextualFragment|DOMParser|ansi-to-html|href\s*=|new Terminal|onData\(/.test(code));
});
test('visible styled text drives filters/search/pages/copy, and a user can explicitly disable styling without saving or rerunning logs', async () => {
  const code = await file('src/panel/log-text-view.ts'); assert.ok(code.includes('filterLogRanges(source.text, pattern, appliedMode)') && code.includes('selectLogSgrRanges(source,') && code.includes('parseLogSgr(text, ansi.checked)'));
  assert.ok(code.includes("ansi.addEventListener('change', ansiChanged)") && code.includes("ansi.removeEventListener('change', ansiChanged)"));
  assert.ok(!/saveLogPreferences|storage\.|serviceRequest|runPodLog|runLogFollow|stopLogFollow|navigator\.clipboard/.test(code));
});
test('Terminal keeps independent escaped raw output; Webview ANSI styling cannot feed controls to xterm', async () => {
  const code = await file('src/host/log-terminal-output.ts'); assert.ok(code.includes('logDisplayText(chunk)') && !code.includes('log-ansi'));
});
test('automatic presentation tests import only pure parameter/text functions, no DOM/SDK/read executor or real/mock write chain', async () => {
  const code = await file('tests/readonly/log-presentation.test.ts'), list = await file('scripts/readonly-tests.ts'); assert.ok(list.includes("'tests/readonly/log-presentation.test.ts'"));
  assert.ok(!/from ['"].*(?:panel\/|host\/|service\/|writer|@openchamber|@xterm)|\.save\(|\.run\(|spawn\(/.test(code));
});
