// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the start flow: status gate, flags, invocation, messages', async () => {
  const minikube = await file('tests/fixtures/baseline/kubernetes/src/components/clusterprovider/minikube/minikube.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(minikube.includes('async function startMinikube(context: Context, options: MinikubeOptions): Promise<void>'));
  assert.ok(minikube.includes('checkPresent(context, CheckPresentMode.Alert)'));
  assert.ok(minikube.includes("item.text = 'minikube-starting';"));
  assert.ok(minikube.includes("'Minikube cluster is already started.'"));
  assert.ok(minikube.includes("let flags = options.additionalFlags ? options.additionalFlags : '';"));
  assert.ok(minikube.includes('flags += ` --vm-driver=${options.vmDriver} `;'));
  assert.ok(minikube.includes('context.shell.exec(`"${context.binPath}" ${flags} start`)'));
  assert.ok(minikube.includes("'Cluster started.'"));
  assert.ok(minikube.includes("item.text = 'minikube-running';"));
  assert.ok(minikube.includes('Failed to start cluster ${result ? result.stderr : "Unable to run Minikube"}'));
  assert.ok(minikube.includes('Failed to start cluster: ${err}'));
  assert.ok(extension.includes("registerCommand('extension.vsMinikubeStart', () => minikube.start({} as MinikubeOptions))"));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const protocol = await file('src/shared/minikube-start-protocol.ts');
  for (const part of ['export function startFlags(additionalFlags: string | undefined, vmDriver: string | undefined)', "let flags = additionalFlags ? additionalFlags : '';", 'flags += ` --vm-driver=${vmDriver} `;', 'export function minikubeStartArguments(flags: string)', "'start']", 'export function alreadyStartedMessage()', "'Minikube cluster is already started.'", 'export function startedMessage()', "'Cluster started.'", 'export function startFailedMessage(stderr: string | undefined)', 'Failed to start cluster ${stderr ?? \'Unable to run Minikube\'}', 'export function startThrewMessage(err: string)', 'Failed to start cluster: ${err}', "STARTING_STATUS_TEXT = 'minikube-starting'", "RUNNING_STATUS_TEXT = 'minikube-running'", 'SERVER-SIDE EXECUTION IS', 'no install dependencies']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for minikube start', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('/v2/minikube/start'));
  assert.ok(!bridge.includes('MinikubeStartClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsMinikubeStart');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M7-E074');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/minikube-start-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/minikube-start-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/minikube-start-wiring.test.ts'"));
});
