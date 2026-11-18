// Text/metadata only. Never import or invoke the merge client/adapter/operation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('the file adapter keeps the audited config-writer safety rules', async () => {
  const adapter = await file('src/service/adapters/merge-kubeconfig-file.ts');
  for (const part of ['parentsSafe', "value.mode & 0o022n", "info.nlink !== 1n", "constants.O_NOFOLLOW", "constants.O_EXCL", '0o600', 'rename(temporary, snapshot.path)', 'staged.sync()', 'chmod', 'chown', 'Irrevocable boundary']) assert.ok(adapter.includes(part), part);
  assert.ok(!/console\.|setInterval|writeFileSync/.test(adapter));
});
test('the operation uses upstream-verbatim merge semantics and one staged replace on the G4 gate', async () => {
  const operation = await file('src/service/operations/merge-kubeconfig.ts');
  for (const part of ['collisionState', 'keepBothSuffix', 'applyKeepBothSuffix', 'mergeFirstStanzas', 'shouldSetCurrentContext', 'createG4SubmitGate', "step: 'merge-kubeconfig'", 'FIRST EXISTING', 'CONFIG_CHANGED', 'stringify(merged)']) assert.ok(operation.includes(part), part);
  assert.ok(!/console\.|writeFileSync|setInterval/.test(operation));
});
test('runtime authenticates the route and constructs the operation with the shared write lock', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), bridge = await file('src/host/bridge.ts'), view = await file('src/panel/merge-kubeconfig-view.ts');
  const offset = http.indexOf("url.pathname === '/v2/operations/merge-kubeconfig'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.mergeKubeconfigs.handle(input, controller.signal)') && http.includes('options.mergeKubeconfigs.close()'));
  assert.ok(main.includes('createMergeKubeconfigOperations({ serviceGeneration, defaultPaths, lock, files: createMergeKubeconfigFileAdapter() })'));
  assert.ok(bridge.includes('new MergeKubeconfigClient') && bridge.includes('mergeKubeconfigs?.prepare(client.selection,'));
  for (const part of ['prepareMergeKubeconfig(', 'submitMergeKubeconfig()', 'cancelMergeKubeconfig()', 'mergeKubeconfigOutcomes()']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|writeClipboard/.test(view));
});
test('read paths cannot reach the new modules and the suites are registered', async () => {
  const check = await file('scripts/check-static.ts');
  for (const part of ['merge-kubeconfig-file', 'merge-kubeconfig-client', 'merge-kubeconfig-view']) assert.ok(check.includes(part), part);
  const readonly = await file('tests/readonly/merge-kubeconfig-values.test.ts');
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|merge-kubeconfig-client|bridge)/.test(readonly));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/merge-kubeconfig-wiring.test.ts'"));
});
