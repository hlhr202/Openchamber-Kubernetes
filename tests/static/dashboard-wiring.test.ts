// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the proxy URL/terminal name, AKS heuristic and dashboard-pod query', async () => {
  const dashboard = await file('tests/fixtures/baseline/kubernetes/src/components/kubectl/dashboard.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(dashboard.includes('const KUBE_DASHBOARD_URL = "http://localhost:8001/ui/";'));
  assert.ok(dashboard.includes('const TERMINAL_NAME = "Kubernetes Dashboard";'));
  assert.ok(dashboard.includes("name.startsWith('aks-')"));
  assert.ok(dashboard.includes('roleLabel === "agent"'));
  assert.ok(dashboard.includes('"get pod -n kube-system -l k8s-app=kubernetes-dashboard -o json"'));
  assert.ok(dashboard.includes('livenessProbe!.httpGet'));
  assert.ok(dashboard.includes("kubectl.invokeInNewTerminal('proxy', TERMINAL_NAME, onClosedTerminal, `tee ${PROXY_OUTPUT_FILE}`)"));
  assert.ok(extension.includes("registerCommand('extension.vsKubernetesDashboard'"));
});
test('the shared protocol keeps the upstream projections verbatim with the deviations disclosed', async () => {
  const protocol = await file('src/shared/dashboard-protocol.ts');
  for (const part of ["export const KUBE_DASHBOARD_URL = 'http://localhost:8001/ui/';", "export const TERMINAL_NAME = 'Kubernetes Dashboard';", "node.name.startsWith('aks-') && node.roleLabel === 'agent'", "export function findDashboardPodArguments()", "'k8s-app=kubernetes-dashboard'", 'export function projectDashboardPod(items: readonly unknown[])', 'NEVER writes a proxy.out/tee log', 'SERVER-SIDE EXECUTION IS']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for the dashboard', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('/v2/dashboard'));
  assert.ok(!bridge.includes('DashboardClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsKubernetesDashboard');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M5-E006');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/dashboard-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/dashboard-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/dashboard-wiring.test.ts'"));
});
