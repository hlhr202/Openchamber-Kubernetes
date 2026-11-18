// Text/metadata only. Never import or invoke Delete File client/controller/HTTPS adapter, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream configMap text proves the one-key remove + full replace semantics', async () => {
  const body = await file('tests/fixtures/baseline/kubernetes/src/configMap.ts.txt');
  for (const part of ['function removeKey', 'if (key !== keyToDelete)', 'replace -f - --namespace', 'Are you sure you want to delete', 'explorer.refresh()']) assert.ok(body.includes(part), part);
});
test('the rebuilt object removes exactly one key, keeps every other key and the pinned RV untouched', async () => {
  const code = await file('src/service/adapters/config-file-delete-https.ts'), build = code.slice(code.indexOf('export function buildKeyDeletedObject'));
  for (const part of ["if (!entries.some(([key]) => key === parsed.key)) throw new BoundaryError('NOT_FOUND')", 'entries.filter(([key]) => key !== parsed.key)', "stringEntries(checkData).some(([key]) => key === parsed.key)", 'kept.length !== stringEntries(checkData).length', "documentString(documentProperty(object(documentProperty(check, 'metadata')), 'resourceVersion')) !== reference.resourceVersion"]) assert.ok(build.includes(part), part);
  assert.ok(build.includes('// binaryData and every other field pass through untouched; only data is filtered.'));
});
test('dispatch is exactly two one-shot requests: pinned-UID/RV parent GET then ONE full-object PUT replace', async () => {
  const code = await file('src/service/adapters/config-file-delete-https.ts');
  assert.equal((code.match(/onceRequest</g) ?? []).length, 2);
  for (const part of ['await beforeDispatch()', 'Date.now() >= request.notAfter', "'PUT', 'application/json', 200", "throw new BoundaryError('NOT_FOUND')", "outcome: 'accepted'", '!keys.some(([key]) => key === parameters.key)']) assert.ok(code.includes(part), part);
  assert.ok(code.includes('rv !== parameters.reference.resourceVersion')); // accepted replace must land a NEW RV
  assert.ok(!/httpsRequest\(|fetch\(|spawn\(|setInterval\(|writeFile|console\./.test(code));
});
test('operations reuse the delete-shaped G4 chain with fresh parent proof and an original ledger', async () => {
  const code = await file('src/service/operations/config-file-delete.ts');
  for (const part of ['options.resources.verifyReference(', 'Date.now() + 60_000', 'options.lock.run(record.controller.signal', "update(record, 'dispatching')", "result.outcome === 'accepted' ? 'accepted'", 'Unknown records are never silently evicted']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|console\.|writeFile/.test(code));
});
test('write client validates the key client-side and never replays a submit; runtime route is authenticated', async () => {
  const client = await file('src/host/config-file-delete-client.ts'), http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts');
  for (const part of ['configDataKeySchema.safeParse(keyInput).success', "confirmation: 'config-file-delete-exact-key'", 'result.outcome.parameters.key !== parameters.key', 'this.#calls >= 4']) assert.ok(client.includes(part), part);
  const offset = http.indexOf("url.pathname === '/v2/operations/config-file-delete'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 420).includes('options.configFileDeletes.handle(input, controller.signal)') && http.includes('options.configFileDeletes.close()'));
  assert.ok(main.includes('createConfigFileDeleteOperations({ serviceGeneration, config, resources, lock, execute: createConfigFileDeleteHttpsAdapter(config) })'));
});
test('rows only pin the exact ConfigMap/Secret reference; the view keeps an explicit single-key confirm', async () => {
  const view = await file('src/panel/config-file-delete-view.ts'), main = await file('src/panel/main.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['Data key to delete (exactly one; other keys are preserved)', 'bridge()?.prepareConfigFileDelete(reference, key)', "state.phase !== 'confirm'", 'bridge()?.submitConfigFileDelete()']) assert.ok(view.includes(part), part);
  assert.ok(main.includes("documentReference.type.resource === 'configmaps' || documentReference.type.resource === 'secrets'") && main.includes('configFileDelete.target(documentReference)'));
  assert.ok(bridge.includes('resources.invalidate(key, state.outcome.target)'));
  assert.ok(!/innerHTML|storage\.|writeClipboard/.test(view + main));
});
test('automatic dependency graphs forbid the new write modules in readonly suites; allowlists cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/config-file-delete-values.test.ts');
  for (const part of ['config-file-delete-https', 'config-file-delete-client', 'config-file-delete-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|config-file-delete-client|bridge|sdk)|\.prepare\(|\.submit\(|\.handle\(|\.execute\(/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/config-file-delete-values.test.ts'")); assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/config-file-delete-wiring.test.ts'"));
});
