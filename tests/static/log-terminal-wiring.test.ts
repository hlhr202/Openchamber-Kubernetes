import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('terminal runtime package is exact stable public MIT JS with no install hooks or runtime dependencies', async () => {
  const pkg = JSON.parse(await file('package.json')), audit = JSON.parse(await file('tests/fixtures/contracts/log-terminal-review/report.json'));
  assert.equal(pkg.dependencies['@xterm/xterm'], '6.0.0'); assert.equal(audit.version, '6.0.0'); assert.equal(audit.license, 'MIT'); assert.deepEqual(audit.runtimeDependencies, []); assert.deepEqual(audit.installHooks, []);
});
test('xterm is bundled classic IIFE with package-local CSS and license, no remote script or addon download', async () => {
  const code = await file('scripts/compile.ts'); assert.ok(code.includes("'@xterm/xterm'") && code.includes("'../css/xterm.css'") && code.includes('THIRD_PARTY_NOTICES.txt'));
  const css = await file('tests/fixtures/contracts/log-terminal-review/package__css__xterm.css.txt'); assert.ok(!/@import|url\(/.test(css));
});
test('terminal only initializes when destination is enabled and has a fixed bounded output-only buffer', async () => {
  const code = await file('src/panel/log-terminal-view.ts'); assert.ok(code.includes('if (terminal || !enabled || disposed) return') && code.includes('cols: 80, rows: 24, scrollback: 512') && code.includes('disableStdin: true') && code.includes("logLevel: 'off'"));
  assert.ok(code.includes('allowProposedApi: false') && code.includes('windowOptions: {}') && code.includes('linkHandler: { activate() {} }'));
});
test('no input/PTY/session/transport methods are wired from read-only terminal rendering', async () => {
  const code = await file('src/panel/log-terminal-view.ts'); assert.ok(!/\.onData\(|\.onBinary\(|\.input\(|\.paste\(|serviceRequest|WebSocket|fetch\(|sessions\/|adapters\/|spawn\(|writeClipboard/.test(code));
  assert.ok(code.includes('value.write(text, () =>') && code.includes('value.reset()') && code.includes('value.dispose()') && code.includes('value.buffer.active.length >= 536'));
});
test('M3 projections strip capabilities/selection paths and preserve event sequence instead of text-based deduplication', async () => {
  const dto = await file('src/shared/log-output-protocol.ts'), producer = await file('src/host/log-output-producer.ts'); assert.ok(!/handle:|token:|selection:|owner:|stdin:/.test(dto));
  assert.ok(producer.includes('event.sequence > this.#cursor') && producer.includes('events.map(event => event.text)') && producer.includes('state.page?.lost'));
});
test('parser writes have callback backpressure, escaped controls, queue admission, generation masking and owned disposal', async () => {
  const code = await file('src/host/log-terminal-output.ts'); assert.ok(code.includes('logDisplayText(chunk)') && code.includes('this.#inflight +') && code.includes('> 131_072') && code.includes('>= 8') && code.includes('item.offset + 4096'));
  assert.ok(code.includes('revision === this.#revision') && code.includes('this.#masked = true') && code.includes('this.#sink.dispose()'));
  const view = await file('src/panel/log-terminal-view.ts'); assert.ok(view.includes('consumer.fail(code)'));
});
test('finite and Follow Terminal destination render real xterm output without falling back to the Webview text viewer', async () => {
  const finite = await file('src/panel/pod-log-view.ts'), follow = await file('src/panel/log-follow-view.ts');
  assert.ok(finite.includes("output.hidden = destination === 'Terminal'") && finite.includes('terminal.snapshot(state)') && !finite.includes('TERMINAL_DESTINATION_UNAVAILABLE'));
  assert.ok(follow.includes('output.hidden = terminalDestination()') && follow.includes('terminal.follow(state)') && follow.includes('terminal.dispose()'));
});
test('automatic log terminal tests stay pure DTO/output sink fixtures, never xterm DOM, SDK, native/session or write controllers', async () => {
  const code = await file('tests/readonly/log-terminal-output.test.ts'), list = await file('scripts/readonly-tests.ts'); assert.ok(list.includes("'tests/readonly/log-terminal-output.test.ts'"));
  assert.ok(!/from ['"].*(?:@xterm|@openchamber|panel\/|service\/|bridge)|\.input\(|\.paste\(|spawn\(/.test(code));
});
