// Text/metadata only. Never import or invoke Add File client/controller/HTTPS adapter, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream configMap text proves the text/base64 encoding and full-replace add semantics', async () => {
  const body = await file('tests/fixtures/baseline/kubernetes/src/configMap.ts.txt');
  for (const part of ["buff.toString()", "buff.toString('base64')", 'dataHolder.data[fileName]', 'replace -f - --namespace', "Are you sure you want to overwrite"]) assert.ok(body.includes(part), part);
});
test('value encoding follows the pinned kind rule: ConfigMap text, Secret standard base64', async () => {
  const code = await file('src/service/adapters/config-file-add-https.ts');
  for (const part of ["export function encodeConfigFileValue", "kind === 'ConfigMap' ? text : Buffer.from(text, 'utf8').toString('base64')"]) assert.ok(code.includes(part), part);
});
test('the rebuilt object sets exactly one key, preserves the others and binaryData, and keeps the pinned RV', async () => {
  const code = await file('src/service/adapters/config-file-add-https.ts'), build = code.slice(code.indexOf('export function buildKeyAddedObject'));
  for (const part of ['existing.filter(([key]) => key !== parsed.key)', '// binaryData and every other field pass through untouched; only data gains the key.',
    "checkData.find(([key]) => key === parsed.key)?.[1].kind !== 'string'", 'checkData.length !== merged.length',
    "documentString(documentProperty(object(documentProperty(check, 'metadata')), 'resourceVersion')) !== reference.resourceVersion"]) assert.ok(build.includes(part), part);
  assert.ok(build.includes('An existing key is overwritten by the user\'s explicit confirm')); // the confirm IS the upstream per-key decision
});
test('dispatch is exactly two one-shot requests: pinned-UID/RV parent GET then ONE full-object PUT replace', async () => {
  const code = await file('src/service/adapters/config-file-add-https.ts');
  assert.equal((code.match(/onceRequest</g) ?? []).length, 2);
  for (const part of ['await beforeDispatch()', "'PUT', 'application/json', 200", "throw new BoundaryError('NOT_FOUND')", "outcome: 'accepted'", 'rv !== parameters.reference.resourceVersion', "entry?.kind === 'string' && entry.value === encodeConfigFileValue"]) assert.ok(code.includes(part), part);
  assert.ok(!/httpsRequest\(|fetch\(|spawn\(|setInterval\(|writeFile|console\./.test(code));
});
test('operations reuse the E024 file-source verification (read proof rebind, no Save receipts) plus the delete-shaped chain', async () => {
  const code = await file('src/service/operations/config-file-add.ts');
  for (const part of ['options.fileSaves.verifyConsumption(', 'options.workspace.rebind({ protocol: 2, root: file.root, path: file.path, proof: record.fileProof }', 'record.fileChecks > 100',
    'options.resources.verifyReference(', 'Date.now() + 60_000', 'options.lock.run(record.controller.signal', "record.value !== value", 'options.workspace.release({ protocol: 2, scope: record.fileScope })', 'Unknown records are never silently evicted']) assert.ok(code.includes(part), part);
  assert.ok(!/readConfigParentData|setInterval|console\.|writeFile/.test(code));
});
test('write client binds the file to the open workspace editor state only via its original proof and never replays a submit', async () => {
  const client = await file('src/host/config-file-add-client.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['saveContentSnapshot(text)', "snapshot.digest !== file.identity", "confirmation: 'config-file-add-exact-key'", 'result.outcome.encodedBytes === undefined', 'this.#calls >= 4']) assert.ok(client.includes(part), part);
  assert.ok(bridge.includes('file.origin.path === filePath') && bridge.includes('proof: file.origin.proof')); // never the dirty editor text without the matching origin
});
test('runtime authenticates the add route; rows pin the exact parent; accepted results only mark metadata stale', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), view = await file('src/panel/config-file-add-view.ts');
  const offset = http.indexOf("url.pathname === '/v2/operations/config-file-add'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 420).includes('options.configFileAdds.handle(input, controller.signal)') && http.includes('options.configFileAdds.close()'));
  assert.ok(main.includes('createConfigFileAddOperations({ serviceGeneration, config, resources, lock, workspace, fileSaves, execute: createConfigFileAddHttpsAdapter(config) })'));
  for (const part of ['Server workspace file path (captured independently; never the dirty editor)', 'may overwrite this key', "state.phase !== 'confirm'"]) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard/.test(view));
});
test('automatic dependency graphs forbid the new write modules in readonly suites; allowlists cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/config-file-add-values.test.ts');
  for (const part of ['config-file-add-https', 'config-file-add-client', 'config-file-add-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|config-file-add-client|bridge|sdk)|\.prepare\(|\.submit\(|\.handle\(|\.execute\(/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/config-file-add-values.test.ts'")); assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/config-file-add-wiring.test.ts'"));
});
