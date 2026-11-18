import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('finite and Follow both consume the same bounded viewer with explicit SDK copy callback', async () => {
  for (const path of ['src/panel/pod-log-view.ts', 'src/panel/log-follow-view.ts']) { const code = await file(path); assert.ok(code.includes('mountLogTextView(document, output, locale') && code.includes('bridge()?.copyLogPage(text)') && code.includes('viewer.show(state.text,') && code.includes('viewer.dispose()')); }
});
test('filter runs the bounded NFA, never the untrusted JS backtracking engine or a third-party regex runtime', async () => {
  const engine = await file('src/shared/log-filter.ts'), projection = await file('src/shared/log-viewer.ts');
  assert.ok(engine.includes('states.length >= 192') && engine.includes('--budget.remaining < 0') && engine.includes('logFilterStepLimit = 2_000_000'));
  assert.ok(!/new RegExp|eval\(|Function\(|\.match\(|\.replace\(/.test(engine)); assert.ok(projection.includes('rows > 32_768') && projection.includes('compileLogFilter(pattern)'));
});
test('log DOM uses text nodes with bounded highlighting and explicit pages, no HTML/ANSI execution', async () => {
  const ui = await file('src/panel/log-text-view.ts'), shared = await file('src/shared/log-viewer.ts');
  assert.ok(ui.includes("document.createElement(part.match ? 'mark' : 'span')") && ui.includes('node.textContent = logDisplayText(part.text)'));
  assert.ok(!/innerHTML|createContextualFragment|DOMParser|ansi-to-html|href\s*=/.test(ui)); assert.ok(shared.includes('logViewerPageCharacters = 16_384') && shared.includes('logViewerHighlightLimit = 128'));
});
test('only explicit Copy page clicks reach host.writeClipboard and errors cannot reflect original host error text', async () => {
  const bridge = await file('src/host/bridge.ts'), ui = await file('src/panel/log-text-view.ts');
  assert.ok(bridge.includes('Math.min(GUEST_CLIPBOARD_TEXT_MAX, 100_000)') && bridge.includes('return host.writeClipboard(text)'));
  assert.ok(ui.includes("label: 'Copy page (escaped)'") && ui.includes('void copyPage(value).then(') && ui.includes("copied = 'COPY_FAILED'")); assert.equal((ui.match(/copyPage\(value\)/g) ?? []).length, 1);
  assert.ok(!/navigator\.clipboard|execCommand|console\.|localStorage|sessionStorage|sendMessage|compose\(/.test(ui));
});
test('view wrap/filter/search/reset never restart reads or operate a session', async () => {
  const ui = await file('src/panel/log-text-view.ts'); assert.ok(!/serviceRequest|runPodLog|runLogFollow|stopLogFollow|operations\/|sessions\/|bridge\.ts|setInterval|setTimeout/.test(ui));
  assert.ok(ui.includes("wrap.checked ? 'pre-wrap' : 'pre'") && ui.includes('viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 2') && ui.includes('pinned = false'));
});
test('source replacement/dispose clears transient query/text state while polling unchanged text avoids DOM replacement', async () => {
  const ui = await file('src/panel/log-text-view.ts'); assert.ok(ui.includes('sourceKey !== key') && ui.includes('clearSearch()') && ui.includes('paint(dirty)') && ui.includes("text = ''; filtered = ''; draft = ''; pattern = ''; query = ''"));
  assert.ok(ui.includes("viewport.removeEventListener('scroll', scroll)") && ui.includes('current === revision'));
});
test('Follow source label survives Clear/Stop independently of the control handle, reset discards it', async () => {
  const client = await file('src/host/log-follow-client.ts'), view = await file('src/panel/log-follow-view.ts');
  assert.ok(client.includes('this.#displaySource = parsed.data') && client.includes('source: this.#displaySource') && client.includes('this.#displaySource = undefined'));
  assert.ok(view.includes('state.source ?? state.page?.source'));
});
test('automatic viewer tests remain pure allowlisted text functions, no SDK, clipboard or real/mock operation chain', async () => {
  const code = await file('tests/readonly/log-viewer.test.ts'), list = await file('scripts/readonly-tests.ts'); assert.ok(list.includes("'tests/readonly/log-viewer.test.ts'"));
  assert.ok(!/from ['"].*(?:panel\/|host\/|service\/|@openchamber)|writeClipboard\(|copyPage\(/.test(code));
});
