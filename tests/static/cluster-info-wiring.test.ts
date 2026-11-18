// Text-only evidence; no execution/import of worker, SDK, real cache, auth or business handlers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (text: string, ...parts: string[]) => { let offset = -1; for (const part of parts) { const at = text.indexOf(part, offset + 1); assert.ok(at > offset, part); offset = at; } };

test('fixed Cluster Info source reads labeled kube-system Services and prints addresses, not a dump/proxy operation', async () => {
  const source = await file('tests/fixtures/contracts/query-contract/kubernetes/kubectl/pkg/cmd/clusterinfo/clusterinfo.go.txt');
  assert.ok(source.includes('cmdNamespace = metav1.NamespaceSystem') && source.includes('LabelSelectorParam("kubernetes.io/cluster-service=true")') && source.includes('ResourceTypeOrNameArgs(false, []string{"services"}...)'));
  assert.ok(source.includes('printService(o.Out, "Kubernetes control plane", o.Client.Host)') && source.includes('return err'));
  const run = source.slice(source.indexOf('func (o *ClusterInfoOptions) Run()'));
  assert.ok(!/NewCmdClusterInfoDump\(|\.Create\(|\.Update\(|\.Delete\(|os\.WriteFile/.test(run));
});
test('Cluster Info private purpose has exact path/no query and fixed namespace/cache/timeout/command only', async () => {
  const plan = await file('src/service/queries/kubectl-plan.ts'), worker = await file('src/service/adapters/read-worker.ts'), ipc = await file('src/service/queries/read-worker-protocol.ts');
  assert.ok(plan.includes("request.path !== '/api/v1/namespaces/kube-system/services' || Object.keys(request.query).length"));
  const branch = plan.slice(plan.indexOf("if (request.purpose === 'cluster-info')", plan.indexOf('const target =')), plan.indexOf("if (request.purpose === 'resource-wide'", plan.indexOf('const target =')));
  assert.ok(branch.includes("'--namespace=kube-system'") && branch.includes("'--cache-dir=/dev/null'") && branch.includes("'cluster-info'") && !branch.includes('dump'));
  assert.ok(worker.includes("start.request.purpose === 'cluster-info'") && ipc.includes("'resource-describe', 'cluster-info'"));
});
test('Cluster Info reader shares scheduler and verifies configuration around printer projection without fabricated object metadata', async () => {
  const reader = await file('src/service/queries/resource-reader.ts'), branch = reader.slice(reader.indexOf('async clusterInfo('), reader.indexOf('async inspect('));
  ordered(branch, 'scheduler.run(', 'await verify(target, sharedSignal)', "request(target, 'cluster-info', '/api/v1/namespaces/kube-system/services')", 'await verify(target, sharedSignal)', 'project(text)');
  assert.ok(!branch.includes('verifyResourceObject('));
});
test('Cluster Info reuses inspection snapshot cache and authenticated route with target-only continuation validation', async () => {
  const query = await file('src/service/queries/inspection-output.ts'), gateway = await file('src/service/queries/resource-gateway.ts'), http = await file('src/service/runtime/http.ts');
  assert.ok(query.includes("if (request.mode === 'cluster-info') await reader.verifyTarget(request.target, signal)") && query.includes('reader.clusterInfo(request.target, project, signal)'));
  assert.ok(query.includes('snapshots.size >= 16') && query.includes('retainedBytes + bytes > 4 * inspectionBytes') && gateway.includes('createInspectionReader(reader)'));
  ordered(http, 'authorized(request.headers.authorization', "url.pathname === '/v2/inspection/read'", 'options.resources.readInspection(input, controller.signal)');
});
test('Cluster Info UI is explicit current-context output and treats addresses/proxy/dump hint as text only', async () => {
  const bridge = await file('src/host/bridge.ts'), panel = await file('src/panel/main.ts'), view = await file('src/panel/inspection-view.ts');
  assert.ok(bridge.includes("readClusterInfo: () => inspections.read({ protocol: 2, target: target(), selection: client.selection, mode: 'cluster-info' })"));
  assert.ok(panel.includes('bridge?.readClusterInfo()') && panel.includes('clusterInfo.dispose()') && panel.includes("'Show current Cluster Info', disabled: !current"));
  assert.ok(view.includes('renderInspectionText(document, pre, logDisplayText(state.text))') && view.includes('serviceNamespace') === false && !/createElement\('a'\)|openExternal|window\.open|innerHTML|clipboard|sendMessage/.test(view));
});
test('Cluster Info readonly tests are allowlisted and cannot reach any real worker, adapter or write lifecycle', async () => {
  const tests = await file('tests/readonly/cluster-info.test.ts'), allowlist = await file('scripts/readonly-tests.ts');
  assert.ok(allowlist.includes("'tests/readonly/cluster-info.test.ts'"));
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|bridge|namespace-client|preference-client)/.test(tests) && !/spawn\(|fork\(|readThroughWorker\(|runReadWorker\(/.test(tests));
});
