// Text review only, especially writer/save/SDK storage. Never import or execute them.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('fixed SDK instance storage get/set are centralized with distinct read and explicit write adapters', async () => {
  const code = await file('src/host/bridge.ts'); assert.ok(code.includes("host.storage.get(key, { scope: 'instance' })") && code.includes("host.storage.set(key, value, { scope: 'instance' })"));
  assert.ok(code.includes('saveLogPreferences: (value: unknown) => logPreferenceWriter.save(value)') && code.includes('logPreferences.dispose()'));
});
test('settings writer validates strict whitelist before the only storage call and keeps actual unsettled admission', async () => {
  const code = await file('src/host/log-preference-writer.ts'); assert.ok(code.indexOf('logPreferencesSchema.safeParse(input)') < code.indexOf('await set(logPreferenceKey, value)'));
  assert.equal((code.match(/await set\(/g) ?? []).length, 1); assert.ok(code.includes("catch { return 'unknown'; }") && code.includes('finally { pending = false; }'));
  assert.ok(!/service\/|operations\/|sessions\/|setTimeout|setInterval|console\.|JSON\.stringify/.test(code));
});
test('preferences are only the fixed scalar options, never log text/filter/history/resource identity', async () => {
  const code = await file('src/shared/log-preferences.ts'); const schema = code.slice(code.indexOf('export const logPreferencesSchema'), code.indexOf('export type LogPreferences'));
  assert.ok(schema.includes('.strict()') && !/query|text:|source:|target:|reference:|container:|token:|path:/.test(schema));
});
test('autorun is a one-shot ready-container decision with late-view and user-touch guards, never triggered by Reset', async () => {
  const code = await file('src/panel/pod-log-view.ts'); assert.ok(code.includes("defaults.take(preference.phase === 'ready' && state.phase === 'ready' && !state.stale") && code.includes('defaults.revision === initial.revision && !defaults.touched'));
  const reset = code.slice(code.indexOf('const resetSettings ='), code.indexOf('const next =')); assert.ok(reset.includes('touched()') && reset.includes('applySettings(preference.settings)') && !reset.includes('runConfigured('));
});
test('Save is explicit and never retries unknown, reload resolves uncertainty before another explicit save', async () => {
  const code = await file('src/panel/pod-log-view.ts'); assert.equal((code.match(/host\.saveLogPreferences\(value\)/g) ?? []).length, 1);
  assert.ok(code.includes('if (saving || saveUnknown || disposed) return') && code.includes('SAVE_UNKNOWN_NO_RETRY') && code.includes('SAVED_PREVIOUS_DRAFT') && code.includes('readLogPreferences()'));
  assert.ok(code.includes('resolvingUnknown = saveUnknown') && code.includes("if (resolvingUnknown && value.phase === 'ready')") && !code.includes("if (value.phase === 'ready') saveUnknown = false"));
});
test('Wrap is a local shared finite/Follow display preference and does not restart a read or save implicitly', async () => {
  const ui = await file('src/panel/pod-log-view.ts'), text = await file('src/panel/log-text-view.ts');
  assert.ok(ui.includes('viewer.setWrap(wrapEnabled)') && ui.includes('() => wrapEnabled, wrapChanged'));
  assert.ok(text.includes('wrapChangedByUser(wrap.checked)') && text.includes('setWrap(value: boolean)') && !text.includes('saveLogPreferences'));
});
test('Terminal stored choice routes only to the dedicated read-only output renderer, no Webview fallback or Exec/PTY', async () => {
  const code = await file('src/panel/pod-log-view.ts'); assert.ok(code.includes("terminal.setEnabled(destination === 'Terminal'") && !/spawn\(|openTerminal|sessions\//.test(code));
});
test('automatic settings tests import read-only getter and pure decisions, never SDK, writer, UI, bridge or save', async () => {
  const code = await file('tests/readonly/log-preferences.test.ts'), list = await file('scripts/readonly-tests.ts'); assert.ok(list.includes("'tests/readonly/log-preferences.test.ts'"));
  assert.ok(!/from ['"].*(?:writer|bridge|@openchamber|panel\/|service\/)|\.save\(|storage\.set|createLogPreferenceWriter/.test(code));
});
