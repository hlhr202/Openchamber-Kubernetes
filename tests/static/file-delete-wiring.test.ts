// Text/metadata only. Never import or invoke file-delete client/controller/HTTPS adapter, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the confirm-then-delete-from-file semantics without --now/--force', async () => {
  const utils = await file('tests/fixtures/baseline/kubernetes/src/kubectlUtils.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  for (const part of ['function deleteResourceFromUri', "'Are you sure you want to delete this resource?'", 'changeResourceFromUri(uri, kubectl, \'delete\'']) assert.ok(utils.includes(part), part);
  assert.ok(extension.includes("registerCommand('extension.vsKubernetesDeleteUri'"));
  assert.ok(utils.includes("uri.scheme !== 'file'")); // non-file URIs are a fixed upstream failure
});
test('the document resolver admits exactly one document, only the descriptor plane, with target-default namespace', async () => {
  const code = await file('src/service/adapters/file-delete-https.ts'), resolve = code.slice(code.indexOf('export function resolveFileDeleteReference'));
  for (const part of ['documents.length !== 1', 'matches.length !== 1', 'type.version !== version', 'namespace ?? target.namespace', 'documentReferenceSchema.parse(reference)']) assert.ok(resolve.includes(part), part);
  assert.ok(resolve.includes('no served-version guessing'));
});
test('the DELETE body carries exact uid/resourceVersion preconditions with Background propagation', async () => {
  const code = await file('src/service/adapters/file-delete-https.ts');
  for (const part of ['export function buildDeleteOptionsBody', "value: 'DeleteOptions'", "['uid', { kind: 'string', value: reference.uid }]", "['resourceVersion', { kind: 'string', value: reference.resourceVersion }]", "value: 'Background'"]) assert.ok(code.includes(part), part);
  assert.ok(!/--now|--force|gracePeriodSeconds/.test(code));
});
test('dispatch is exactly two one-shot requests: pinned-UID/RV GET then ONE preconditioned DELETE', async () => {
  const code = await file('src/service/adapters/file-delete-https.ts');
  assert.equal((code.match(/onceRequest</g) ?? []).length, 2);
  for (const part of ['await beforeDispatch()', "'DELETE', 'application/json', 200", "throw new BoundaryError('NOT_FOUND')", "outcome: 'accepted'", "kind === 'Status'", "documentString(documentProperty(value, 'status')) === 'Success'"]) assert.ok(code.includes(part), part);
  assert.ok(!/httpsRequest\(|fetch\(|spawn\(|setInterval\(|writeFile|console\./.test(code));
});
test('operations reuse the E024 file verification and pin the live reference before any confirmation', async () => {
  const code = await file('src/service/operations/file-delete.ts');
  for (const part of ['options.fileSaves.verifyConsumption(', 'options.workspace.rebind({ protocol: 2, root: file.root, path: file.path, proof: record.fileProof }', 'resolveFileDeleteReference(text, owner.target)',
    'options.resources.verifyReference(', 'record.text !== text || !record.reference', 'Date.now() + 60_000', 'options.lock.run(record.controller.signal', 'Unknown records are never silently evicted']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|console\.|writeFile/.test(code));
});
test('runtime authenticates the route; the client binds the file to the open workspace editor origin; accepted only marks metadata stale', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), client = await file('src/host/file-delete-client.ts'), bridge = await file('src/host/bridge.ts'), view = await file('src/panel/file-delete-view.ts');
  const offset = http.indexOf("url.pathname === '/v2/operations/file-delete'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 420).includes('options.fileDeletes.handle(input, controller.signal)') && http.includes('options.fileDeletes.close()'));
  assert.ok(main.includes('createFileDeleteOperations({ serviceGeneration, config, resources, lock, workspace, fileSaves, execute: createFileDeleteHttpsAdapter(config) })'));
  for (const part of ['saveContentSnapshot(text)', "snapshot.digest !== file.identity", "confirmation: 'file-delete-exact-pinned-object'", '!result.outcome.reference', 'this.#calls >= 4']) assert.ok(client.includes(part), part);
  assert.ok(bridge.includes('file.origin.path === filePath') && bridge.includes('proof: file.origin.proof'));
  for (const part of ['Server workspace file path (single document; captured independently)', 'single DELETE', "state.phase !== 'confirm'"]) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard/.test(view + client));
});
test('automatic dependency graphs forbid the new write modules in readonly suites; allowlists cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/file-delete-values.test.ts');
  for (const part of ['file-delete-https', 'file-delete-client', 'file-delete-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|file-delete-client|bridge|sdk)|\.prepare\(|\.submit\(|\.handle\(|\.execute\(/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/file-delete-values.test.ts'")); assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/file-delete-wiring.test.ts'"));
});
