// Text/metadata only. Never import or invoke the helm cluster write client/adapter/operation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('the D-01 zero-materialisation transport keeps the token out of argv and files', async () => {
  const adapter = await file('src/service/adapters/helm-cluster-cli.ts');
  for (const part of ["'--kube-apiserver', server", 'HELM_KUBETOKEN: transport.token', 'helmClusterArguments', 'NO --kubeconfig and NO --kube-context', 'mkdtemp', "0o700", "0o600", 'unlink(caFile)', 'transport.ca?.fill(0)', 'beforeDispatch()', 'shell: false']) assert.ok(adapter.includes(part), part);
  assert.ok(!/['"]--kube-token|['"]--kubeconfig|console\.|setInterval/.test(adapter));
  assert.ok(!adapter.includes("--kubeconfig="));
  assert.ok(adapter.includes('CA destruction'));
});
test('the G4 write chain re-proves the release state before confirming (M6-C4 provenance)', async () => {
  const operation = await file('src/service/operations/helm-cluster-write.ts');
  for (const part of ['createG4SubmitGate<HelmWriteParameters>', "step: 'helm-cluster-write'", 'readHelmReleases', "parameters.action === 'install' && existing", "newest.uid !== parameters.provenanceUid || newest.resourceVersion !== parameters.provenanceResourceVersion", 'STALE_TARGET']) assert.ok(operation.includes(part), part);
  assert.ok(!/execFile|spawn\(|writeFile|console\.|setInterval/.test(operation));
});
test('runtime authenticates the route, constructs the operation, and the view exposes explicit confirm', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), bridge = await file('src/host/bridge.ts'), view = await file('src/panel/helm-release-view.ts');
  const offset = http.indexOf("url.pathname === '/v2/operations/helm-cluster-write'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmClusterWrites.handle(input, controller.signal)') && http.includes('options.helmClusterWrites.close()'));
  assert.ok(main.includes('createHelmClusterWriteOperations({ serviceGeneration, config, resources, lock, execute: createHelmClusterCliRunner(environment.path, config) })'));
  assert.ok(bridge.includes('new HelmWriteClient') && bridge.includes('prepareHelmWrite'));
  for (const part of ['prepareHelmWrite', 'submitHelmWrite()', 'cancelHelmWrite()', 'helmWriteOutcomes()']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|writeClipboard/.test(view));
});
test('the write protocol values are covered in the registered readonly suite and protected statically', async () => {
  const check = await file('scripts/check-static.ts');
  for (const part of ['helm-cluster-cli', 'helm-write-client']) assert.ok(check.includes(part), part);
  const readonly = await file('tests/readonly/helm-release-values.test.ts');
  assert.ok(readonly.includes('helmWriteParametersSchema') || readonly.includes('helmWriteRequestSchema'));
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|helm-write-client|bridge)/.test(readonly));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-cluster-write-wiring.test.ts'"));
});
