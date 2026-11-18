// TEXT ONLY. Never import or run any configuration planner/controller/client/adapter/lock, even with mocks.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (text: string, ...parts: string[]) => { let offset = -1; for (const part of parts) { const at = text.indexOf(part, offset + 1); assert.ok(at > offset, part); offset = at; } };

test('fixed filename/current-context source rules distinguish first existing destination from target stanza origin without creating missing files', async () => {
  const source = await file('tests/fixtures/contracts/query-contract/kubernetes/client-go/tools/clientcmd/config.go.txt'), adapter = await file('src/service/adapters/namespace-file.ts');
  const filename = source.slice(source.indexOf('func (o *PathOptions) GetDefaultFilename()'), source.indexOf('func (o *PathOptions) IsExplicitFile()'));
  ordered(filename, 'o.IsExplicitFile()', 'for _, envVarFile := range envVarFiles', 'os.Stat(envVarFile)', 'return envVarFile', 'return envVarFiles[len(envVarFiles)-1]');
  assert.ok(source.includes('reflect.DeepEqual(*startingConfig, newConfig)') && source.includes('startingConfig.CurrentContext != newConfig.CurrentContext'));
  ordered(adapter.slice(adapter.indexOf('async inspectContextSources(')), 'resolveConfigSelection(', 'mergeConfigSources(', 'merged.contexts.get(context)', 'const destination = values[0]', 'contextOrigin: target.sourcePath');
  assert.ok(!/mkdir\(|writeFile\(|rename\(/.test(adapter.slice(adapter.indexOf('async inspectContextSources('), adapter.indexOf('async inspectContextDeletion('))));
});
test('all ordered sources get secure bounded snapshots with explicit missing placeholders and read-only tails, not credential reference execution', async () => {
  const adapter = await file('src/service/adapters/namespace-file.ts');
  const sources = adapter.slice(adapter.indexOf('async function contextSources('), adapter.indexOf('return {\n    async verifyCommitted'));
  assert.ok(sources.includes('snapshot(path, signal, false)') && sources.includes('bytes > 8_000_000') && sources.includes('await lstat(path)'));
  assert.ok(sources.includes("status: 'missing', version: null") && sources.includes('definesContext:'));
  assert.ok(adapter.includes('requireWritable && (before.mode & 0o200n) === 0n') && adapter.includes('snapshot(destination.path, signal)'));
  assert.ok(!/spawn\(|exec\(|tokenFile|readFile\(/.test(sources));
});
test('same lock and original selection bind every source before staging and after staging, with final physical-file/stage/expiry gate before the sole rename', async () => {
  const op = await file('src/service/operations/context.ts'), adapter = await file('src/service/adapters/namespace-file.ts');
  ordered(op.slice(op.indexOf('async function execute(')), 'options.lock.run(', 'await configuration(', 'previous !== record.bundle.previous', 'await options.files.verifyContextSources(', 'options.files.commit(', '() => options.files.verifyContextSources(');
  ordered(adapter.slice(adapter.indexOf('async commit(')), 'await staged.sync()', 'if (recheckSources) await recheckSources()', 'const current = await snapshot(', 'current.version !== plan.version', 'const stage = await lstat(', 'beforeCommit(); attempted = true', 'await rename(');
  assert.equal(adapter.match(/await rename\(/g)?.length, 1);
  assert.ok(adapter.includes('JSON.stringify(current.sources) !== JSON.stringify(bundle.sources)'));
});
test('already effective merged context is unchanged without writing the first-file empty value or starting any file stage', async () => {
  const adapter = await file('src/service/adapters/namespace-file.ts'), op = await file('src/service/operations/context.ts');
  assert.ok(adapter.includes('unchanged = merged.currentContext === context') && adapter.includes('unchanged ? destination.body : contextDocument(destination.body, previous, context, true)'));
  ordered(op.slice(op.indexOf('async function execute(')), 'if (record.plan.unchanged)', "result: 'unchanged'", 'return;', 'options.files.commit(');
  assert.ok(op.includes('bundle.previous !== previous') && op.includes('Buffer.byteLength(JSON.stringify(outcome)) > 28_000'));
});
test('strict source DTOs/client matching and diagnostic UI expose all origins without enabling unrelated multi-file writers', async () => {
  const schema = await file('src/shared/context-protocol.ts'), client = await file('src/host/context-client.ts'), panel = await file('src/panel/main.ts'), view = await file('src/panel/context-view.ts');
  assert.ok(schema.includes('selection: configSelectionSchema') && schema.includes('sources: z.array(contextSourceSchema).min(1).max(64)') && schema.includes('destination.version === value.version'));
  assert.ok(client.includes('JSON.stringify(a.sources) === JSON.stringify(b.sources)') && client.includes('JSON.stringify([...new Set(selection.paths)])'));
  const use = panel.slice(panel.indexOf('const use = mountButton(action,'), panel.indexOf('const remove = mountButton(action,'));
  assert.ok(!use.includes("sources.mode === 'merge'") && !panel.slice(panel.indexOf('const remove = mountButton(action,'), panel.indexOf('return row;', panel.indexOf('const remove = mountButton(action,'))).includes("sources.mode === 'merge'"));
  assert.ok(view.includes('Change kubeconfig current-context') && view.includes('value.sources.map(') && view.includes('value.contextOrigin'));
});
test('source snapshots are protocol-only in readonly tests; planner/controller/adapter/confirmation remain absent from executable test imports', async () => {
  const read = await file('tests/readonly/context-source-snapshot.test.ts'), planner = await file('src/service/operations/context-document.ts'), adapter = await file('src/service/adapters/namespace-file.ts');
  assert.ok(!/from ['"].*(?:service\/|host\/|panel\/)/.test(read));
  assert.ok(planner.includes('allowExternalContext = false') && planner.includes('!allowExternalContext && !config.contexts?.some'));
  assert.ok(adapter.includes('externalContext: true') && adapter.includes('plan.externalContext === true'));
  assert.ok(!/toString\(|stringify\(doc|spawn\(/.test(planner));
});
