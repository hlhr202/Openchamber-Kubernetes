// Text-only inspection. Never import a write client/controller/worker/adapter or run any lifecycle method.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('Create source conversion is pure/lossless and separate from every write handler', async () => {
  const source = await file('src/parsing/manifest-create-source.ts') + await file('src/parsing/manifest-values.ts'), payload = await file('src/shared/manifest-create-payload.ts');
  for (const part of ['analyseManifestBundle(text, format, { strictNamespace: true })', 'nodes.length >= 32', "documentString(documentProperty(node, 'kind')) === 'List'", 'text.slice(selection.start, selection.end)', "renderDocumentJson(envelope, 'json', manifestCreateBytes)"]) assert.ok(source.includes(part), part);
  assert.ok(!/operations\/|serviceRequest|\.prepare\(|\.submit\(|writeFile|\.toJS\(|\.toJSON\(/.test(source + payload));
  // Approved batch-2 upgrade: generateName is a legitimate alternative to name; the other
  // server-owned identity fields stay rejected.
  assert.ok(payload.includes("['uid', 'resourceVersion', 'managedFields', 'deletionTimestamp']"));
  assert.ok(payload.includes('createNameShape') && payload.includes("'named' : 'generated'"));
  assert.ok(payload.includes('kind.endsWith(') && payload.includes('nested List never expands'));
});
test('Create source/payload/grant/confirmation are independent of read scopes and Diff cursors', async () => {
  const protocol = await file('src/shared/manifest-create-protocol.ts');
  for (const part of ['createGrantSchema', "confirmation: z.literal('create-exact-documents')", 'manifestCreateChunkBytes = 24_576', 'steps: z.array(createStepSchema).max(32)', 'outcomes: z.array(createOutcomeSchema).max(4)']) assert.ok(protocol.includes(part), part);
  assert.ok(!/cursor:|scope:|argv:|raw:|url:/.test(protocol));
  assert.ok(protocol.includes('file: manifestFileSchema.optional()') && protocol.includes('fileProof: workspaceProofSchema.optional()'));
});
test('only fresh get+create discovery and actual404 prove a named create target, without iterating existing/error bodies', async () => {
  const source = await file('src/service/queries/manifest-create-proof.ts');
  for (const part of ["projectDiscovery(value, ['get', 'create'])", 'response.status === 200', 'await response.close()', "error.code !== 'NOT_FOUND'", 'JSON.stringify(reference) !== JSON.stringify(after)']) assert.ok(source.includes(part));
  assert.ok(!/operations\/|\.handle\(|\.submit\(|spawn\(|writeFile/.test(source));
});
test('Create proof has a dedicated private GET purpose and original scheduler, not generic Load/Delete/Watch or a new pool', async () => {
  const plan = await file('src/service/queries/kubectl-plan.ts'), reader = await file('src/service/queries/resource-reader.ts');
  assert.ok(plan.includes("request.purpose !== 'manifest-create-proof' && request.createReference !== undefined") && plan.includes('manifestComparisonReferenceSchema.safeParse(request.createReference)'));
  assert.ok(reader.includes("scheduler.run(key(target, 'create-proof', randomUUID())"));
});
test('Create operation freezes independent intents, reserves bounded memory/ledger and never evicts unknown records to admit another submission', async () => {
  const code = await file('src/service/operations/manifest-create.ts');
  for (const part of ['records.size + preparing >= 64', 'preparing >= 2', 'length + preparing >= 4', 'now + 60_000', 'previous.binding !== binding', "record.outcome.phase === 'unknown' || record.outcome.cleanup === 'manual-check'", 'timingSafeEqual(record.proof']) assert.ok(code.includes(part), part);
  assert.ok(!/records\.delete\(|setInterval\(|writeFile|console\./.test(code));
});
test('canonical sequential upload/digest/UTF8/envelope check precedes confirmation, without running real or mock upload chains', async () => {
  const code = await file('src/service/operations/manifest-create.ts');
  for (const part of ["bytes.toString('base64') !== request.data", 'request.offset % manifestCreateChunkBytes !== 0', 'request.offset > record.outcome.received', 'digest(record.payload) !== record.outcome.digest', 'fatal: true', 'readCreatePayload(', 'new Set(keys).size !== keys.length', 'await proof(record, index)']) assert.ok(code.includes(part), part);
});
test('only confirmed submit queues work under shared lock; each exact target is rechecked before worker grant and steps stop after failure/unknown', async () => {
  const code = await file('src/service/operations/manifest-create.ts');
  for (const part of ['options.lock.run(record.controller.signal', 'await proof(record, item.index, item.reference)', 'await proof(record, item.index, reference)', 'if (!workerLive())', "update(record, 'queued'); queued.push(record); pump()", "record.outcome.phase === 'dispatching') return", 'skipped(record)']) assert.ok(code.includes(part), part);
  assert.ok(code.includes("result.phase === 'unknown' ? 'unknown' : 'failed'"));
});
test('real Create worker runs exact raw POST/stdin with fixed strict validation, never apply/replace/SSA/force/dryrun or a manifest temp file', async () => {
  const protocol = await file('src/service/operations/manifest-create-worker-protocol.ts'), worker = await file('src/service/adapters/manifest-create-worker.ts');
  assert.ok(protocol.includes("'create'") && protocol.includes('?fieldManager=kubectl-create&fieldValidation=Strict') && protocol.includes("'-f', '-'"));
  for (const part of ['manifestCreateCommand(start, fifo)', 'validateKubectlSnapshot(snapshot, start.target)', 'verifyKubectlVersion(', 'await granted', 'Date.now() >= start.notAfter', 'process.kill(-child.pid', "phase: dispatched ? 'unknown' : 'not-submitted'", 'info.ino === owned.ino && info.dev === owned.dev', 'await rmdir(home)', "cleanup: 'manual-check'"]) assert.ok(worker.includes(part), part);
  assert.ok(!/writeFile|\.prepare\(|--force|--dry-run|server-side|['"]apply['"]|['"]replace['"]/.test(worker + protocol));
});
test('parent waits for readiness, final proof and actual worker close, retaining slots through late proof and preserving unknown results', async () => {
  const code = await file('src/service/adapters/kubectl-manifest-create.ts');
  for (const part of ['createWorkerReadySchema.safeParse(input)', 'await beforeDispatch(() => !closed && !invalid', 'dispatched = true; worker.send(', 'Promise.resolve(approval).then(', 'serialization: \'advanced\'', "'ignore', 'ignore', 'ignore', 'ipc'", 'snapshot.fill(0); body.fill(0)']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|console\.|stderr\.on/.test(code));
});
test('Create client has explicit source upload/confirmation, exact immutable intent checks, manual lost-finish recovery and no submit replay after attempted send', async () => {
  const code = await file('src/host/manifest-create-client.ts');
  for (const part of ['encodeCreateSource(text, format, selection)', 'sameCreateIntent(record.outcome, response.outcome)', 'this.#calls >= 2', 'finally { this.#calls--; }', "record.submitted = true; this.#paint('submitting')", "confirmation: 'create-exact-documents'", 'record.epoch === this.#epoch', 'this.#records.size >= 64', "value.outcome.phase === 'prepared'", 'bytes?.fill(0)']) assert.ok(code.includes(part), part);
  assert.ok(code.includes('record.submitted || terminal(record.outcome)') && !/setInterval|writeClipboard|storage\.|console\./.test(code));
});
test('runtime authenticates/bounds the separate write route, mounts real adapter/worker and closes only unsubmitted work', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts');
  const index = http.indexOf("url.pathname === '/v2/operations/manifest-create'"); assert.ok(index > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(index, index + 500).includes('options.manifestCreates.handle(input, controller.signal)') && http.includes('options.manifestCreates.close()'));
  assert.ok(main.includes('createManifestCreateOperations({ generation: serviceGeneration, config, resources, lock, workspace, fileSaves, execute: createKubectlManifestCreateAdapter(') && main.includes('await runManifestCreateWorker()'));
});
test('diagnostic Create UI has separate explicit prepare/confirm/query actions, clears project drafts and separates file capture from Save preparation', async () => {
  const view = await file('src/panel/manifest-create-view.ts'), bridge = await file('src/host/bridge.ts'), main = await file('src/panel/main.ts');
  for (const part of ['bridge()?.prepareManifestCreate(', 'bridge()?.submitManifestCreate()', 'bridge()?.manifestCreateStatus()', "kind === 'disk'", 'bridge()?.prepareFileSaveForCreate()', 'state.phase !== \'confirm\'', 'text = \'\'']) assert.ok(view.includes(part), part);
  assert.ok(bridge.includes("kind === 'file' && !selection") && bridge.includes('manifestCreates?.reset()') && bridge.includes('manifestCreates?.dispose()'));
  assert.ok(main.includes('manifestCreate.resetDraft()') && main.includes('stopManifestCreate(); manifestCreate.dispose()'));
  assert.ok(!/innerHTML|writeClipboard|storage\.|console\./.test(view));
});
test('automatic suites only exercise pure values and independent GET proofs; no write module is imported/constructed/called even through mocks', async () => {
  const code = await file('tests/readonly/manifest-create-values.test.ts');
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|manifest-create-client|bridge|@openchamber)|\.prepare\(|\.handle\(|\.submit\(|\.status\(|\.cancel\(/.test(code));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/manifest-create-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/manifest-create-wiring.test.ts'"));
});
test('queued Create intents recheck other unknown/manual-cleanup records before every proof, not just at their earlier admission', async () => {
  const code = await file('src/service/operations/manifest-create.ts'), bind = code.slice(code.indexOf('async function bind(record'), code.indexOf('async function proof(record'));
  assert.ok(bind.includes('other !== record') && bind.includes("other.outcome.phase === 'unknown' || other.outcome.cleanup === 'manual-check'") && bind.includes("throw new BoundaryError('OPERATION_UNKNOWN')"));
  assert.ok(code.includes("skipped(record); update(record, 'cancelled'") && code.includes("skipped(record); update(record, 'failed', 'CONFIRMATION_EXPIRED')"));
});
test('initial confirmation matches locally encoded complete locator count and reference/scope/namespace before pinning later ledger updates', async () => {
  const code = await file('src/host/manifest-create-client.ts');
  for (const part of ['expected = readCreatePayload(payload).map(item => item.locator)', 'response.outcome.steps.length !== record.expected.length', 'JSON.stringify(item.locator) !== JSON.stringify(record.expected[index])', 'ref.type.group !== locator.group', 'ref.namespace !== (locator.namespace ?? record.context.target.namespace)', 'record.plan && plan !== record.plan']) assert.ok(code.includes(part), part);
});
test('known Create success marks original matching headless/diagnostic lists stale without automatic reads or changing editor/write references', async () => {
  const code = await file('src/host/tree-controller.ts'), bridge = await file('src/host/bridge.ts');
  const method = code.slice(code.indexOf('  observeCreate('), code.indexOf('  stopWatchUpdates('));
  assert.ok(method.includes("step.phase === 'succeeded'") && method.includes('treeQueryAffectedByCreate(query, value.target, step.reference)') && method.includes('this.#model.invalidateQueries('));
  assert.ok(!/\.refresh\(|#refreshes\.add|serviceRequest|documents\.|workspace\./.test(method));
  assert.ok(bridge.includes('tree.observeCreate(state.outcome)') && bridge.includes('resources.invalidate(key, state.outcome.target)'));
});
test('an accepted Delete of a CRD definition body invalidates discovery-dependent tree branches', async () => {
  const tree = await file('src/host/tree-controller.ts'), bridge = await file('src/host/bridge.ts'), effect = await file('src/shared/tree-create-effect.ts');
  const method = tree.slice(tree.indexOf('  observeDelete('), tree.indexOf('  // Upstream showInfoMessage'));
  assert.ok(method.includes('deleteOutcomeSchema.safeParse') && method.includes("parsed.data.phase !== 'accepted'") && method.includes('treeQueryAffectedByCreate(query, value.target, value.parameters.reference)'));
  assert.ok(effect.includes("type.group === 'apiextensions.k8s.io'") && effect.includes("query.kind === 'custom-types'"));
  assert.ok(bridge.includes('tree.observeDelete(state.outcome)'));
});
