// Text/metadata only. Never import or invoke Expose client/controller/HTTPS adapter, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned kubectl expose sources prove selector/port derivation and the inline createService mapping', async () => {
  const records = JSON.parse(await file('tests/fixtures/contracts/manifest-expose-contract/source-read.json')).records; assert.equal(records.length, 2);
  for (const record of records) { const body = await file(record.local); assert.equal(Buffer.byteLength(body), record.bytes); assert.equal(createHash('sha256').update(body).digest('hex'), record.sha256); }
  const selector = await file('tests/fixtures/contracts/manifest-expose-contract/pkg__polymorphichelpers__mapbasedselectorforobject.go.txt');
  for (const part of ['the pod has no labels and cannot be exposed', 'the service has no pod selector set', "couldn't convert expressions", 'MakeLabels(t.Spec.Selector.MatchLabels)']) assert.ok(selector.includes(part), part);
  const ports = await file('tests/fixtures/contracts/manifest-expose-contract/pkg__polymorphichelpers__portsforobject.go.txt');
  for (const part of ['getPorts(t.Spec)', 'getServicePorts', 'remove duplicate ports', 'getPorts(t.Spec.Template.Spec)']) assert.ok(ports.includes(part), part);
  const expose = await file('tests/fixtures/contracts/manifest-expose-contract/pkg__cmd__expose__expose.go.txt');
  for (const part of ['MapBasedSelectorForObject(info.Object)', 'PortsForObject(info.Object)', 'protocol = "TCP"', 'service.Spec.Ports[i].TargetPort = intstr.FromInt32(port)', 'strings.Join(ports, ",")']) assert.ok(expose.includes(part), part);
});
test('selector and port derivations follow the pinned per-kind rules and reject set-based selectors', async () => {
  const code = await file('src/service/adapters/expose-https.ts');
  for (const part of ['export function deriveExposeSelector', "kind === 'Pod'", "kind === 'Service'", 'matchExpressions', 'export function deriveExposePorts', 'containerPort', "found.includes(value)"]) assert.ok(code.includes(part), part);
});
test('the Service body reproduces the pinned createService mapping with explicit-or-single-derived port and targetPort default', async () => {
  const code = await file('src/service/adapters/expose-https.ts'), build = code.slice(code.indexOf('export function buildExposedService'));
  for (const part of ['parsed.port ?? (derived.length === 1 ? derived[0] : undefined)', "parsed.protocol ?? 'TCP'", 'parsed.targetPort ?? port', "['selector', { kind: 'object', entries: selector }]", "['ports', { kind: 'array', items: [servicePort] }]", "value: 'Service'"]) assert.ok(build.includes(part), part);
  assert.ok(build.includes('documentProperty(builtMetadata, \'uid\') !== undefined')); // no stale identity in a create body
});
test('dispatch is exactly two one-shot requests: pinned-UID/RV target GET then ONE services POST', async () => {
  const code = await file('src/service/adapters/expose-https.ts');
  assert.equal((code.match(/onceRequest</g) ?? []).length, 2);
  for (const part of ['await beforeDispatch()', 'Date.now() >= request.notAfter', "'POST', 'application/json', 201", "throw new BoundaryError('NOT_FOUND')", "outcome: 'accepted'", '/services']) assert.ok(code.includes(part), part);
  assert.ok(!/httpsRequest\(|fetch\(|spawn\(|setInterval\(|writeFile|console\./.test(code));
});
test('operations reuse the delete-shaped G4 chain with fresh target proof and an original ledger', async () => {
  const code = await file('src/service/operations/expose.ts');
  for (const part of ['options.resources.verifyReference(', 'Date.now() + 60_000', 'options.lock.run(record.controller.signal', "update(record, 'dispatching')", "result.outcome === 'accepted' ? 'accepted'", 'Unknown records are never silently evicted']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|console\.|writeFile/.test(code));
});
test('write client parses the numeric port rule client-side, defaults the name, and never replays a submit', async () => {
  const code = await file('src/host/expose-client.ts');
  for (const part of ['parseExposePortInput(fields.port)', 'parseExposePortInput(fields.targetPort)', "fields.name || base.data.name", "confirmation: 'expose-exact-origin'", 'result.outcome.parameters.port !== parameters.port', 'this.#calls >= 4']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|writeClipboard|storage\.|console\./.test(code));
});
test('runtime authenticates the expose route and accepted results only mark services metadata stale', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), bridge = await file('src/host/bridge.ts');
  const offset = http.indexOf("url.pathname === '/v2/operations/expose'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 400).includes('options.exposes.handle(input, controller.signal)') && http.includes('options.exposes.close()'));
  assert.ok(main.includes('createExposeOperations({ serviceGeneration, config, resources, lock, execute: createExposeHttpsAdapter(config) })'));
  assert.ok(bridge.includes("resources.invalidate('services', state.outcome.target)") && bridge.includes('exposes?.prepare(target(), client.selection, reference, fields)'));
});
test('rows only pin the exact reference; the view keeps explicit inputs and a separate confirm', async () => {
  const view = await file('src/panel/expose-view.ts'), main = await file('src/panel/main.ts');
  for (const part of ['Port 1-65535 (optional: single derived port when omitted)', 'bridge()?.prepareExpose(reference,', "state.phase !== 'confirm'", 'bridge()?.submitExpose()']) assert.ok(view.includes(part), part);
  assert.ok(main.includes("documentReference.type.resource === 'deployments' || documentReference.type.resource === 'pods' || documentReference.type.resource === 'services'") && main.includes('expose.target(documentReference)'));
  assert.ok(!/innerHTML|storage\.|writeClipboard/.test(view + main));
});
test('automatic dependency graphs forbid the new write modules in readonly suites; allowlists cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/expose-values.test.ts');
  for (const part of ['expose-https', 'expose-client', 'expose-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|expose-client|bridge|sdk)|\.prepare\(|\.submit\(|\.handle\(|\.execute\(/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/expose-values.test.ts'")); assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/expose-wiring.test.ts'"));
});
