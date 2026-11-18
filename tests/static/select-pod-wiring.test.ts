// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the selection flow: current-namespace read, gate message, label, pick, return', async () => {
  const extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(extension.includes("registerCommand('extension.vsKubernetesSelectPod', selectPodKubernetes)"));
  const picker = extension.slice(extension.indexOf('async function selectPodKubernetes('), extension.indexOf('const debugInternal ='));
  assert.ok(picker.includes('getResourceAsJson<KubernetesCollection<Pod>>(kubectl, "pods")'));
  assert.ok(picker.includes("'Unable to list any pods. No pod found in the current namespace.'"));
  assert.ok(picker.includes('label: `${pod.metadata.name} (on ${pod.spec.nodeName})`'));
  assert.ok(picker.includes('name: pod.metadata.name'));
  assert.ok(picker.includes('showQuickPick(podPickItems, { placeHolder: `Select a pod` })'));
  assert.ok(picker.includes('if (!selectedPod)'));
  assert.ok(picker.includes('return selectedPod.name'));
  assert.ok(!picker.includes('startDebugging') && !picker.includes('exec '));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const protocol = await file('src/shared/select-pod-protocol.ts');
  for (const part of ["return 'Unable to list any pods. No pod found in the current namespace.'", "return 'Select a pod'", 'export function podPickLabel(name: string, nodeName: string | undefined)', 'return `${name} (on ${nodeName})`;', 'export function podPickItems(pods: readonly { name: string; nodeName?: string }[])', 'label: podPickLabel(pod.name, pod.nodeName), name: pod.name', 'SERVER-SIDE EXECUTION IS', 'never reused for a later session without re-verifying its', 'never faked as an empty namespace', 'No automated execution exists anywhere']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for pod selection', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('select-pod'));
  assert.ok(!bridge.includes('SelectPodClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsKubernetesSelectPod');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M7-E074');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/select-pod-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/select-pod-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/select-pod-wiring.test.ts'"));
});
