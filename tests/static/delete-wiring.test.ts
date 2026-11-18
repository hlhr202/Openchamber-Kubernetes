// SOURCE ONLY. Do not import the operation, client, worker, write planner or their handlers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseAst } from 'rolldown/parseAst';

const root = new URL('../../', import.meta.url);
const file = (path: string) => readFile(new URL(path, root), 'utf8');
function ordered(text: string, ...parts: string[]) {
  let offset = -1;
  for (const part of parts) { const next = text.indexOf(part, offset + 1); assert.ok(next > offset, part); offset = next; }
}

test('delete route is authenticated and bounded before its exclusive control entry; runtime constructs but never submits', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts');
  ordered(http, 'authorized(request.headers.authorization', "url.pathname === '/v2/operations/delete'", 'boundedBody(request, controller.signal, resourceRequestBytes)', 'options.operations.handle(body, controller.signal)');
  assert.ok(http.includes('options.operations.close()'));
  assert.ok(main.includes('createDeleteOperations({ serviceGeneration, config, resources, execute: createKubectlDeleteAdapter('));
  ordered(main, 'await runReadWorker()', 'await runDeleteWorker()', 'const port = process.env.OPENCHAMBER_SERVICE_PORT');
  assert.ok(!/operations\.handle\(|\.submit\(/.test(main));
});

test('service-issued capability binds immutable target, generation and lease without host project attestation', async () => {
  const op = await file('src/service/operations/delete.ts'), schema = await file('src/shared/delete-protocol.ts');
  assert.ok(op.includes('NOT host project attestations') && op.includes("randomBytes(32).toString('hex')"));
  assert.ok(op.includes('digest: digest(capability), target: immutable(target), selection: immutable(request.selection)'));
  assert.ok(op.includes('grant.serviceGeneration !== options.serviceGeneration') && op.includes('!equal(value.digest, grant.capability)'));
  assert.ok(op.includes('value.expiresAt <= Date.now()') && op.includes('opening >= 2 || views.size >= 64'));
  assert.ok(schema.includes("deleteReferenceSchema = documentReferenceSchema.refine(ref => ref.type.resource !== 'namespaces')"));
  assert.ok(schema.includes("value.mode !== 'now' || (value.reference.type.group === '' && value.reference.type.resource === 'pods')"));
  assert.ok(schema.includes("step: z.literal('delete-request'), dependencies: z.tuple([])"));
});

test('confirmation, fresh reference checks, private config and final dispatch gate precede the dedicated write worker', async () => {
  const op = await file('src/service/operations/delete.ts'), adapter = await file('src/service/adapters/kubectl-delete.ts');
  const execution = op.slice(op.indexOf('async function execute(record'));
  ordered(execution, 'current(record); update(record,', 'await options.resources.verifyReference(', 'current(record);', 'await options.execute(', "update(record, 'dispatching')");
  assert.ok(op.includes('Math.min(now + 60_000, owner.expiresAt)') && op.includes('record.expiresAt <= Date.now()'));
  assert.ok(op.includes('preparing >= 2 || records.size >= 128') && op.includes('locks.add(record.view.target.configIdentity)'));
  ordered(adapter, 'await config.transportRead(request.selection, request.target.configIdentity, signal, request.target)', 'privateKubectlConfiguration(', 'parseDeleteWorkerStart(', 'beforeDispatch();', 'fork(filename, [deleteWorkerFlag]');
  assert.ok(adapter.includes('snapshot.fill(0)') && !adapter.includes('process.env'));
  const reader = await file('src/service/queries/resource-reader.ts');
  ordered(reader.slice(reader.indexOf('async verifyReference(')), 'planResourceDocument(', "key(target, 'verify-reference', randomUUID())", 'verifyResourceObject(value, plan.reference.type, plan.reference)');
});

test('ticket replay cannot enqueue twice; close only cancels unsubmitted phases; original dispatch results survive view changes', async () => {
  const op = await file('src/service/operations/delete.ts');
  ordered(op, '!equal(record.proof, request.proof)', "record.outcome.phase !== 'prepared'", 'current(record); if (queued.length >= 16)', "update(record, 'queued'); queued.push(record); pump()");
  assert.ok(op.includes("['prepared', 'queued', 'checking'].includes(record.outcome.phase)") && op.includes('record.controller.abort()'));
  assert.ok(op.includes('clearTimeout(timeout); update(record, \'dispatching\')') && op.includes('HTTP disconnect does NOT cancel a submitted operation'));
  assert.ok(op.includes("record.outcome.phase === 'dispatching' ? 'unknown' : 'failed'"));
  assert.ok(op.includes('records.values()].map(record => record.outcome).reverse()') && op.includes('offset + 16'));
  assert.ok(op.includes("['accepted', 'failed', 'cancelled'].includes(record.outcome.phase)"));
  assert.ok(!/records\.clear\(|records\.delete\(owner|options\.execute\([^]*?\.catch\([^]*?options\.execute/.test(op));
});

test('raw DELETE carries UID/RV preconditions and grace one, not force, based on exact public source', async () => {
  const plan = await file('src/service/operations/delete-worker-protocol.ts');
  assert.ok(plan.includes('resourceObjectPath(ref.type, ref.name, ref.namespace)') && plan.includes("'-f', '-']"));
  assert.ok(plan.includes('preconditions: { uid: ref.uid, resourceVersion: ref.resourceVersion }') && plan.includes("propagationPolicy: 'Background'"));
  assert.ok(plan.includes('gracePeriodSeconds: 1') && !/--force|--dry-run|shell: true/.test(plan));
  const upstream = await file('tests/fixtures/contracts/query-contract/kubernetes/kubectl/pkg/cmd/delete/delete.go.txt');
  assert.ok(upstream.includes('o.GracePeriod = 1') && upstream.includes('rawhttp.RawDelete(restClient, o.IOStreams, o.Raw, o.Filenames[0])'));
  const raw = await file('tests/fixtures/contracts/query-contract/kubernetes/kubectl/pkg/rawhttp/raw.go.txt');
  assert.ok(raw.includes('return raw(restClient, streams, url, filename, "DELETE")') && raw.includes('data = streams.In') && raw.includes('restClient.Delete().RequestURI(url).Body(data)'));
  const meta = await file('tests/fixtures/contracts/query-contract/kubernetes/apimachinery/pkg/apis/meta/v1/types.go.txt');
  assert.ok(meta.includes('Preconditions *Preconditions') && meta.includes('ResourceVersion *string') && meta.includes('UID *types.UID'));
});

test('dedicated write supervisor has bounded IPC, static-auth FIFO, independent deadline and conservative results', async () => {
  const worker = await file('src/service/adapters/delete-worker.ts'), adapter = await file('src/service/adapters/kubectl-delete.ts');
  ordered(worker, 'parseDeleteWorkerStart(input)', 'validateKubectlSnapshot(snapshot, start.target)', 'await mkdtemp(', 'verifyKubectlVersion(', "command('/usr/bin/mkfifo'", 'deleteCommand(start, fifo)', 'dispatched = true;', "command('kubectl', plan.args");
  assert.ok(worker.includes('constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW') && worker.includes('info.ino === owned.ino && info.dev === owned.dev'));
  assert.ok(worker.includes("process.on('disconnect', disconnect)") && worker.includes('setTimeout(disconnect, deleteWorkerDeadlineMs)'));
  assert.ok(worker.includes("outcome: dispatched ? 'unknown' : 'not-submitted'") && worker.includes('CLI stderr is not an authenticated structured API result'));
  assert.ok(worker.includes('Promise.allSettled([writing, configuration])') && worker.includes('snapshot?.fill(0)'));
  assert.ok(adapter.includes("serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc']") && !adapter.includes("worker.kill('SIGKILL')"));
  assert.ok(!/writeFile|console\.|exec\(|shell: true|rm\(/.test(worker));
});

test('explicit destructive UI wires through SDK and lifecycle reset without automatic submission, polling or retry', async () => {
  const bridge = await file('src/host/bridge.ts'), client = await file('src/host/delete-client.ts'), view = await file('src/panel/delete-view.ts');
  assert.ok(bridge.includes('new DeleteClient(request => host.serviceRequest(request), state =>') && bridge.includes('tree.observeDelete(state.outcome)') && bridge.includes('deletes.reset(); documents.reset(); projectChanged()'));
  assert.ok(bridge.includes('prepareDelete: (parameters: DeleteParameters) => deletes.prepare(target(), client.selection, parameters)') && bridge.includes('deletes.dispose()'));
  assert.ok(client.includes('this.#calls >= 4') && client.includes('No automatic submit retry'));
  assert.ok(client.includes('revision !== this.#revision') && client.includes('sameTarget(result.outcome.target, confirmation.outcome.target)'));
  assert.ok(view.includes("variant: 'destructive'") && view.includes('submitDelete()') && view.includes('row.textContent = logDisplayText('));
  assert.ok(!/setInterval|setTimeout|fetch\(|innerHTML|storageSet|localStorage|clipboard|sendMessage/.test(client + view));
  for (const path of ['src/panel/main.ts', 'src/panel/branch-diagnostics.ts']) assert.ok((await file(path)).includes('mountDeleteActions(action, documentReference'));
  const actions = await file('src/panel/delete-actions.ts'); assert.ok(actions.includes("reference.type.resource === 'namespaces'") && actions.includes('prepareDelete('));
});

test('static and readonly runners never import write controllers or planners, including through local imports', async () => {
  const allowlist = await file('scripts/readonly-tests.ts'); assert.ok(!allowlist.includes('delete-wiring'));
  const source = await file('tests/static/delete-wiring.test.ts');
  const program = parseAst(source, { lang: 'ts', astType: 'ts' }, 'delete-wiring.test.ts');
  // This AST is the static test itself, not a dynamically imported subject module.
  assert.ok(program);
  assert.ok(!/^import .*from ['"][^'"]*(?:src\/|delete-client|delete-worker|operations\/)/m.test(source));
  const boundary = await file('scripts/check-static.ts');
  assert.ok(boundary.includes('Read/display imports a write adapter') && boundary.includes('namespace-client') && boundary.includes('namespace-file'));
});
