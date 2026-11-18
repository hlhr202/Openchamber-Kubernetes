// SOURCE ONLY: no import/call of namespaceDocument, lock, client, adapter or operation handler.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
function ordered(text: string, ...parts: string[]) { let offset = -1; for (const part of parts) { const next = text.indexOf(part, offset + 1); assert.ok(next > offset, part); offset = next; } }

test('Use Namespace pinned source changes current-context namespace, refreshes after success, and has distinct cancel/free text branches', async () => {
  const source = await file('tests/fixtures/baseline/kubernetes/src/components/kubectl/namespace.ts.txt');
  assert.ok(source.includes('switchNamespace(kubectl, explorerNode.name)') && source.includes('filterNames: [currentNS]') && source.includes('skipFreeTextPrompt: isMinimalWorkflow'));
  assert.ok(source.includes('currentNS !== toSwitchNamespace') && source.includes('refreshExplorer()'));
  const utils = await file('tests/fixtures/baseline/kubernetes/src/kubectlUtils.ts.txt');
  assert.ok(utils.includes('config current-context') && utils.includes('config set-context') && utils.includes('--namespace="${namespace}"'));
  const coverage = await file('docs/baseline/command-coverage.json'); assert.ok(coverage.includes('extension.vsKubernetesUseNamespace') && coverage.includes('M1-E023'));
});

test('namespace route authenticates and bounds JSON before a separate write controller; all writes share one alias-independent lock', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), lock = await file('src/service/operations/configuration-lock.ts');
  ordered(http, 'authorized(request.headers.authorization', "url.pathname === '/v2/operations/namespace'", 'boundedBody(request, controller.signal, resourceRequestBytes)', 'options.namespaces.handle(body, controller.signal)');
  assert.ok(http.includes('options.namespaces.close()'));
  assert.equal(main.match(/new ConfigurationWriteLock\(/g)?.length, 1);
  assert.ok(main.includes('new URL(import.meta.url)), lock') && main.includes('config, files, lock') && main.includes('files = createNamespaceFileAdapter(defaultPaths)'));
  for (const path of ['src/service/operations/delete.ts', 'src/service/operations/namespace.ts']) assert.ok((await file(path)).includes('options.lock.run(record.controller.signal'));
  assert.ok(lock.includes('this.#queue.length >= 16') && lock.includes('signal.removeEventListener') && lock.includes('this.#active = false; this.#next()'));
});

test('namespace intent binds exact origin, opaque version, original current target, namespace and expiring service capability', async () => {
  const schema = await file('src/shared/namespace-protocol.ts'), op = await file('src/service/operations/namespace.ts');
  assert.ok(schema.includes("value.mode !== 'merge'") && schema.includes("step: z.literal('set-namespace'), dependencies: z.tuple([])"));
  ordered(op, 'const target = await configuration(', 'options.files.inspectNamespaceSources(request.selection, target, request.namespace, signal)', 'const after = await configuration(', 'capability = randomBytes(32)');
  assert.ok(op.includes('proof: digest(capability)') && op.includes('Date.now() + 60_000') && op.includes('timingSafeEqual(record.proof, digest(grant.capability))'));
  ordered(op.slice(op.indexOf('async function execute')), 'options.lock.run(', 'current(record); update(record,', 'await configuration(', 'target.namespace !== record.outcome.previous', 'options.files.commit(');
  assert.ok(op.includes("record.outcome.phase !== 'prepared'") && op.includes('Detached from HTTP disconnect'));
});

test('configuration replacement validates secure ownership, non-links, original version and same-directory exclusive staging before rename', async () => {
  const adapter = await file('src/service/adapters/namespace-file.ts');
  assert.ok(adapter.includes('await realpath(path) !== path') && adapter.includes('value.mode & 0o022n') && adapter.includes('before.nlink !== 1n'));
  assert.ok(adapter.includes('constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW') && adapter.includes("createHmac('sha256', key)"));
  ordered(adapter.slice(adapter.indexOf('async commit(')), 'await snapshot(plan.path, signal)', 'value.version !== plan.version', 'hash(next) !== plan.intended', 'beforeStage();', 'constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW', 'await staged.sync()', 'await snapshot(plan.path, signal)', 'stage.ino !== owned.ino', 'beforeCommit(); attempted = true;', 'await rename(temporary, plan.path)');
  assert.ok(adapter.includes('staged.chown(value.uid, value.gid)') && adapter.includes('staged.chmod(value.mode)') && adapter.includes('await parent.sync()'));
  ordered(adapter, 'await rename(temporary, plan.path)', 'await staged.chmod(value.mode)');
  assert.ok(adapter.includes("phase: attempted ? 'unknown' : 'failed'") && adapter.includes("cleanup: 'manual-check'"));
  assert.ok(!/console\.|spawn\(|exec\(|rm\(|recursive:|process\.env|toJS\(/.test(adapter));
});

test('namespace source-range edit preserves unrelated bytes instead of reserializing credentials or arbitrary unknown numbers', async () => {
  const planner = await file('src/service/operations/namespace-document.ts');
  assert.ok(planner.includes('source.slice(0, value.range[0]) + JSON.stringify(namespace) + source.slice(value.range[1])'));
  assert.ok(planner.includes('isAlias(node)') && planner.includes('node.tag || node.anchor') && planner.includes("pair.key.value === '<<'"));
  assert.ok(planner.includes('else if (mapping.flow)') && planner.includes('!mapping.range || !isScalar(key)') && planner.includes('depth > 64') && planner.includes('nodes > 50_000'));
  assert.ok(planner.includes('const after = parseConfig(next)') && planner.includes('changed?.context.namespace !== namespace'));
  assert.ok(!/toString\(|stringify\(doc|writeFile|spawn\(|console\.|toJS\(/.test(planner));
});

test('cancel cannot undo committing, staging cleanup is exact, and unknown results are never auto-replayed or evicted', async () => {
  const op = await file('src/service/operations/namespace.ts'), adapter = await file('src/service/adapters/namespace-file.ts');
  assert.ok(op.includes("['prepared', 'queued', 'checking'].includes(record.outcome.phase)") && op.includes("update(record, 'cancelling'") && op.includes("clearTimeout(timer); update(record, 'committing')"));
  assert.ok(op.includes("phase === 'staging' ? { cleanup: 'pending'") && op.includes("record.outcome.phase === 'cancelling' && result.cleanup === 'none'"));
  assert.ok(op.includes("['succeeded', 'failed', 'cancelled'].includes(record.outcome.phase)") && op.includes('records.size >= 64'));
  assert.ok(adapter.includes('temporary && stagedCreated && !committed') && adapter.includes('value.ino !== owned.ino || value.dev !== owned.dev') && adapter.includes('await unlink(temporary)'));
  assert.ok(!/records\.clear\(|setInterval|\.retry\(|rollback/.test(op));
});

test('SDK controls are explicit with isolated history, project invalidation and a separate read-only reload; readonly tests cannot reach writers', async () => {
  const client = await file('src/host/namespace-client.ts'), view = await file('src/panel/namespace-view.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(client.includes('this.#calls >= 4') && client.includes('never a second submit') && client.includes('!same(response.outcome, original)'));
  assert.ok(client.includes('revision !== this.#historyRevision') && client.includes('value.configuration.serviceGeneration !== response.serviceGeneration'));
  assert.ok(view.includes("variant: 'destructive'") && view.includes('submitNamespace()') && view.includes('bridge()?.reload()') && view.includes('row.textContent = logDisplayText('));
  assert.ok(bridge.includes('new NamespaceClient(request => host.serviceRequest(request), showNamespace)') && bridge.includes("if (state.phase !== 'ready' && !namespaceReload)") && bridge.includes('namespaces.dispose()'));
  assert.ok(!/setInterval|localStorage|storageSet|innerHTML|clipboard|sendMessage/.test(client + view));
  const boundaries = await file('scripts/check-static.ts'); assert.ok(boundaries.includes('namespace-file') && boundaries.includes('namespace-client'));
});

test('tree and diagnostics switch in place; direct and confirmation paths both wait for disk success before reading configuration and the new tree', async () => {
  const panel = await file('src/panel/main.ts'), bridge = await file('src/host/bridge.ts');
  const dispatch = panel.slice(panel.indexOf("case 'extension.vsKubernetesUseNamespace'"), panel.indexOf("case 'extension.vsKubernetesShowEvents'"));
  assert.ok(dispatch.includes('useNamespace(scope.name, parent.entry.query.target)') && !/navigateTo|prepareNamespace|submitNamespace/.test(dispatch));
  assert.ok(panel.includes('useNamespace(eventScope.name, sourceTarget)') && panel.includes('onNamespaceSwitch(next'));
  const chain = bridge.slice(bridge.indexOf('async function runNamespaceSwitch'), bridge.indexOf('onManifestCreate:'));
  ordered(chain, 'namespaceSwitchBusy', 'sameTarget(before,', 'await namespaces.submit()', 'await namespaces.switchTo(', "outcome?.phase !== 'succeeded'", 'await client.reload()', 'fresh.currentContextInfo?.namespace !== name', 'tree.reopenNamespaceFolders(previousTree, next)');
  assert.ok(bridge.includes('submitNamespace: () => runNamespaceSwitch(undefined)') && !chain.includes('tree.refreshAll()'));
});

test('exact namespace status cannot enqueue work and is the only retry after an uncertain submit acknowledgement', async () => {
  const client = await file('src/host/namespace-client.ts'), op = await file('src/service/operations/namespace.ts');
  ordered(op, 'const record = owned(request.grant)', "request.kind === 'status'", "request.kind === 'cancel'", "update(record, 'queued')", 'void execute(record)');
  const submit = client.slice(client.indexOf('async submit()'), client.indexOf('async outcomes('));
  assert.equal(submit.match(/kind: 'submit'/g)?.length, 1);
  ordered(submit, "kind: 'submit', grant", 'performance.now() + 12_000', 'attempt >= 40', "kind: 'status', grant", 'if (!current()) return;', 'accept(response);', "'OPERATION_UNKNOWN'");
  const direct = client.slice(client.indexOf('async switchTo('), client.indexOf('async submit()'));
  ordered(direct, 'this.prepare(configuration, selection, context, namespace, true)', 'await preparation', '!stillCurrent()', 'return this.submit()');
});
