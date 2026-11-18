// TEXT ONLY. Do not import, construct or invoke any context-delete planner/controller/client/writer, including no-op paths.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (text: string, ...parts: string[]) => { let offset = -1; for (const part of parts) { const at = text.indexOf(part, offset + 1); assert.ok(at > offset, part); offset = at; } };

test('fixed deletion sources retain current-context, delete exact cluster/context maps and expose the upstream dotted user-navigation limitation', async () => {
  const context = await file('tests/fixtures/contracts/query-contract/kubernetes/kubectl/pkg/cmd/config/delete_context.go.txt'), cluster = await file('tests/fixtures/contracts/query-contract/kubernetes/kubectl/pkg/cmd/config/delete_cluster.go.txt'), user = await file('tests/fixtures/contracts/query-contract/kubernetes/kubectl/pkg/cmd/config/unset.go.txt');
  ordered(context, 'config.CurrentContext == name', 'warning: this removed your active context', 'delete(config.Contexts, name)', 'clientcmd.ModifyConfig(');
  assert.ok(!/config\.CurrentContext\s*=(?!=)/.test(context));
  ordered(cluster, 'config.Clusters[name]', 'delete(config.Clusters, name)', 'clientcmd.ModifyConfig(');
  assert.ok(user.includes('Map keys may not contain dots') && user.includes('modifyConfig(reflect.ValueOf(config), steps, "", true, true)'));
});
test('context-delete is a bounded authenticated route with one shared writer and lock, not a CLI or arbitrary file executor', async () => {
  const main = await file('src/service/runtime/main.ts'), http = await file('src/service/runtime/http.ts'), op = await file('src/service/operations/context-delete.ts');
  ordered(http, 'authorized(request.headers.authorization', "url.pathname === '/v2/operations/context-delete'", 'boundedBody(request, controller.signal, resourceRequestBytes)', 'options.contextDeletes.handle(body, controller.signal)');
  assert.equal(main.match(/new ConfigurationWriteLock\(/g)?.length, 1); assert.ok(main.includes('createContextDeleteOperations({ serviceGeneration, config, files, lock })') && http.includes('options.contextDeletes.close()'));
  assert.ok(!/spawn\(|invokeCommand|bindResourceTarget|privateKubectlConfiguration|resources\./.test(op));
});
test('shared cluster/user references are explicitly retained and missing/empty entries skipped, with exact names rather than dotted unset interpretation', async () => {
  const planner = await file('src/service/operations/context-delete-document.ts'), view = await file('src/panel/context-delete-view.ts');
  assert.ok(planner.includes('value.name !== context && value.context.cluster === cluster') && planner.includes('value.name !== context && value.context.user === user'));
  assert.ok(planner.includes("phase: name && exists && !sharedReferences ? 'planned' : 'skipped'") && planner.includes("'shared' : 'exclusive'"));
  assert.ok(planner.includes("value.get('name') === name") && planner.includes("after['current-context'] !== config['current-context']"));
  assert.ok(view.includes('Delete kubeconfig entries, not the cluster') && view.includes('may leave it unresolved'));
});
test('source-range deletion is block-only, budgeted, reparsed and preserves unrelated bytes without serializing private fields', async () => {
  const planner = await file('src/service/operations/context-delete-document.ts');
  assert.ok(planner.includes('isAlias(node)') && planner.includes('node.tag || node.anchor') && planner.includes("pair.key.value === '<<'"));
  assert.ok(planner.includes('count > 50_000 || depth > 64') && planner.includes('sequence.flow') && planner.includes('target.flow'));
  ordered(planner.slice(planner.indexOf('export function deleteEntryDocument(')), 'const start = source.lastIndexOf(', 'target.range[2]', "sequence.items.length === 1", 'source.slice(0, start) + replacement + source.slice(end)', 'after = parseConfig(next)', 'length - 1');
  assert.ok(!/toJS\(|toString\(|stringify\(doc|writeFile|console\.|spawn\(/.test(planner));
});
test('confirmed before/after content hashes bind later file versions and all three replacements reuse the original exclusive stage/rename engine', async () => {
  const adapter = await file('src/service/adapters/namespace-file.ts');
  ordered(adapter.slice(adapter.indexOf('async inspectContextDeletion(')), 'contextDeleteDescription(value.body, context)', 'deleteEntryDocument(body, section, step.name, context)', 'previousBody: hash(body)', 'async rebaseEntry(', 'value.version !== expectedVersion', 'hash(value.body) !== plan.previousBody', 'version: value.version');
  assert.ok(adapter.includes('versionAfter: after.version'));
  ordered(adapter.slice(adapter.indexOf('async commit(')), 'value.version !== plan.version', 'hash(value.body) !== plan.previousBody', 'deleteEntryDocument(value.body, plan.section, plan.name, plan.deletingContext, plan.externalContext === true)', 'hash(next) !== plan.intended', 'beforeStage()', 'constants.O_EXCL', 'beforeCommit()', 'await rename(');
  assert.equal(adapter.match(/await rename\(/g)?.length, 1); assert.equal(adapter.match(/constants.O_WRONLY \| constants.O_CREAT/g)?.length, 1);
});
test('one lock encloses baseline recheck and ordered dependent steps; non-success blocks continuation and committed success is not overwritten on later verification failure', async () => {
  const op = await file('src/service/operations/context-delete.ts');
  ordered(op.slice(op.indexOf('async function execute(')), 'options.lock.run(', 'await configuration(', 'options.files.inspectContextDeletionSources(', 'JSON.stringify(fresh) !== JSON.stringify(record.bundle)', 'for (index = 0; index < 3; index++)', 'options.files.verifyContextDeletionSources(', 'options.files.rebaseEntry(', 'options.files.commit(record.outcome.id', "result.phase !== 'succeeded'", 'return;', 'versions.set(plan.path, result.versionAfter)', 'options.files.verifyContextDeletionSources(record.bundle, index + 1');
  assert.ok(op.includes("!['skipped', 'planned', 'succeeded'].includes(value.phase)") && op.includes('if (!committing) record.controller.abort()'));
  assert.ok(op.includes("record.outcome.steps[n]?.phase === 'planned'") && op.includes("phase: 'blocked'"));
});
test('capability/expiry/dedupe/cancel/unknown original outcomes are bounded and never replayed, including shutdown between dependent steps', async () => {
  const op = await file('src/service/operations/context-delete.ts'), schema = await file('src/shared/context-delete-protocol.ts');
  assert.ok(op.includes('timingSafeEqual(record.proof, digest(request.grant.capability))') && op.includes('Date.now() + 60_000') && op.includes('records.size >= 64'));
  ordered(op.slice(op.indexOf('const record = records.get(request.grant.id)')), "record.outcome.phase !== 'prepared'", "phase: 'queued'", 'void execute(record)');
  assert.ok(op.includes('!record.active &&') && op.includes('record.cancelled = true') && op.includes('record.active = false'));
  assert.ok(schema.includes('steps: z.tuple(') && schema.includes('configuration: contextConfigurationSchema'));
  assert.ok(!/setInterval|records\.clear\(|rollback\(|\.retry\(/.test(op));
});
test('diagnostic row action, explicit confirmation and original-result reads are connected, with graph protection and no automatic write testing', async () => {
  const client = await file('src/host/context-delete-client.ts'), view = await file('src/panel/context-delete-view.ts'), bridge = await file('src/host/bridge.ts'), panel = await file('src/panel/main.ts'), graph = await file('scripts/check-static.ts');
  assert.ok(bridge.includes('new ContextDeleteClient(request => host.serviceRequest(request), showContextDelete)') && bridge.includes('contextDeletes.reset()') && bridge.includes('contextDeletes.dispose()'));
  assert.ok(panel.includes('bridge?.prepareContextDelete(context.name)') && panel.includes('contextDeletes.show(nextState)'));
  assert.ok(client.includes('this.#calls >= 4') && client.includes('revision !== this.#historyRevision') && client.includes('same(response.outcome, original)'));
  assert.ok(view.includes("variant: 'destructive'") && view.includes('submitContextDelete()') && view.includes('bridge()?.reload()'));
  assert.ok(!/setTimeout|setInterval|innerHTML|localStorage|clipboard|sendMessage/.test(client + view));
  assert.ok(graph.includes('context-delete-client') && graph.includes('context-delete-view'));
});
