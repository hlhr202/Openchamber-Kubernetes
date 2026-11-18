// Text only. No real filesystem picker, host bridge, native dialog, preference/controller/writer, or UI action execution.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (text: string, ...parts: string[]) => { let offset = -1; for (const part of parts) { const at = text.indexOf(part, offset + 1); assert.ok(at > offset, part); offset = at; } };

test('file-choice route authenticates and bounds JSON before its separate read-only metadata query, never a write handler', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts');
  ordered(http, 'authorized(request.headers.authorization', "url.pathname === '/v2/configuration/files'", 'boundedBody(request, controller.signal, 12_000)', 'options.sourcePicker.read(body, controller.signal)');
  assert.ok(main.includes('createSourcePicker(serviceGeneration, readSourceDirectory)') && http.includes('options.sourcePicker.close()'));
});
test('production directory adapter lists names and lstat metadata only, rejects unsafe/link directories and budgets iteration without recursive or body reads', async () => {
  const adapter = await file('src/service/adapters/source-directory.ts');
  ordered(adapter, 'serverDirectorySchema.parse(input)', 'await realpath(directory)', 'info.isSymbolicLink()', 'parents.length >= 64', 'await opendir(directory, { bufferSize: 32 })', 'for await (const entry of stream)', 'entries.length >= 2000', 'await lstat(join(directory, name.data)', 'const after = await lstat(directory', 'stamp(before) !== stamp(after)');
  assert.ok(adapter.includes("info.isSymbolicLink() ? 'blocked'") && adapter.includes('expected.identity') && adapter.includes('process.getuid?.()'));
  assert.ok(!/readFile|writeFile|appendFile|mkdir\(|unlink\(|rename\(|recursive:|spawn\(|process\.env|console\./.test(adapter));
});
test('metadata scheduler and continuation HMAC bind full generation/list/hidden policy; production reader is only injected by runtime, not imported into tests', async () => {
  const query = await file('src/service/queries/source-picker.ts'), read = await file('tests/readonly/source-picker.test.ts');
  assert.ok(query.includes('concurrency: 1, queued: 8, consumers: 16, timeoutMs: 5000') && query.includes('request.directory, raw.generation, entries, request.showHidden'));
  assert.ok(query.includes('request.listingIdentity !== listingIdentity') && query.includes('visible.slice(request.offset, request.offset + 100)'));
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|bridge|preference-client|namespace-client)/.test(read));
});
test('source picker remains explicitly user-driven with no HOME defaults; file picks only fill a draft and cannot read/persist/confirm automatically', async () => {
  const bridge = await file('src/host/bridge.ts'), view = await file('src/panel/source-picker-view.ts'), panel = await file('src/panel/main.ts');
  assert.ok(view.includes("let directory = ''") && view.includes('Show hidden names') && view.includes('Choose a path, then Read configuration'));
  const pick = bridge.slice(bridge.indexOf('pickSourceFile:'), bridge.indexOf('readContextChoices:'));
  assert.ok(pick.includes('sourcePicker.pick(name)') && pick.includes('sourceFileChosen(path, append)') && !/\.prepare\(|\.submit\(|client\.select\(|client\.reload\(/.test(pick));
  assert.ok(panel.includes('pickedSource(append ? selectionFromLines(mode, paths)') && view.includes("entry.kind === 'file'"));
});
test('inactive context choices share the existing configuration scheduler and filter the full merged snapshot instead of current page rows', async () => {
  const http = await file('src/service/runtime/http.ts'), query = await file('src/service/queries/context-choices.ts');
  ordered(http.slice(http.indexOf("url.pathname === '/v2/configuration/contexts'")), 'contextChoiceRequestSchema.safeParse(input)', 'options.config.selectionKey(body.selection)', 'await reads.run(', 'options.config.read(body.selection, signal)', 'projectContextChoices(result');
  assert.ok(query.includes('result.snapshot.contexts.filter(context => !context.active && context.name.includes(query.search))') && !/operations\/|adapters\/|spawn\(|privateRead/.test(query));
});
test('context picker selection itself is read-only, then bridge must rebind original parsed source identity before opening the existing Use Context confirmation', async () => {
  const client = await file('src/host/context-choice-client.ts'), bridge = await file('src/host/bridge.ts'), view = await file('src/panel/context-choice-view.ts');
  assert.ok(!/context-client|operations\/|\.prepare\(|\.submit\(/.test(client));
  ordered(bridge.slice(bridge.indexOf('chooseContext:')), 'contextChoices.pick(name)', 'choice.serviceGeneration !== config.serviceGeneration', 'choice.configIdentity !== config.configIdentity', 'JSON.stringify(choice.selection) !== JSON.stringify(client.selection)', 'contexts.prepare(');
  assert.ok(view.includes('Selection alone does not switch') && view.includes('bridge()?.chooseContext(selected)') && view.includes('bridge()?.closeContext()'));
});
test('picker response slots and lifecycle reject late selections without automatic polling or silently choosing the first entry', async () => {
  const source = await file('src/host/source-picker-client.ts'), context = await file('src/host/context-choice-client.ts'), bridge = await file('src/host/bridge.ts');
  for (const text of [source, context]) assert.ok(text.includes('this.#calls >= 4') && text.includes('++this.#revision') && text.includes('this.#ready = false') && !/setInterval|setTimeout|\.retry\(|\.prepare\(/.test(text));
  assert.ok(bridge.includes('sourcePicker.reset(); contextDeletes.reset()') && bridge.includes("if (state.phase !== 'ready') contextChoices.reset()") && bridge.includes('contextChoices.dispose(); sourcePicker.dispose()'));
});
test('picker views only render text and SDK controls; readonly tests cannot import their write-capable bridge or real directory adapter', async () => {
  const source = await file('src/panel/source-picker-view.ts'), context = await file('src/panel/context-choice-view.ts'), read = await file('tests/readonly/context-choices.test.ts');
  assert.ok(!/innerHTML|localStorage|clipboard|sendMessage|showOpenFilePicker|FileReader|input\.type = 'file'/.test(source + context));
  assert.ok(!/from ['"].*(?:bridge|context-client|operations\/|adapters\/|preference-client)/.test(read));
});
