// Text/metadata only. Never import or invoke the ApplyFile client/controller/HTTPS adapter, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('the approved D-02 chain splits files server-side via the strict streaming splitter', async () => {
  const operation = await file('src/service/operations/apply-file.ts');
  for (const part of ['readApplyFileDocuments(captured.text, file.format)', 'probeApplyFileDocument', "captured.version !== file.version || captured.identity !== file.identity",
    'createG4SubmitGate<Parameters, Attachment>', "step: 'apply-file'", 'workspace.rebind', 'workspace.capture', 'workspace.release']) assert.ok(operation.includes(part), part);
  assert.ok(!/execFile|spawn|writeFile|console\.|setInterval/.test(operation));
  const splitter = await file('src/parsing/apply-file-documents.ts');
  assert.ok(splitter.includes('composer') || splitter.includes('analyseManifestBundle'));
  assert.ok(splitter.includes('applyFileMaxDocuments = 16'));
});
test('the transport performs one discovery GET per group/version, one fresh GET and one write per document', async () => {
  const adapter = await file('src/service/adapters/apply-file-https.ts');
  for (const part of ["from './https-once.ts'", 'directConnection', 'resolveManifestComparison', 'projectDiscovery', "manifestComparisonPath(reference)",
    "document.action === 'create' ? 'POST' : 'PATCH'", "document.action === 'create' ? 'application/json' : 'application/merge-patch+json'", 'fieldManager=kubectl-client-side-apply', 'fieldManager=kubectl-create',
    'reviewManifestJsonMerge', 'beforeDispatch()', 'body.fill(0)', 'transport.ca?.fill(0)']) assert.ok(adapter.includes(part), part);
  assert.ok(!/fetch\(|spawn\(|setInterval\(|location\]|console\.|writeFile/.test(adapter));
  assert.ok(adapter.includes('strictly in order'));
  assert.ok((adapter.match(/onceRequest</g) ?? []).length === 3); // discovery GET, fresh GET, one write
});
test('runtime authenticates the route, constructs the operation with the shared write lock, and closes it', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), bridge = await file('src/host/bridge.ts');
  const offset = http.indexOf("url.pathname === '/v2/operations/apply-file'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.applyFiles.handle(input, controller.signal)') && http.includes('options.applyFiles.close()'));
  assert.ok(main.includes('createApplyFileOperations({ serviceGeneration, config, resources, workspace, lock, execute: createApplyFileHttpsAdapter(config) })'));
  assert.ok(bridge.includes('applyFiles?.prepare(target(), client.selection, source') && bridge.includes('resources.invalidate(key, state.outcome.target)'));
});
test('the view keeps explicit confirm and original ledger, and the panel wires it like the other write views', async () => {
  const view = await file('src/panel/apply-file-view.ts'), main = await file('src/panel/main.ts');
  for (const part of ['bridge()?.prepareApplyFile()', 'bridge()?.submitApplyFile()', 'bridge()?.cancelApplyFile()', 'bridge()?.applyFileOutcomes()']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard/.test(view));
  assert.ok(main.includes('mountApplyFileView') && main.includes('bridge.onApplyFile('));
});
test('read paths can never reach the new write modules', async () => {
  const check = await file('scripts/check-static.ts');
  for (const part of ['apply-file-https', 'apply-file-client', 'apply-file-view']) assert.ok(check.includes(part), part);
  const readonly = await file('tests/readonly/apply-file-values.test.ts');
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|apply-file-client|bridge|sdk)/.test(readonly));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/apply-file-wiring.test.ts'"));
});
