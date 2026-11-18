// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the stop flow: status gate, stop invocation, messages', async () => {
  const minikube = await file('tests/fixtures/baseline/kubernetes/src/components/clusterprovider/minikube/minikube.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(minikube.includes('async function stopMinikube(context: Context): Promise<void>'));
  assert.ok(minikube.includes('checkPresent(context, CheckPresentMode.Alert)'));
  assert.ok(minikube.includes("item.text = 'minikube-stopping';"));
  assert.ok(minikube.includes("'Minikube cluster is already stopped.'"));
  assert.ok(minikube.includes('context.shell.exec(`"${context.binPath}" stop`)'));
  assert.ok(minikube.includes("'Cluster stopped.'"));
  assert.ok(minikube.includes('Error stopping cluster ${result ? result.stderr : "Unable to run Minikube"}'));
  assert.ok(minikube.includes('Error stopping cluster: ${err}'));
  assert.ok(extension.includes("registerCommand('extension.vsMinikubeStop', () => minikube.stop())"));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const protocol = await file('src/shared/minikube-stop-protocol.ts');
  for (const part of ['export function minikubeStopArguments()', "return ['stop'];", 'export function alreadyStoppedMessage()', "'Minikube cluster is already stopped.'", 'export function stoppedMessage()', "'Cluster stopped.'", 'export function stopFailedMessage(stderr: string | undefined)', 'Error stopping cluster ${stderr ?? \'Unable to run Minikube\'}', 'export function stopThrewMessage(err: string)', 'Error stopping cluster: ${err}', "STOPPING_STATUS_TEXT = 'minikube-stopping'", 'SERVER-SIDE EXECUTION IS', 'never proves an unattended window', 'never terminated']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for minikube stop', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('/v2/minikube/stop'));
  assert.ok(!bridge.includes('MinikubeStopClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsMinikubeStop');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M7-E074');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/minikube-stop-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/minikube-stop-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/minikube-stop-wiring.test.ts'"));
});
