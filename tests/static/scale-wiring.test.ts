// Text/metadata only. Never import or invoke Scale client/controller/HTTPS adapter, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned kubectl scale text matches public source and proves GET+validate+PUT for the precondition branch', async () => {
  const records = JSON.parse(await file('tests/fixtures/contracts/manifest-scale-contract/source-read.json')).records; assert.equal(records.length, 2);
  for (const record of records) { const body = await file(record.local); assert.equal(Buffer.byteLength(body), record.bytes); assert.equal(createHash('sha256').update(body).digest('hex'), record.sha256); }
  const scaler = await file('tests/fixtures/contracts/manifest-scale-contract/pkg__scale__scale.go.txt');
  for (const part of ['preconditions.validate(scale)', 'scale.Spec.Replicas = int32(newSize)', 'Scales(namespace).Update(']) assert.ok(scaler.includes(part), part);
  const cmd = await file('tests/fixtures/contracts/manifest-scale-contract/pkg__cmd__scale__scale.go.txt');
  assert.ok(cmd.includes('--current-replicas') && cmd.includes('--resource-version')); // upstream VS Code passes neither; the plugin pins RV as its G4 gate.
});
test('shared one-shot HTTPS core is the single low-level request site for both direct WRITE transports', async () => {
  const once = await file('src/service/adapters/https-once.ts');
  assert.equal((once.match(/httpsRequest\(/g) ?? []).length, 1); assert.equal((once.match(/request\.end\(body\)/g) ?? []).length, 1);
  for (const part of ["'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'", 'agent: false, rejectUnauthorized: true', '!response.complete', 'total > 2_000_000', '7000', "request.once('close'", 'Retry']) assert.ok(once.includes(part), part);
  for (const adapter of ['src/service/adapters/manifest-apply-https.ts', 'src/service/adapters/scale-https.ts']) {
    const code = await file(adapter); assert.ok(code.includes("from './https-once.ts'")); assert.ok(!code.includes('httpsRequest(') && !/fetch\(|spawn\(|setInterval\(|location\]|Retry-After\]\)|writeFile|console\./.test(code));
  }
});
test('Scale transport follows the pinned precondition branch: exact scale GET, one full PUT, RV gate, 409/404 fixed failures', async () => {
  const code = await file('src/service/adapters/scale-https.ts');
  for (const part of ["scaleParametersSchema.parse(request.parameters)", '/scale', "z.literal('autoscaling/v1')", "z.literal('Scale')", 'await beforeDispatch()', 'Date.now() >= request.notAfter', 'scalePutBody(current.scale, request.parameters)', "'PUT', 'application/json', 200", 'updated.resourceVersion !== current.scale.resourceVersion', "outcome: 'accepted'"]) assert.ok(code.includes(part), part);
  assert.ok(code.includes("throw new BoundaryError('NOT_FOUND')")); // no scale subresource (e.g. Job) is a fixed failure, never a rebuild.
  assert.ok(code.includes('check.replicas !== parameters.replicas || check.resourceVersion !== scale.resourceVersion'));
  assert.ok((code.match(/onceRequest</g) ?? []).length === 2); // exactly one GET plus one PUT, nothing else.
});
test('Scale operations reuse the delete-shaped G4 chain: view grant, fresh parent proof, 60s confirmation, single dispatch, original ledger', async () => {
  const code = await file('src/service/operations/scale.ts');
  for (const part of ['options.resources.verifyReference(', 'Date.now() + 60_000', 'Date.now() + 120_000', 'options.lock.run(record.controller.signal', "update(record, 'dispatching')", 'queued.length >= 16', 'running < 2', "result.outcome === 'accepted' ? 'accepted'", "record.outcome.phase === 'dispatching' ? 'unknown'"]) assert.ok(code.includes(part), part);
  assert.ok(!/records\.delete\(.*unknown|setInterval|console\.|writeFile/.test(code));
  assert.ok(code.includes('Unknown records are never silently evicted'));
});
test('write client parses the upstream input rule client-side and never replays after an attempted submit', async () => {
  const code = await file('src/host/scale-client.ts');
  for (const part of ['parseScaleReplicasInput(replicasInput)', 'scaleParametersSchema.parse({ reference, replicas })', "confirmation: 'scale-exact-target-replicas'", 'documentReferenceId(result.outcome.parameters.reference) !== documentReferenceId(parameters.reference)', 'this.#calls >= 4', 'finally { this.#calls--; }']) assert.ok(code.includes(part), part);
  const type = code.slice(code.indexOf('type Confirmation'), code.indexOf('export class')); assert.ok(!/text:|body:|argv:/.test(type));
  assert.ok(!/setInterval|writeClipboard|storage\.|console\./.test(code));
});
test('runtime authenticates the Scale route, closes only unsubmitted work, and accepted results only mark metadata stale', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), bridge = await file('src/host/bridge.ts');
  const offset = http.indexOf("url.pathname === '/v2/operations/scale'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 400).includes('options.scales.handle(input, controller.signal)') && http.includes('options.scales.close()'));
  assert.ok(main.includes('createScaleOperations({ serviceGeneration, config, resources, lock, execute: createScaleHttpsAdapter(config) })'));
  assert.ok(bridge.includes('resources.invalidate(key, state.outcome.target)') && bridge.includes('scales?.prepare(target(), client.selection, reference, replicasInput)'));
});
test('the diagnostic Scale view keeps an explicit replicas input, separate confirm and original ledger; rows only pin the exact reference', async () => {
  const view = await file('src/panel/scale-view.ts'), main = await file('src/panel/main.ts');
  for (const part of ['Replicas (non-negative integer)', 'bridge()?.prepareScale(reference, replicas)', "state.phase !== 'confirm'", 'bridge()?.submitScale()', 'bridge()?.cancelScale()', 'bridge()?.scaleOutcomes(true)']) assert.ok(view.includes(part), part);
  assert.ok(main.includes("['deployments', 'replicasets', 'replicationcontrollers', 'statefulsets', 'jobs'].includes(documentReference.type.resource)") && main.includes('scale.target(documentReference)'));
  assert.ok(!/innerHTML|storage\.|writeClipboard/.test(view + main));
});
test('automatic dependency graphs forbid the new Scale write modules in readonly suites; allowlists only cover pure protocol values', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/scale-values.test.ts');
  for (const part of ['scale-https', 'scale-client', 'scale-view', 'https-once']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|scale-client|bridge|sdk)|\.prepare\(|\.submit\(|\.handle\(|\.execute\(/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/scale-values.test.ts'")); assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/scale-wiring.test.ts'"));
});
