// Source text only; never import a write planner/client/adapter/operation, or run prepare/submit/cancel/no-op.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (text: string, ...parts: string[]) => { let offset = -1; for (const part of parts) { const next = text.indexOf(part, offset + 1); assert.ok(next > offset, part); offset = next; } };
test('fixed set-context creates a missing stanza but rejects empty current names, then ModifyConfig uses default destination only without origin', async () => {
  const set = await file('tests/fixtures/contracts/query-contract/kubernetes/kubectl/pkg/cmd/config/set_context.go.txt'), modify = await file('tests/fixtures/contracts/query-contract/kubernetes/client-go/tools/clientcmd/config.go.txt');
  ordered(set, 'if o.currContext', 'if len(config.CurrentContext) == 0', 'startingStanza, exists := config.Contexts[name]', 'if !exists', 'clientcmdapi.NewContext()', 'o.modifyContext(*startingStanza)', 'clientcmd.ModifyConfig(');
  ordered(modify.slice(modify.indexOf('for key, context := range newConfig.Contexts')), 'context.LocationOfOrigin', 'if len(destinationFile) == 0', 'configAccess.GetDefaultFilename()');
});
test('missing stanza is rebound by configuration identity/current name/missingness in prepare and submit, without resource authentication', async () => {
  const op = await file('src/service/operations/namespace.ts');
  assert.ok(op.includes("entry?.value.namespace || 'default', contextMissing: !entry") && op.includes('value.merged.currentContext !== context'));
  assert.ok(op.includes("target.contextMissing !== (record.outcome.contextAction === 'create')") && op.includes('after.contextMissing !== target.contextMissing'));
  assert.ok(op.includes("(bundle.contextAction === 'create') !== target.contextMissing") && !/bindResourceTarget|privateKubectlConfiguration|spawn\(/.test(op));
});
test('source adapter distinguishes existing stanza origin from missing-stanza first existing file and never creates an absent destination', async () => {
  const code = await file('src/service/adapters/namespace-file.ts'), part = code.slice(code.indexOf('async inspectNamespaceSources('), code.indexOf('async verifyNamespaceSources('));
  ordered(part, 'contextSources(paths, target.context', 'merged.contexts.get(target.context)', '(!context) !== (target.contextMissing === true)', 'context ? values.find(value => value.path === context.sourcePath) : values[0]', "throw new BoundaryError('CONFIG_NOT_FOUND')", 'namespaceCreateDocument(destination.body');
  assert.ok(part.includes('!!context && namespace === target.namespace') && part.includes('createContext: true') && part.includes("contextAction: context ? 'update'"));
});
test('creation planner only inserts a namespace-only stanza using source ranges for absent/null/block/flow collections, never serializing credentials', async () => {
  const code = await file('src/service/operations/namespace-create-document.ts');
  assert.ok(code.includes('JSON.stringify({ name: contextName, context: { namespace } })') && code.includes('config.contexts?.some(entry => entry.name === contextName)'));
  for (const part of ['doc.contents === null', "!doc.contents.has('contexts')", 'doc.contents.flow', 'contexts.value === null', 'contexts.flow', "source[start] !== '-'", 'source.slice(0, end)', 'source.slice(contexts.range[1])']) assert.ok(code.includes(part), part);
  assert.ok(!/toString\(|stringify\(doc|toJS\(|writeFile|spawn\(|console\.|process\.env|adapters\//.test(code));
});
test('creation refuses unsafe AST/complex insertion and verifies original current scalar plus one namespace-only entry after insertion', async () => {
  const code = await file('src/service/operations/namespace-create-document.ts');
  for (const part of ['isAlias(node)', 'node.tag || node.anchor', "pair.key.value === '<<'", 'depth > 64', 'nodes > 50_000', 'doc.errors.length || doc.warnings.length', "after['current-context'] !== config['current-context']", '(config.contexts?.length ?? 0) + 1', 'created.context.cluster !== undefined', 'created.context.user !== undefined']) assert.ok(code.includes(part), part);
});
test('new creation shares unique staging/commit gate and is never swallowed by same-default no-op; full sources rechecked after stage', async () => {
  const op = await file('src/service/operations/namespace.ts'), adapter = await file('src/service/adapters/namespace-file.ts');
  ordered(op.slice(op.indexOf('async function execute(')), 'options.lock.run(', 'verifyNamespaceSources(', '!record.plan.createContext && record.plan.previous === record.plan.namespace', 'options.files.commit(', '() => options.files.verifyNamespaceSources(');
  const commit = adapter.slice(adapter.indexOf('async commit(')); ordered(commit, 'plan.createContext ? namespaceCreateDocument(', 'hash(next) !== plan.intended', 'beforeStage();', 'await staged.sync()', 'if (recheckSources) await recheckSources()', 'beforeCommit(); attempted = true', 'await rename(');
  assert.equal(adapter.match(/await rename\(/g)?.length, 1);
  assert.ok(adapter.includes('bundle.plan.createContext && source.path === bundle.plan.path ? { ...source, definesContext: true } : source'));
});
test('strict outcome/client/UI bind and disclose create/update action, enable only a parsed nonempty current name, and keep destructive gates separate', async () => {
  const client = await file('src/host/namespace-client.ts'), view = await file('src/panel/namespace-view.ts'), panel = await file('src/panel/main.ts'), deletion = await file('src/service/operations/namespace-delete.ts');
  assert.ok(client.includes('left.contextAction === right.contextAction') && view.includes('CREATE missing context (namespace only)') && view.includes('value.contextAction'));
  assert.ok(panel.includes("state.config?.status === 'ready' && !!state.config.currentContext") && !panel.includes('!state.config.currentContextMissing'));
  assert.ok(deletion.includes('bindResourceTarget(') && deletion.includes('privateKubectlConfiguration(config.merged, target).fill(0)'));
});
test('creation outcome schema rejects missing actions, wrong destinations and unchanged-create, while readonly tests have no write dependencies', async () => {
  const schema = await file('src/shared/namespace-protocol.ts'), testSource = await file('tests/readonly/namespace-create-snapshot.test.ts');
  assert.ok(schema.includes("contextAction: z.enum(['update', 'create'])") && schema.includes("value.result !== 'unchanged'") && schema.includes("source.status === 'present'"));
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|bridge|namespace-client)/.test(testSource));
});
