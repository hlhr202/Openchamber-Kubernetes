// Text-only audit. Never execute real kubectl/worker/SDK/DOM or any Apply/Save/confirmation/upload/write chain.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('fixed upstream Diff is get + vscode.diff, with no-change not inferred from NothingToDiff and Apply branching separately', async () => {
  const code = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt'), diff = code.slice(code.indexOf('function diffKubernetesCore'), code.indexOf('const debugKubernetes'));
  assert.ok(diff.includes('kubectl.invokeCommandThen(` get -o ${fileFormat} ${kindName}`') && diff.includes("'vscode.diff'") && diff.includes('DiffResultKind.NoClusterResource'));
  const apply = code.slice(code.indexOf('const applyKubernetes'), code.indexOf('const handleError'));
  assert.ok(apply.includes("maybeRunKubernetesCommandForActiveWindow('create'") && apply.includes('DiffResultKind.NoKindName') && apply.includes('DiffResultKind.GetFailed'));
});
test('new private Diff GET purpose is exact GVR/name/namespace and cannot broaden builtin or CRD Load/Watch/Delete admission', async () => {
  const code = await file('src/service/queries/kubectl-plan.ts'), protocol = await file('src/service/queries/read-worker-protocol.ts');
  for (const part of ["request.purpose !== 'manifest-diff' && request.comparison !== undefined", 'request.path !== manifestComparisonPath(reference.data)', "request.method !== 'GET'", 'Object.keys(request.query).length', "'--request-timeout=7s'"]) assert.ok(code.includes(part));
  assert.ok(protocol.includes('comparison: manifestComparisonReferenceSchema.optional()'));
  assert.ok(code.includes("request.purpose === 'resource-object' || request.purpose === 'resource-wide'"));
});
test('service resolves exact discovery get only, brackets one object GET, rejects mismatched identities and never runs a diff/write CLI', async () => {
  const code = await file('src/service/queries/manifest-comparison.ts');
  for (const part of ["projectDiscovery(discovery, ['get'])", 'matches.length !== 1', 'metadata.entries.filter(([key]) => key !== \'managedFields\')', "purpose: 'manifest-diff'", 'JSON.stringify(after) !== JSON.stringify(reference)', 'expectedUid !== undefined && uid !== expectedUid']) assert.ok(code.includes(part), part);
  assert.ok(!/spawn\(|exec\(|writeFile\(|dry-run|operations\/|\.submit\(/.test(code));
});
test('captured Diff snapshots retain16/4MiB/fixed60s and only verify original config on chunk reads, not rerun moving live data', async () => {
  const code = await file('src/service/queries/manifest-diff-reader.ts'), gateway = await file('src/service/queries/resource-gateway.ts'), reader = await file('src/service/queries/resource-reader.ts');
  for (const part of ['preparing >= 2', 'records.size + preparing >= 16', '4_194_304', 'clock() + 60_000', 'record.identity !== cursor.identity', 'reader.comparisonSnapshot(', 'records.delete(record.id)', 'codec.dispose()']) assert.ok(code.includes(part));
  assert.ok(gateway.includes('createManifestDiffReader(reader)') && gateway.includes('comparisons.close()'));
  assert.ok(reader.includes("scheduler.run(key(target, 'manifest-diff'") && reader.includes("scheduler.run(key(target, 'manifest-diff-snapshot'"));
  assert.ok(!code.includes('new ReadScheduler'));
});
test('local original body stays browser-side; only strict locator/selection/config/format/expectedUid/cursor reach read RPC', async () => {
  const protocol = await file('src/shared/manifest-diff-protocol.ts'), client = await file('src/host/manifest-diff-client.ts'), source = await file('src/host/manifest-diff-source.ts');
  const request = protocol.slice(protocol.indexOf('export const manifestDiffRequestSchema'), protocol.indexOf('export type ManifestDiffRequest'));
  assert.ok(!/text:|content:|body:|payload:|argv:|url:/.test(request));
  for (const part of ['localComparisonDocuments(source.text', 'this.#calls >= 2', 'finally { this.#calls--; }', 'totalBytes > 4_194_304', 'page.offset !== text.length', 'page.identity !== previous.identity', 'reference.namespace !== (locator.namespace ?? source.target.namespace)', 'this.#current(source)']) assert.ok(client.includes(part), part);
  assert.ok(source.includes('text.slice(start, end)') && source.includes('strictNamespace: true') && !/writeFile|plural|\.submit\(/.test(source.replace('GVR guess/pluralization', 'routing')));
});
test('literal comparison has bounded alignment, explicitly labels budget omission and does not turn malformed/no-input into equal success', async () => {
  const code = await file('src/shared/text-comparison.ts');
  for (const part of ['local === live', "equal: false, alignment: 'omitted-budget'", '20_000', '1_000_000', 'ranges.length >= 4096', 'distance <= 64']) assert.ok(code.includes(part));
  assert.ok(!/operations\/|serviceRequest|spawn\(|writeFile\(/.test(code));
});
test('HTTP/bridge/panel wire only read-only Diff, clear old project buffers, invalidate source/context changes and never add an Apply button', async () => {
  const http = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts'), view = await file('src/panel/manifest-diff-view.ts'), main = await file('src/panel/main.ts');
  const index = http.indexOf("url.pathname === '/v2/manifest-diff/read'"); assert.ok(index > http.indexOf('authorized(request.headers.authorization'));
  const route = http.slice(index, http.indexOf("url.pathname === '/v2/helm/repositories/read'", index)); assert.ok(route.includes('boundedBody(request, controller.signal, 48_000)') && route.includes('options.resources.readManifestDiff(input, controller.signal)') && !route.includes('fileSaves.handle'));
  assert.ok(bridge.includes('manifestDiff?.changed()') && bridge.includes('manifestDiff?.reset()') && bridge.includes('manifestDiff?.dispose()'));
  assert.ok(main.includes('bridge.onManifestDiff(') && main.includes('stopManifestDiff(); manifestDiff.dispose()'));
  assert.ok(view.includes('pre.textContent = text') && view.includes('bridge()?.readManifestDiff(kind, format') && !/innerHTML|storage\.|writeClipboard|\.submit\(|\.prepare\(/.test(view));
});
test('automatic Diff tests use only independent synthetic reads/pure display and never import real adapters/SDK/runtime/operation code', async () => {
  const code = await file('tests/readonly/manifest-diff.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|sessions\/|runtime\/|bridge|@openchamber)|\.submit\(|\.commit\(|new FileSaveClient/.test(code));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/manifest-diff.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/manifest-diff-wiring.test.ts'"));
});
