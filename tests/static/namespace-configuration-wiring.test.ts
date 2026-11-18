// TEXT ONLY. Never import or invoke a namespace write controller/client/planner/confirmation/hook/writer, including no-op/mock.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (text: string, ...parts: string[]) => { let offset = -1; for (const part of parts) { const at = text.indexOf(part, offset + 1); assert.ok(at > offset, part); offset = at; } };

test('Use Namespace validates configuration identity/current stanza without a connected-resource or authentication requirement', async () => {
  const op = await file('src/service/operations/namespace.ts'), schema = await file('src/shared/namespace-protocol.ts');
  const source = await file('tests/fixtures/contracts/query-contract/kubernetes/kubectl/pkg/cmd/config/set_context.go.txt');
  ordered(source.slice(source.indexOf('func (o setContextOptions) run()')), 'o.configAccess.GetStartingConfig()', 'config.Contexts[name]', 'o.modifyContext(*startingStanza)', 'clientcmd.ModifyConfig(');
  const modify = source.slice(source.indexOf('func (o *setContextOptions) modifyContext('), source.indexOf('func (o *setContextOptions) complete('));
  assert.ok(modify.includes('modifiedContext.Namespace = o.namespace.Value()') && !/config\.Clusters|config\.AuthInfos|Validate\(/.test(modify));
  ordered(op.slice(op.indexOf('async function configuration(')), 'expected.serviceGeneration !== options.serviceGeneration', 'options.config.privateRead(selection, expected.configIdentity', 'value.merged.contexts.get(context)', 'value.merged.currentContext !== context', "entry?.value.namespace || 'default'");
  assert.ok(!/bindResourceTarget|privateKubectlConfiguration|\.available|spawn\(|resources\./.test(op));
  assert.ok(schema.includes('configuration: configurationIdentitySchema, context: boundedName') && !schema.includes('targetSchema'));
});
test('prepare and submit rebind the same configuration and namespace, then preserve source/no-op/stage/expiry/unknown gates in the original lock', async () => {
  const op = await file('src/service/operations/namespace.ts');
  ordered(op.slice(op.indexOf("if (request.kind === 'prepare')")), 'await configuration(request.selection, request.configuration, request.context', 'inspectNamespaceSources(', 'const after = await configuration(', 'after.namespace !== target.namespace', 'capability = randomBytes(32)');
  ordered(op.slice(op.indexOf('async function execute(')), 'options.lock.run(', 'await configuration(record.selection, record.outcome.configuration, record.outcome.context', 'target.namespace !== record.outcome.previous', 'verifyNamespaceSources(', 'record.plan.previous === record.plan.namespace', 'options.files.commit(record.outcome.id, record.plan, undefined', '() => options.files.verifyNamespaceSources(');
  assert.ok(op.includes("record.outcome.phase === 'committing' ? 'unknown'") && op.includes('!record.active &&'));
});
test('shared configuration identity has no namespace/context-protocol cycle and old Context aliases retain the same schema', async () => {
  const common = await file('src/shared/configuration-identity.ts'), context = await file('src/shared/context-protocol.ts'), namespace = await file('src/shared/namespace-protocol.ts');
  assert.ok(common.includes('configurationIdentitySchema = z.object') && !/namespace-protocol|context-protocol|service\//.test(common));
  assert.ok(context.includes('contextConfigurationSchema = configurationIdentitySchema') && namespace.includes("from './configuration-identity.ts'"));
});
test('namespace file plan carries a confirmed context name without fabricating a resource target while Namespace deletion retains its stronger binding', async () => {
  const adapter = await file('src/service/adapters/namespace-file.ts'), deletion = await file('src/service/operations/namespace-delete.ts');
  assert.ok(adapter.includes('!plan.contextName && !target') && adapter.includes('target && plan.contextName !== target.context') && adapter.includes('plan.contextName ?? target?.context'));
  assert.ok(deletion.includes('bindResourceTarget(') && deletion.includes('privateKubectlConfiguration(config.merged, target).fill(0)') && deletion.includes('options.resources.verifyReference('));
});
test('bridge/free-text form use globally disclosed current context even off-page, but cluster-resource targets still require an available active row', async () => {
  const bridge = await file('src/host/bridge.ts'), panel = await file('src/panel/main.ts'), view = await file('src/panel/namespace-view.ts');
  assert.ok(bridge.includes("client.selection, config?.currentContext ?? '', namespace") && bridge.includes('configurationReadTarget(config, `${viewId}:${projectRevision}`)'));
  assert.ok(panel.includes("namespaces.update(state.phase === 'ready' && state.config?.status === 'ready' && !!state.config.currentContext") && view.includes('missing context entry is explicitly shown'));
  assert.ok(panel.includes('config.currentContext ||') && !view.includes('value.target.context'));
});
test('global current metadata is projected from the complete merged snapshot and guarded across pages, with no write modules in readonly test imports', async () => {
  const page = await file('src/service/queries/config-page.ts'), config = await file('src/service/queries/kubeconfig.ts'), client = await file('src/host/configuration-client.ts'), dto = await file('tests/readonly/namespace-configuration-snapshot.test.ts');
  assert.ok(config.includes('currentContext: config.currentContext') && page.includes('currentContext: snapshot.currentContext'));
  assert.ok(client.includes('config.currentContext !== this.#config?.currentContext'));
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|namespace-client|bridge|panel\/)/.test(dto));
  const collector = await file('scripts/collect-query-contract.ts');
  assert.ok(collector.includes('pkg/cmd/config/set_context.go') && collector.includes('Existing pinned source omitted from collection') && collector.includes("evidence: 'M1-E049'"));
});
