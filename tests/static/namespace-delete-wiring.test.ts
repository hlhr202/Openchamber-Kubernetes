// SOURCE/AST BOUNDARIES ONLY. Never import the chain, client, planner, lock or write worker.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
function ordered(text: string, ...parts: string[]) { let offset = -1; for (const part of parts) { const next = text.indexOf(part, offset + 1); assert.ok(next > offset, part); offset = next; } }

test('Namespace baseline covers default/content warnings and real switch-before-delete, including the upstream ignored boolean that must not be copied', async () => {
  const source = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt'), utils = await file('tests/fixtures/baseline/kubernetes/src/kubectlUtils.ts.txt');
  ordered(source.slice(source.indexOf('async function deleteKubernetes')), 'showWarningMessage', 'confirmDangerousNamespaceDeletion', 'currentNamespace(kubectl)', 'switchNamespace(kubectl, "default")', 'invokeCommandWithFeedback');
  assert.ok(source.includes("if (ns === 'default')") && source.includes("Can't check if namespace") && source.includes('resources.result.length > 0'));
  assert.ok(utils.includes("readTable('api-resources -o wide')") && utils.includes("r.verbs.includes('list')") && utils.includes('--ignore-not-found'));
});
test('Namespace route remains bearer-authenticated and separate from ordinary Delete; private worker alone adds Namespace standard mode', async () => {
  const http = await file('src/service/runtime/http.ts'); ordered(http, 'authorized(request.headers.authorization', "url.pathname === '/v2/operations/namespace-delete'", 'boundedBody(request, controller.signal, resourceRequestBytes)', 'options.namespaceDeletes.handle(body, controller.signal)');
  assert.ok((await file('src/shared/delete-protocol.ts')).includes("ref.type.resource !== 'namespaces'"));
  const worker = await file('src/service/operations/delete-worker-protocol.ts'); assert.ok(worker.includes("reference: namespaceDeleteReferenceSchema, mode: z.literal('standard')"));
  assert.ok((await file('src/service/runtime/main.ts')).includes('files, lock, execute: executeDelete'));
});
test('one shared lock encloses inventory/config write/post-commit target rebinding/dependent Delete without nested handlers or locks', async () => {
  const op = await file('src/service/operations/namespace-delete.ts'); assert.equal(op.match(/options\.lock\.run\(/g)?.length, 1);
  ordered(op, 'await options.lock.run(', 'options.resources.namespaceInventory(', 'inventory.digest !== record.outcome.inventory.digest', 'options.files.commit(', "result.phase !== 'succeeded'", 'current(record); // Successful config commit', 'versionAfter = result.versionAfter', 'await verifySources()', "namespace: 'default'", 'targetAfter: target', 'after.digest !== record.outcome.inventory.digest', "['succeeded', 'skipped'].includes", 'options.resources.verifyReference(', 'await verifySources()', 'options.execute(');
  assert.ok(!/\.handle\(|new ConfigurationWriteLock|createNamespaceOperations\(|createDeleteOperations\(/.test(op));
});
test('separate risk acknowledgements, expiring capability, same-ticket dedupe and immutable original target bind the whole chain', async () => {
  const op = await file('src/service/operations/namespace-delete.ts'), schema = await file('src/shared/namespace-delete-protocol.ts');
  assert.ok(schema.includes('acknowledgeDelete: z.literal(true)') && schema.includes('acknowledgeDefault: z.boolean()') && schema.includes('acknowledgeContents: z.boolean()'));
  assert.ok(op.includes("request.reference.name === 'default' && !request.acknowledgeDefault") && op.includes("inventory.status === 'unknown' || record.outcome.inventory.count !== 0"));
  assert.ok(op.includes('privateKubectlConfiguration(config.merged, target).fill(0)') && op.includes('Date.now() + 60_000') && op.includes('proof: digest(capability)'));
  assert.ok(op.includes("phase: 'failed', code: 'CONFIRMATION_EXPIRED'") && !op.includes("record.expiresAt <= now) cancel(record)"));
  ordered(op.slice(op.indexOf('const record = records.get(request.grant.id)')), "record.outcome.phase !== 'prepared'", "update(record, { phase: 'queued' }); void execute(record)");
});
test('unknown/failed/cancelled config never starts dependent deletion, active records cannot be evicted, and post-dispatch result remains original', async () => {
  const op = await file('src/service/operations/namespace-delete.ts');
  assert.ok(op.includes("deleteNamespace: { ...record.outcome.deleteNamespace, phase: 'blocked' }") && op.includes("if (result.phase !== 'succeeded')"));
  assert.ok(op.includes('!record.active &&') && op.includes("['completed', 'failed', 'cancelled'].includes"));
  assert.ok(op.includes("if (record.active) update(record, { phase: 'cancelling' })") && op.includes("deleteNamespace.phase === 'dispatching'"));
  assert.ok(!/records\.clear\(|rollback\(|retry\(|setInterval/.test(op));
});
test('inventory shares the original global reader pool, with essential Namespace GETs around bounded read-only discovery and no object values in summaries', async () => {
  const reader = await file('src/service/queries/resource-reader.ts'), inventory = await file('src/service/queries/namespace-inventory.ts');
  assert.equal(reader.match(/new ReadScheduler/g)?.length, 1);
  ordered(reader.slice(reader.indexOf('async namespaceInventory(')), 'scheduler.run(', 'await check();', 'AbortSignal.timeout(6000)', 'collectNamespaceInventory(', "status: 'unknown', count: null", 'await check(); await verify(target');
  assert.ok(inventory.includes('pages > 128') && inventory.includes('count > 10_000') && inventory.includes("type.scope === 'namespace'"));
  assert.ok(!/from ['"][^'"]*(operations|adapters|sessions)\//.test(inventory));
});
test('SDK/initial and final confirmation views are explicit and lifecycle guarded; automatic suites cannot reach write controllers', async () => {
  const client = await file('src/host/namespace-delete-client.ts'), panel = await file('src/panel/namespace-delete-view.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(client.includes('this.#calls >= 4') && client.includes('Never retry a submission automatically') && client.includes('revision !== this.#historyRevision'));
  assert.ok(panel.includes('general.input.checked') && panel.includes('dangerous.input.checked') && panel.includes('content.input.checked') && panel.includes("variant: 'destructive'"));
  assert.ok(bridge.includes('new NamespaceDeleteClient(request => host.serviceRequest(request), showNamespaceDelete)') && bridge.includes('namespaceDeletes.reset()') && bridge.includes('namespaceDeletes.dispose()'));
  assert.ok((await file('scripts/check-static.ts')).includes('namespace-delete-client'));
  assert.ok(!/setTimeout|setInterval|innerHTML|localStorage|storageSet|clipboard|sendMessage/.test(client + panel));
});
