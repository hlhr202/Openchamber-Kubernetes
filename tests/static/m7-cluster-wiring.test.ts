// Text/metadata only. Never import or invoke the minikube CLI, DAP bridge, cluster operations or clients.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('the minikube CLI keeps bounded probes and exactly two G4-gated writes', async () => {
  const adapter = await file('src/service/adapters/minikube-cli.ts');
  for (const part of ["['status', '--output=json']", "['profile', 'list', '--output=json']", "['start', `--driver=${driver}`]", "['stop']", 'shell: false', 'process.kill(-child.pid', '16_384']) assert.ok(adapter.includes(part), part);
  assert.ok(!/--download|console\.|setInterval|writeFile/.test(adapter));
  assert.ok((adapter.match(/async (status|profileList|start|stop)\(/g) ?? []).length === 4);
});
test('the DAP bridge is a bounded loopback TCP client on the pure codec', async () => {
  const bridge = await file('src/service/sessions/dap-bridge.ts');
  for (const part of ["connect(port, host)", "host !== '127.0.0.1'", 'decodeDapFrames', 'encodeDapFrame', 'maxBuffered', 'socket.destroy()', 'protocol violation closes the bridge']) assert.ok(bridge.includes(part), part);
  assert.ok(!/spawn|execFile|console\.|setInterval|writeFile/.test(bridge));
});
test('the cluster operation composes the M5 sessions and pins the debug chain stages', async () => {
  const operations = await file('src/service/operations/cluster-operations.ts');
  for (const part of ["'ps', '-o', 'pid,command', '-e', '-w', '-w'", 'defaultDebugPort', 'openDapBridge', "command: 'initialize'", "sessionKind: 'port-forward'", "z.literal('minikube-exact-lifecycle')", "z.literal('debug-exact-pod-language')", 'adapter-resolved ports stay human-package']) assert.ok(operations.includes(part), part);
  assert.ok(operations.includes('createG4SubmitGate'));
  assert.ok(!/console\.|setInterval|writeFile/.test(operations));
});
test('runtime authenticates the route, constructs the operations, and the view exposes explicit controls', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), bridge = await file('src/host/bridge.ts'), view = await file('src/panel/cluster-view.ts');
  const offset = http.indexOf("url.pathname === '/v2/operations/cluster'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.clusterOperations.handle(input, controller.signal)') && http.includes('options.clusterOperations.close()'));
  assert.ok(main.includes('createClusterOperations({ serviceGeneration, lock, minikube: createMinikubeCliRunner(environment.path), telepresence: createTelepresenceCliRunner(environment.path), sessions: sessionService })'));
  assert.ok(bridge.includes('new ClusterClient') && bridge.includes('minikubeStatus') && bridge.includes('debugPrepare') && bridge.includes('selectPodEntries'));
  for (const part of ['minikubeStatus()', 'minikubePrepare(', 'debugPrepare(', 'clusterSubmit()', 'clusterCancel()', 'debugRemove()']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|writeClipboard/.test(view));
});
test('read paths cannot reach the new modules; the codec suite is registered', async () => {
  const check = await file('scripts/check-static.ts');
  for (const part of ['minikube-cli', 'cluster-client', 'cluster-view']) assert.ok(check.includes(part), part);
  const readonly = await file('tests/readonly/dap-protocol-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|sessions\/|operations\/|runtime\/|cluster-client|bridge)/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/dap-protocol-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/m7-cluster-wiring.test.ts'"));
});
