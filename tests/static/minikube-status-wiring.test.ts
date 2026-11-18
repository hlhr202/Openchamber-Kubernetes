// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the status flow: silent check, quoted invocation, host-line projection', async () => {
  const minikube = await file('tests/fixtures/baseline/kubernetes/src/components/clusterprovider/minikube/minikube.ts.txt'), binutil = await file('tests/fixtures/baseline/kubernetes/src/binutil.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(minikube.includes('async function minikubeStatus(context: Context): Promise<MinikubeInfo>'));
  assert.ok(minikube.includes('checkPresent(context, CheckPresentMode.Silent)'));
  assert.ok(minikube.includes(`throw new Error('Minikube executable could not be found!');`));
  assert.ok(minikube.includes('context.shell.exec(`"${context.binPath}" status`)'));
  assert.ok(minikube.includes("find((status) => status.includes('host'))"));
  assert.ok(minikube.includes('Failed to get host status: Unable to run Minikube'));
  assert.ok(minikube.includes("hostItem.split(': ')[1].toLowerCase()"));
  assert.ok(minikube.includes(`'stopped' !== hostStatus`));
  assert.ok(minikube.includes('Failed to get status: ${result ? result.stderr : "Unable to run Minikube"}'));
  assert.ok(binutil.includes('export async function checkForBinary(context: BinCheckContext'));
  assert.ok(extension.includes("registerCommand('extension.vsMinikubeStatus'"));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const protocol = await file('src/shared/minikube-status-protocol.ts');
  for (const part of ['export function minikubeStatusArguments()', "return ['status'];", 'export function minikubeNotFoundMessage()', "'Minikube executable could not be found!'", 'export function hostStatusMissingMessage()', 'Failed to get host status: Unable to run Minikube', 'export function statusFailedMessage(stderr: string | undefined)', 'Failed to get status: ${stderr ?? \'Unable to run Minikube\'}', 'export function projectHostLine(stdout: string)', "find(status => status.includes('host'))", "state.toLowerCase() !== 'stopped'", 'SERVER-SIDE EXECUTION IS', 'never authorizes environment stop/recreate']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for minikube status', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('/v2/minikube/status'));
  assert.ok(!bridge.includes('MinikubeStatusClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsMinikubeStatus');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M7-E074');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/minikube-status-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/minikube-status-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/minikube-status-wiring.test.ts'"));
});
