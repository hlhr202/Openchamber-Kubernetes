// Text only. Never import or invoke the namespace/source planner, controller, client, hook or writer, including no-op/mock branches.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (text: string, ...parts: string[]) => { let offset = -1; for (const part of parts) { const at = text.indexOf(part, offset + 1); assert.ok(at > offset, part); offset = at; } };

test('fixed context-stanza LocationOfOrigin differs from current-context default destination and drives the namespace bundle', async () => {
  const source = await file('tests/fixtures/contracts/query-contract/kubernetes/client-go/tools/clientcmd/config.go.txt'), adapter = await file('src/service/adapters/namespace-file.ts');
  ordered(source.slice(source.indexOf('for key, context := range newConfig.Contexts')), 'destinationFile := context.LocationOfOrigin', 'configAccess.GetDefaultFilename()', 'configToWrite.Contexts[key] = context');
  const inspect = adapter.slice(adapter.indexOf('async inspectNamespaceSources('), adapter.indexOf('async verifyNamespaceSources('));
  ordered(inspect, 'resolveConfigSelection(', 'contextSources(paths, target.context', 'mergeConfigSources(', 'merged.contexts.get(target.context)', 'values.find(value => value.path === context.sourcePath)', 'namespaceDocument(destination.body, target.context, target.namespace, namespace, true)');
  assert.ok(!inspect.includes('const destination = values[0]') && inspect.includes('contextOrigin: context?.sourcePath ?? destination.path'));
});
test('namespace planner permits an externally supplied effective current but must preserve the origin file current-context and all unrelated bytes', async () => {
  const planner = await file('src/service/operations/namespace-document.ts'), adapter = await file('src/service/adapters/namespace-file.ts');
  assert.ok(planner.includes('allowExternalCurrent = false') && planner.includes("!allowExternalCurrent && config['current-context'] !== contextName"));
  assert.ok(planner.includes("after['current-context'] !== config['current-context']") && planner.includes('changed?.context.namespace !== namespace'));
  assert.ok(adapter.includes('target && plan.contextName !== target.context') && adapter.includes('plan.contextName ?? target?.context') && adapter.includes('plan.externalCurrent === true'));
  assert.ok(!/stringify\(doc|toString\(|writeFile|spawn\(/.test(planner));
});
test('all sources are rechecked inside the same lock and after staging before final file/stage/expiry gate in the only writer', async () => {
  const op = await file('src/service/operations/namespace.ts'), adapter = await file('src/service/adapters/namespace-file.ts');
  ordered(op.slice(op.indexOf('async function execute(')), 'options.lock.run(', 'await configuration(', 'await options.files.verifyNamespaceSources(', 'options.files.commit(', '() => options.files.verifyNamespaceSources(');
  ordered(adapter.slice(adapter.indexOf('async commit(')), 'await staged.sync()', 'if (recheckSources) await recheckSources()', 'const current = await snapshot(', 'stage.ino !== owned.ino', 'beforeCommit(); attempted = true', 'await rename(');
  assert.equal(adapter.match(/await rename\(/g)?.length, 1);
});
test('unchanged effective namespace never creates a stage, read-only tails remain allowed, and source metadata has bounded results', async () => {
  const op = await file('src/service/operations/namespace.ts'), adapter = await file('src/service/adapters/namespace-file.ts');
  ordered(op.slice(op.indexOf('async function execute(')), 'record.plan.previous === record.plan.namespace', "result: 'unchanged'", 'return;', 'options.files.commit(');
  assert.ok(adapter.includes('namespace === target.namespace') && adapter.includes('snapshot(path, signal, false)') && adapter.includes('snapshot(destination.path, signal)'));
  assert.ok(op.includes('Buffer.byteLength(JSON.stringify(outcome)) > 28_000') && op.includes('Object.freeze(outcome.sources)'));
});
test('namespace merge schema/client/UI is independent of destructive-chain policies and shares no runtime source/control dependency cycle', async () => {
  const schema = await file('src/shared/namespace-protocol.ts'), common = await file('src/shared/configuration-source-protocol.ts'), context = await file('src/shared/context-protocol.ts'), client = await file('src/host/namespace-client.ts'), panel = await file('src/panel/main.ts');
  assert.ok(schema.includes('selection: configSelectionSchema') && schema.includes("value.mode !== 'merge'") && schema.includes('destination.path === value.path'));
  assert.ok(client.includes('JSON.stringify(left.sources) === JSON.stringify(right.sources)') && client.includes('JSON.stringify([...new Set(selection.paths)])'));
  assert.ok(panel.includes("namespaces.update(state.phase === 'ready' && state.config?.status === 'ready' && !!state.config.currentContext") && !panel.includes('namespaces.update(!!current && mode'));
  assert.ok(common.includes('Public metadata only') && !/namespace-protocol|context-protocol|service\//.test(common) && context.includes('contextSourceSchema = configurationSourceSchema'));
  assert.ok(!(await file('src/shared/context-delete-protocol.ts')).includes('namespaceOutcomeSchema')); // E011 has its own multi-step source policy.
  // Namespace deletion consumes its own reviewed multi-step source policy (E010), never this single-step outcome.
  assert.ok(!(await file('src/shared/namespace-delete-protocol.ts')).includes('namespaceOutcomeSchema'));
});
test('active records survive cancellation until writer settlement, expiry is failed not cancelled, and changed form invalidates confirmation without automatic writes', async () => {
  const op = await file('src/service/operations/namespace.ts'), view = await file('src/panel/namespace-view.ts'), readonly = await file('tests/readonly/namespace-source-snapshot.test.ts');
  assert.ok(op.includes('record.active = true') && op.includes('record.active = false') && op.includes('!record.active &&'));
  assert.ok(op.includes("update(record, 'failed', 'CONFIRMATION_EXPIRED')") && view.includes('bridge()?.closeNamespace(); field.update'));
  assert.ok(view.includes('current context’s default namespace') && view.includes('value.sources.map('));
  assert.ok(!/from ['"].*(?:service\/|host\/|panel\/)/.test(readonly) && !/setInterval|innerHTML|localStorage|clipboard|sendMessage/.test(view));
});
