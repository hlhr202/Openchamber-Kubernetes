// Text/metadata only. Never import or invoke CronJob Run client/controller/HTTPS adapter, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned kubectl create-job text proves the instantiate=manual instantiation semantics with a Controller owner', async () => {
  const record = JSON.parse(await file('tests/fixtures/contracts/manifest-cronjob-run-contract/source-read.json')).records[0];
  const body = await file(record.local); assert.equal(Buffer.byteLength(body), record.bytes); assert.equal(createHash('sha256').update(body).digest('hex'), record.sha256);
  for (const part of ['cronjob.kubernetes.io/instantiate', 'Labels:      cronJob.Spec.JobTemplate.Labels', 'Spec: cronJob.Spec.JobTemplate.Spec', 'ptr.To(true)', 'BlockOwnerDeletion']) assert.ok(body.includes(part), part);
});
test('job body builder reproduces the pinned mapping losslessly and rejects stale or foreign cronjobs', async () => {
  const code = await file('src/service/adapters/cronjob-run-https.ts'), build = code.slice(code.indexOf('export function buildInstantiatedJob'));
  assert.ok(code.includes("const annotation = 'cronjob.kubernetes.io/instantiate'"));
  for (const part of ['[[annotation, { kind: \'string\', value: \'manual\' }]', "['spec', templateSpec]", "['controller', { kind: 'atom', text: 'true' }]", 'documentString(documentProperty(metadata, \'uid\')) === parameters.reference.uid', 'No BlockOwnerDeletion']) assert.ok(build.includes(part), part);
  assert.ok(build.includes('documentProperty(builtMetadata, \'uid\') !== undefined || documentProperty(builtMetadata, \'resourceVersion\') !== undefined'));
  assert.ok(!build.includes('kubectl-client-side-apply') && !build.includes('generateName'));
});
test('dispatch is exactly two one-shot requests: pinned-UID/RV cronjob GET then ONE job POST; no third request', async () => {
  const code = await file('src/service/adapters/cronjob-run-https.ts');
  assert.equal((code.match(/onceRequest</g) ?? []).length, 2);
  for (const part of ['await beforeDispatch()', 'Date.now() >= request.notAfter', "'POST', 'application/json', 201", "throw new BoundaryError('NOT_FOUND')", "outcome: 'accepted'"]) assert.ok(code.includes(part), part);
  assert.ok(code.includes('resourceObjectPath(parameters.reference.type, parameters.reference.name, parameters.reference.namespace)'));
  assert.ok(!/httpsRequest\(|fetch\(|spawn\(|setInterval\(|writeFile|console\./.test(code));
});
test('operations reuse the delete-shaped G4 chain with fresh cronjob proof and an original ledger', async () => {
  const code = await file('src/service/operations/cronjob-run.ts');
  for (const part of ['options.resources.verifyReference(', 'Date.now() + 60_000', 'Date.now() + 120_000', 'options.lock.run(record.controller.signal', "update(record, 'dispatching')", 'queued.length >= 16', 'running < 2', "result.outcome === 'accepted' ? 'accepted'", 'Unknown records are never silently evicted']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|console\.|writeFile/.test(code));
});
test('write client proposes the local-clock default, keeps the body out of its ledger and never replays a submit', async () => {
  const code = await file('src/host/cronjob-run-client.ts');
  for (const part of ['proposedJobName(cronJobName, new Date())', 'jobNameSchema.safeParse', "confirmation: 'cronjob-run-now-exact-origin'", 'result.outcome.parameters.jobName !== jobName', 'this.#calls >= 4', 'finally { this.#calls--; }']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|writeClipboard|storage\.|console\./.test(code));
});
test('runtime authenticates the cronjob-run route and accepted results only mark jobs/cronjobs metadata stale', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), bridge = await file('src/host/bridge.ts');
  const offset = http.indexOf("url.pathname === '/v2/operations/cronjob-run'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 400).includes('options.cronJobRuns.handle(input, controller.signal)') && http.includes('options.cronJobRuns.close()'));
  assert.ok(main.includes('createCronJobRunOperations({ serviceGeneration, config, resources, lock, execute: createCronJobRunHttpsAdapter(config) })'));
  assert.ok(bridge.includes("for (const key of ['jobs', 'cronjobs']) resources.invalidate(key, target)") && bridge.includes('cronJobRuns?.prepare(target(), client.selection'));
});
test('rows only pin the exact cronjob reference; the view keeps an editable job name and explicit confirm', async () => {
  const view = await file('src/panel/cronjob-run-view.ts'), main = await file('src/panel/main.ts');
  for (const part of ['Job name (default name-timestamp, editable)', 'bridge()?.prepareCronJobRun(reference, jobName)', "state.phase !== 'confirm'", 'bridge()?.submitCronJobRun()']) assert.ok(view.includes(part), part);
  assert.ok(main.includes("documentReference.type.resource === 'cronjobs'") && main.includes('cronJobRun.target(documentReference)'));
  assert.ok(!/innerHTML|storage\.|writeClipboard/.test(view + main));
});
test('automatic dependency graphs forbid the new write modules in readonly suites; allowlists cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/cronjob-run-values.test.ts');
  for (const part of ['cronjob-run-https', 'cronjob-run-client', 'cronjob-run-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|cronjob-run-client|bridge|sdk)|\.prepare\(|\.submit\(|\.handle\(|\.execute\(/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/cronjob-run-values.test.ts'")); assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/cronjob-run-wiring.test.ts'"));
});
