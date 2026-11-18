// Text/metadata only. Never import or invoke Apply client/controller/patch/HTTPS adapter, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('fixed HTTP/S and CRD source records match public text, with CRDs supporting merge rather than strategic patch', async () => {
  const source = JSON.parse(await file('docs/baseline/manifest-apply-transport-sources.json')) as { records: { local: string; bytes: number; sha256: string }[] }; assert.equal(source.records.length, 3);
  for (const record of source.records) { const body = await file(record.local); assert.equal(Buffer.byteLength(body), record.bytes); assert.equal(createHash('sha256').update(body).digest('hex'), record.sha256); }
  const handler = await file('tests/fixtures/contracts/manifest-apply-transport-contract/crd-handler.txt'), list = handler.slice(handler.indexOf('supportedTypes :='), handler.indexOf('supportedTypes :=') + 350);
  assert.ok(list.includes('types.MergePatchType') && !list.includes('types.StrategicMergePatchType'));
});
test('independent fresh proof requires exact definition/served type/get+patch or get+create/UID-RV and does not import operations', async () => {
  const code = await file('src/service/queries/manifest-apply-snapshot.ts');
  for (const part of ["customDocumentReferenceSchema.safeParse(input)", "expect === 'missing' ? ['get', 'create'] : ['get', 'patch']", 'value.metadata.resourceVersion !== reference.definition.resourceVersion', "purpose: 'custom-document'", 'value.resourceVersion !== reference.resourceVersion', 'await verify(); return']) assert.ok(code.includes(part), part);
  assert.ok(code.includes("error.code !== 'NOT_FOUND'") && code.includes('throw new BoundaryError(\'CONFLICT\');'));
  assert.ok(!/operations\/|adapters\/|\.handle\(|\.prepare\(|\.submit\(|spawn\(|httpsRequest/.test(code));
});
test('full internal proof shares the finite reader2/12s scheduler and is never published as a new HTTP body route', async () => {
  const reader = await file('src/service/queries/resource-reader.ts'), gateway = await file('src/service/queries/resource-gateway.ts'), http = await file('src/service/runtime/http.ts');
  assert.ok(reader.includes("scheduler.run(key(target, 'apply-snapshot'") && reader.includes('concurrency: 2, queued: 16, consumers: 64, timeoutMs: 12_000'));
  assert.ok(gateway.includes('reader.captureManifestApply(target, value.reference, signal, value.expect)') && !http.includes('resources.captureManifestApply('));
});
test('actual patch generation is WRITE-only and independently pins UID/RV after three-way merge, not SSA/replace or a newer snapshot', async () => {
  const code = await file('src/service/operations/manifest-apply-patch.ts');
  for (const part of ['reviewManifestJsonMerge(text, live, format, applyComparisonReference(reference), reference)', "['uid', { kind: 'string', value: reference.uid }]", "['resourceVersion', { kind: 'string', value: reference.resourceVersion }]"]) assert.ok(code.includes(part), part);
  assert.ok(code.includes("['generateName', 'managedFields', 'deletionTimestamp']") && code.includes('desired.length !== 1'));
  assert.ok(!/serviceRequest|httpsRequest|\.submit\(|writeFile|server-side/.test(code));
});
test('the missing->Create body strips the deleted object identity instead of reusing it, and keeps exact type/name/namespace', async () => {
  const code = await file('src/service/operations/manifest-apply-patch.ts'), create = code.slice(code.indexOf('export function prepareManifestApplyCreate'));
  for (const part of ["['generateName', 'managedFields', 'deletionTimestamp']", "key !== 'uid' && key !== 'resourceVersion'", "documentString(documentProperty(metadata, 'name')) !== reference.name", "documentProperty(check, 'uid') !== undefined || documentProperty(check, 'resourceVersion') !== undefined"]) assert.ok(create.includes(part), part);
  assert.ok(create.includes("['namespace', { kind: 'string', value: reference.namespace }]")); // absent desired namespace is pinned to the captured reference
  assert.ok(!/generateName.*value|kubernetes.io\/last-applied-configuration/.test(create));
});
test('Apply controller binds independent frozen content/hash/version/60s grant and enforces budgets/canonical chunks without executing them', async () => {
  const code = await file('src/service/operations/manifest-apply.ts');
  for (const part of ['records.size + preparing >= 64', 'preparing >= 2', 'length + preparing >= 4', 'now + 60_000', 'timingSafeEqual(record.proof', "bytes.toString('base64') !== request.data", 'request.offset % manifestApplyChunkBytes', 'digest(record.payload) !== record.outcome.source.identity', 'request.patchDigest !== record.outcome.patchDigest']) assert.ok(code.includes(part), part);
  assert.ok(!/records.delete|setInterval|console\.|writeFile/.test(code));
  assert.ok(code.includes('blocked(target); // Another original request may have become unknown'));
});
test('queued execution holds the shared lock, checks original live/missing digest, final proof and never recomputes after confirmation', async () => {
  const code = await file('src/service/operations/manifest-apply.ts'), execute = code.slice(code.indexOf('async function execute('), code.indexOf('function pump('));
  for (const part of ['options.lock.run(record.controller.signal', "record.outcome.missing ? 'missing' : 'live'", 'digest(record.patch) !== record.outcome.patchDigest', "update(record, 'dispatching')", 'options.adapter.execute(', 'options.adapter.create(', "result.phase === 'unknown' ? 'unknown' : 'failed'"]) assert.ok(execute.includes(part), part);
  assert.ok(!execute.includes('prepareManifestApplyPatch(') && !execute.includes('prepareManifestApplyCreate('));
  assert.ok(code.includes('digest(snapshot.text) !== record.liveDigest') && code.includes('blocked(record.outcome.target, record)'));
  assert.ok(execute.includes("uidAfter: result.uid, resourceVersionAfter: result.resourceVersion"));
});
test('finish admits ONLY a fresh 404 as the explicit Create fallback; every other missing-shaped error still fails the intent', async () => {
  const code = await file('src/service/operations/manifest-apply.ts'), finish = code.slice(code.indexOf("request.kind === 'finish'"), code.indexOf("request.kind !== 'prepared'"));
  for (const part of ["await proof(record, signal, 'live')", "error.code !== 'NOT_FOUND'", "await proof(record, signal, 'missing')", 'prepareManifestApplyCreate(text, record.outcome.source.format, record.outcome.reference)', "baseline = 'absent'; unchanged = false; missing = true", 'if (!missing && live !== undefined) record.liveDigest = digest(live)']) assert.ok(finish.includes(part), part);
  assert.ok(code.includes("request.confirmation !== (record.outcome.missing ? 'create-missing-crd-object' : 'apply-exact-crd-version')"));
});
test('actual HTTPS adapter sends exactly one request/body per operation on a one-use TLS connection, never redirects/retries/proxies', async () => {
  const code = await file('src/service/adapters/manifest-apply-https.ts'), once = await file('src/service/adapters/https-once.ts');
  assert.equal((once.match(/httpsRequest\(/g) ?? []).length, 1); assert.equal((once.match(/request\.end\(body\)/g) ?? []).length, 1); assert.ok(!code.includes('httpsRequest('));
  for (const part of ['fieldManager=kubectl-client-side-apply&fieldValidation=Strict', 'fieldManager=kubectl-create&fieldValidation=Strict', 'await beforeDispatch()', 'Date.now() >= input.notAfter']) assert.ok(code.includes(part), part);
  for (const part of ["'Content-Type': contentType", "'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'", 'agent: false, rejectUnauthorized: true', '7000', "request.once('close'", '2_000_000', '!response.complete']) assert.ok(once.includes(part), part);
  assert.ok(!/fetch\(|spawn\(|setInterval\(|location\]|Retry-After\]\)|writeFile|console\./.test(code + once));
});
test('the Create branch POSTs the collection once with kubectl-create semantics and only accepts a distinct new UID', async () => {
  const code = await file('src/service/adapters/manifest-apply-https.ts'), create = code.slice(code.indexOf('async create('));
  for (const part of ["objectPath.slice(0, objectPath.lastIndexOf('/'))", "'POST', 'application/json', 201", "documentProperty(metadata, 'uid') !== undefined || documentProperty(metadata, 'resourceVersion') !== undefined", "uid === reference.uid", "return { phase: 'succeeded', uid, resourceVersion: rv }"]) assert.ok(create.includes(part), part);
  assert.ok(!create.includes('kubectl-client-side-apply') && !create.includes("'PATCH'"));
});
test('manifest-apply transport keeps the strict inline bearer/CA connection and debug refusal in the shared direct module', async () => {
  const code = await file('src/service/adapters/manifest-apply-https.ts');
  assert.ok(code.includes('export async function directConnection'));
  for (const part of ['process.env.NODE_DEBUG || process.env.NODE_OPTIONS', "arg.startsWith('--tls-keylog')", "server.protocol !== 'https:'", "server.pathname !== '/'"]) assert.ok(code.includes(part), part);
});
test('direct transport only admits exact inline bearer/CA HTTPS root config, without insecure/file/provider/basic/impersonation fallback', async () => {
  const code = await file('src/service/adapters/manifest-apply-https.ts'), schema = code.slice(code.indexOf('const snapshotSchema'), code.indexOf('export async function directConnection'));
  assert.ok(schema.includes("token: z.string().min(1).max(16_384)") && schema.includes("'certificate-authority-data'") && schema.includes('.strict()'));
  assert.ok(!/tokenFile:|proxy-url:|username:|password:|exec:|client-key:|insecure-skip-tls-verify:/.test(schema));
  assert.ok(code.includes("server.protocol !== 'https:'") && code.includes("server.pathname !== '/'") && code.includes('privateKubectlConfiguration(value.merged, input.target)'));
  assert.ok(code.includes('process.env.NODE_DEBUG || process.env.NODE_OPTIONS') && code.includes("arg.startsWith('--tls-keylog')") && code.includes('manifestComparisonPath(applyComparisonReference(reference))'));
});
test('truncated/malformed/wrong UID success and network/timeout remain unknown; explicit API rejection bodies are never parsed', async () => {
  const code = await file('src/service/adapters/manifest-apply-https.ts');
  for (const part of ["phase: 'unknown', code: 'OPERATION_UNKNOWN'", "documentString(documentProperty(metadata, 'uid')) !== reference.uid", "phase: 'failed' as const, code"]) assert.ok(code.includes(part), part);
  const once = await file('src/service/adapters/https-once.ts');
  for (const part of ['!response.complete', 'total > 2_000_000', 'response.destroy(); return;', 'for (const chunk of chunks) chunk.fill(0)']) assert.ok(once.includes(part), part);
});
test('write client freezes complete loaded source, keeps body out of its ledger and never replays after attempted submit', async () => {
  const code = await file('src/host/manifest-apply-client.ts');
  for (const part of ['record.submitted = true', 'sameApplyIntent(record.outcome, value)', 'record.plan && plan !== record.plan', 'this.#calls >= 2', 'finally { this.#calls--; }', 'bytes?.fill(0)', 'source.owner !== record.owner', 'saveContentSnapshot(source.text)', "confirmation: record.outcome.missing ? 'create-missing-crd-object' : 'apply-exact-crd-version'", 'value.patchBytes, value.unchanged, value.baseline, value.missing']) assert.ok(code.includes(part), part);
  const type = code.slice(code.indexOf('type Record ='), code.indexOf('const terminal')); assert.ok(!/text:|body:|bytes:|snapshot:/.test(type)); assert.ok(!/setInterval|writeClipboard|storage\.|console\./.test(code));
});
test('runtime authenticates/bounds actual Apply route and closes only unsubmitted work; bridge/panel use an explicit separate confirmation', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), bridge = await file('src/host/bridge.ts'), view = await file('src/panel/manifest-apply-view.ts');
  const offset = http.indexOf("url.pathname === '/v2/operations/manifest-apply'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 550).includes('options.manifestApplies.handle(input, controller.signal)') && http.includes('options.manifestApplies.close()'));
  assert.ok(main.includes('adapter: createManifestApplyHttpsAdapter(config)') && bridge.includes("'definition' in editor.origin.reference"));
  for (const part of ['bridge()?.prepareManifestApply()', 'bridge()?.submitManifestApply()', "state.phase !== 'confirm'", 'bridge()?.manifestApplyStatus()', 'check the original operation instead of resubmitting', 'MISSING → explicit single-POST Create branch', "value?.missing"]) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard/.test(view));
  assert.ok(view.includes('disabled: busy || !state.canCancel') && (await file('src/host/manifest-apply-client.ts')).includes('!this.#pending.submitted && !terminal(this.#pending.outcome)'));
});
test('known success only invalidates original metadata lists, never mutates dirty/editor origin or auto GETs', async () => {
  const tree = await file('src/host/tree-controller.ts'), method = tree.slice(tree.indexOf('  observeApply('), tree.indexOf('  stopWatchUpdates(')), bridge = await file('src/host/bridge.ts');
  assert.ok(method.includes('treeQueryAffectedByCreate(query, value.target, value.reference)') && method.includes('value.target'));
  assert.ok(!/\.refresh\(|#refreshes.add|serviceRequest|documents\.|workspace\./.test(method));
  assert.ok(bridge.includes('branches.invalidateCustomWatch(state.outcome.target, state.outcome.reference.definition)') && bridge.includes('tree.observeApply(state.outcome)'));
});
test('automatic dependency graphs explicitly forbid new Apply write-client/view/adapter and never import or run them in readonly suites', async () => {
  const check = await file('scripts/check-static.ts'), code = await file('tests/readonly/manifest-apply-values.test.ts');
  for (const part of ['manifest-apply-https', 'manifest-apply-client', 'manifest-apply-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|manifest-apply-client|bridge|sdk)|\.prepare\(|\.submit\(|\.handle\(|\.execute\(/.test(code));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/manifest-apply-values.test.ts'")); assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/manifest-apply-wiring.test.ts'"));
});
