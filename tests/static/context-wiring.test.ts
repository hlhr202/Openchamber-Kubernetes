// TEXT ONLY. Never import/call context client/controller/planner/adapter/lock, even with mocks.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
function ordered(text: string, ...parts: string[]) { let offset = -1; for (const part of parts) { const next = text.indexOf(part, offset + 1); assert.ok(next > offset, part); offset = next; } }

test('fixed use-context validates a named entry and only modifies configuration; current-context destination differs from stanza origin', async () => {
  const use = await file('tests/fixtures/contracts/query-contract/kubernetes/kubectl/pkg/cmd/config/use_context.go.txt');
  ordered(use, 'GetStartingConfig()', 'o.validate(config)', 'config.CurrentContext = o.contextName', 'clientcmd.ModifyConfig(');
  assert.ok(use.includes('len(o.contextName) == 0') && use.includes('range config.Contexts'));
  const config = await file('tests/fixtures/contracts/query-contract/kubernetes/client-go/tools/clientcmd/config.go.txt');
  const current = config.slice(config.indexOf('func writeCurrentContext('), config.indexOf('func writePreferences('));
  ordered(current, 'configAccess.IsExplicitFile()', 'len(newCurrentContext) > 0', 'configAccess.GetDefaultFilename()', 'for _, file := range configAccess.GetLoadingPrecedence()');
  assert.ok(config.includes('destinationFile := context.LocationOfOrigin') && config.includes('sort.Strings(possibleSources)'));
});
test('authenticated bounded context route is separate from reads and consumes the existing file adapter and one global write lock', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts');
  ordered(http, 'authorized(request.headers.authorization', "url.pathname === '/v2/operations/context'", 'boundedBody(request, controller.signal, resourceRequestBytes)', 'options.contexts.handle(body, controller.signal)');
  assert.equal(main.match(/new ConfigurationWriteLock\(/g)?.length, 1);
  assert.ok(main.includes('createContextOperations({ serviceGeneration, config, files, lock })') && http.includes('options.contexts.close()'));
});
test('context intent binds configuration not fabricated resource target and does not require active/available context or static auth', async () => {
  const schema = await file('src/shared/context-protocol.ts'), op = await file('src/service/operations/context.ts');
  assert.ok(schema.includes("step: z.literal('use-context'), dependencies: z.tuple([])") && schema.includes('configuration: contextConfigurationSchema'));
  assert.ok(!schema.includes('targetSchema') && !op.includes('bindResourceTarget') && !op.includes('privateKubectlConfiguration') && !op.includes('available'));
  ordered(op.slice(op.indexOf('async function configuration(')), 'expected.serviceGeneration !== options.serviceGeneration', 'options.config.privateRead(', 'value.merged.contexts.has(context)', 'value.merged.currentContext');
  assert.ok(op.includes('options.files.inspectContextSources(request.selection, request.context, signal)'));
});
test('file/context/version is rechecked under shared lock, staging and committing reuse the original owned writer without auth or CLI', async () => {
  const op = await file('src/service/operations/context.ts'), adapter = await file('src/service/adapters/namespace-file.ts');
  ordered(op.slice(op.indexOf('async function execute(')), 'options.lock.run(', 'current(record)', 'await configuration(', 'previous !== record.bundle.previous', 'options.files.verifyContextSources(record.bundle', 'options.files.commit(record.outcome.id, record.plan, undefined', "update(record, 'staging')", "update(record, 'committing')", '() => options.files.verifyContextSources(record.bundle');
  assert.ok(adapter.includes('contextDocument(value.body, previous, context)') && adapter.includes('contextDocument(value.body, plan.previous, plan.context, plan.externalContext === true)'));
  assert.equal(adapter.match(/await rename\(/g)?.length, 1); assert.equal(adapter.match(/constants.O_WRONLY \| constants.O_CREAT/g)?.length, 1);
});
test('context source edit changes only a scalar range or bounded root insertion and revalidates named target; it never reserializes private fields', async () => {
  const planner = await file('src/service/operations/context-document.ts');
  assert.ok(planner.includes("config['current-context'] ?? ''") && planner.includes('config.contexts?.some(value => value.name === context)'));
  assert.ok(planner.includes('source.slice(0, value.range[0]) + JSON.stringify(context) + source.slice(value.range[1])') && planner.includes('doc.contents.flow || !doc.contents.range'));
  assert.ok(planner.includes('isAlias(node)') && planner.includes('node.tag || node.anchor') && planner.includes("pair.key.value === '<<'"));
  assert.ok(planner.includes('nodes > 50_000 || depth > 64') && planner.includes("after['current-context'] !== context"));
  assert.ok(!/toJS\(|stringify\(doc|toString\(|writeFile|spawn\(|console\./.test(planner));
});
test('dedupe/expiry/cancel/unknown are original outcomes; active records stay retained through writer settlement and committing cannot be cancelled as rollback', async () => {
  const op = await file('src/service/operations/context.ts');
  assert.ok(op.includes('proof: digest(capability)') && op.includes('Date.now() + 60_000') && op.includes('timingSafeEqual(record.proof, digest(grant.capability))'));
  ordered(op.slice(op.indexOf('const record = owned(request.grant)')), "record.outcome.phase !== 'prepared'", "update(record, 'queued'); void execute(record)");
  assert.ok(op.includes("update(record, 'failed', 'CONFIRMATION_EXPIRED')") && op.includes('!record.active &&') && op.includes('record.active = false'));
  assert.ok(op.includes("['prepared', 'queued', 'checking'].includes") && op.includes("record.outcome.phase === 'cancelling' && result.cleanup === 'none'"));
  assert.ok(!/records\.clear\(|setInterval|rollback\(|\.retry\(/.test(op));
});
test('legacy source confirmation stays available; direct tree switching has bounded status polling and never retries a submit', async () => {
  const client = await file('src/host/context-client.ts'), view = await file('src/panel/context-view.ts'), bridge = await file('src/host/bridge.ts'), panel = await file('src/panel/main.ts');
  assert.ok(client.includes('this.#calls >= 4') && client.includes('Never automatically retry') && client.includes('revision !== this.#historyRevision'));
  assert.ok(bridge.includes('new ContextClient(request => host.serviceRequest(request), showContext)') && bridge.includes('contexts.reset()') && bridge.includes('contexts.dispose()'));
  assert.ok(panel.includes('bridge?.prepareContext(context.name)') && panel.includes('contexts.show(nextState)') && panel.includes('contextButtons.splice(0)'));
  assert.ok(view.includes("variant: 'destructive'") && view.includes('submitContext()') && view.includes('bridge()?.reload()'));
  assert.ok(!/setInterval|innerHTML|localStorage|storageSet|clipboard|sendMessage/.test(client + view));
  assert.ok(client.includes('attempt < 40') && client.includes("kind: 'status', grant"));
  assert.ok((await file('scripts/check-static.ts')).includes('context-client'));
});
test('tree Use Context is one explicit menu intent with automatic write completion and success-only configuration reload', async () => {
  const client = await file('src/host/context-client.ts'), bridge = await file('src/host/bridge.ts'), panel = await file('src/panel/main.ts'), op = await file('src/service/operations/context.ts');
  const command = panel.slice(panel.indexOf("case 'extension.vsKubernetesUseContext':"), panel.indexOf("case 'extension.vsKubernetesDeleteContext':"));
  assert.ok(command.includes('bridge?.useContext(node.label)') && !command.includes('navigateTo('));
  const flow = client.slice(client.indexOf('async switchTo('), client.indexOf('async outcomes('));
  ordered(flow, 'this.prepare(configuration, selection, context)', 'preparedRevision !== this.#revision', 'await this.submit()', "kind: 'status', grant");
  assert.equal((flow.match(/await this\.submit\(/g) ?? []).length, 1);
  assert.ok(flow.includes('if (this.#disposed || this.#switching') && flow.includes('!same(response.outcome, original)'));
  const use = bridge.slice(bridge.indexOf('useContext: async'), bridge.indexOf('submitContext:'));
  ordered(use, 'contexts.switchTo(', 'revision !== projectRevision', "outcome?.phase === 'succeeded'", 'await client.reload()');
  // ConfigurationClient.selection returns a fresh validated object: compare values, not reference identity.
  assert.ok((await file('src/host/configuration-client.ts')).includes('get selection(): ConfigSelection { return readConfigSelection(this.#selection); }'));
  assert.ok(use.includes('JSON.stringify(client.selection) !== JSON.stringify(selection)'));
  assert.ok(!use.includes('client.selection !== selection'));
  const status = op.slice(op.indexOf('const record = owned(request.grant)'));
  ordered(status, "request.kind === 'status'", "request.kind === 'cancel'", "void execute(record)");
});
