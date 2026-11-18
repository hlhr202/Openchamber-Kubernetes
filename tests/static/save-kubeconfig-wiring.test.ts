// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the flow: credentials first, empty dialog, non-file and exists gates, new-file-only write', async () => {
  const extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(extension.includes("registerCommand('kubernetes.cloudExplorer.saveKubeconfig', kubernetesSaveKubeconfig)"));
  const save = extension.slice(extension.indexOf('async function kubernetesSaveKubeconfig'), extension.indexOf('async function kubeconfigFromTreeNode'));
  assert.ok(save.includes('await kubeconfigFromTreeNode(target)'));
  assert.ok(save.includes('vscode.window.showSaveDialog({})'));
  assert.ok(save.includes("if (!kubeconfigFile)"));
  assert.ok(save.includes("kubeconfigFile.scheme !== 'file'"));
  assert.ok(save.includes("'Can only save to the file system'"));
  assert.ok(save.includes('await fs.existsAsync(kcfile)'));
  assert.ok(save.includes("'File already exists'"));
  assert.ok(save.includes('await fs.writeTextFile(kubeconfigFile.fsPath, newConfigText)'));
  assert.ok(save.includes('Configuration saved to ${kcfile}'));
  assert.ok(!save.includes('setActiveKubeconfig') && !save.includes('mergeToKubeconfig') && !save.includes('setKnownKubeconfigs'));
  const providerLeg = extension.slice(extension.indexOf('async function kubeconfigFromTreeNode'), extension.indexOf('async function showInfoMessage'));
  assert.ok(providerLeg.includes("target.nodeType !== 'contributed'"));
  assert.ok(providerLeg.includes("'This command requires a cluster to be selected in Cloud Explorer'"));
  assert.ok(providerLeg.includes('target.provider.getKubeconfigYaml(target.value)'));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const protocol = await file('src/shared/save-kubeconfig-protocol.ts');
  for (const part of ["return 'This command requires a cluster to be selected in Cloud Explorer'", "return 'Can only save to the file system';", "return 'File already exists';", 'return `Configuration saved to ${kcfile}`;', 'SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED', 'never auto-merged or set active/known', 'never claimed zero-side-effect', 'never becomes an exists-then-write race that overwrites', 'never enters the default DTO/URL/storage/log/chat', 'never auto-deleted or replayed', 'No automated execution exists anywhere']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for kubeconfig saving', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('save-kubeconfig'));
  assert.ok(!bridge.includes('SaveKubeconfigClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'kubernetes.cloudExplorer.saveKubeconfig');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M4-E030');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/save-kubeconfig-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/save-kubeconfig-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/save-kubeconfig-wiring.test.ts'"));
});
