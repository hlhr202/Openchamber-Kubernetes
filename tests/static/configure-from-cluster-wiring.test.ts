// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const source = (path: string) => readFile(new URL(`../../tests/fixtures/baseline/kubernetes/src/${path}.txt`, import.meta.url), 'utf8');
test('pinned upstream text proves the flow: provider gate, subscription pick, cluster leg, kubeconfig, merge call', async () => {
  const extension = await source('extension.ts'), aks = await source('components/cloudprovider/aksprovider.ts');
  assert.ok(extension.includes("registerCommand('extension.vsKubernetesConfigureFromCluster', configureFromClusterKubernetes)"));
  const command = extension.slice(extension.indexOf('async function configureFromClusterKubernetes()'), extension.indexOf('// creates a new cluster using aks extension'));
  assert.ok(command.includes('vscode.window.showErrorMessage(provider.error[0])'));
  assert.ok(command.includes('provider.result.prerequisites()'));
  assert.ok(command.includes('provider.result instanceof AKSProvider'));
  assert.ok(command.includes('provider.result.selectCluster(subscriptionId)'));
  assert.ok(command.includes('provider.result.getKubeconfigYaml(subscriptionId, cluster.resourceGroup, cluster.name)'));
  assert.ok(command.includes('mergeToKubeconfig(kconfig)'));
  assert.ok(command.includes('"Failed to get kubeconfig"'));
  const prerequisites = aks.slice(aks.indexOf('async prerequisites()'), aks.indexOf('async selectCluster('));
  assert.ok(prerequisites.includes('longRunning("Getting Azure subscriptions"'));
  assert.ok(prerequisites.includes('Failed to get subscriptions for ${this.getName()}'));
  assert.ok(prerequisites.includes('placeHolder: "Select the subscription"'));
  assert.ok(prerequisites.includes('Failed to get subscription for ${this.getName()}'));
  assert.ok(prerequisites.includes('subscriptions.find((sub) => sub.name === selectedSubscription)?.subscriptionId'));
  for (const needle of ['You must be signed into Azure to list clusters.', 'Network error querying Resource Graph: ${e.message}', 'Resource Graph failed: ${resp.status} ${resp.statusText}', 'Failed to get credentials for AKS.', 'Failed to retrieve kubeconfig from AKS.', 'Error fetching kubeconfig: ${(err as any).message || String(err)}']) assert.ok(aks.includes(needle), needle);
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const protocol = await file('src/shared/configure-from-cluster-protocol.ts');
  for (const part of ["return 'Azure Kubernetes Service (AKS)';", "return 'Getting Azure subscriptions';", 'return `Failed to get subscriptions for ${name}`;', "return 'Select the subscription';", 'return `Failed to get subscription for ${name}`;', "return 'Failed to get kubeconfig';", "return 'You must be signed into Azure to list clusters.';", 'return `Network error querying Resource Graph: ${message}`;', 'return `Resource Graph failed: ${status} ${statusText}`;', "return 'Failed to get credentials for AKS.';", "return 'Failed to retrieve kubeconfig from AKS.';", 'return `Error fetching kubeconfig: ${message}`;', "return subscriptions.find((sub) => sub.name === selectedName)?.subscriptionId;", 'SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED', 'the old wizard entry is never used', 'not a zero-side-effect claim', 're-fetches credentials or replays the merge', 'never enter the panel or', 'logs; IDENTITY case', 'authorises anything', 'No automated execution exists anywhere']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for cluster configuration', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('configure-from-cluster'));
  assert.ok(!bridge.includes('ConfigureFromClusterClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsKubernetesConfigureFromCluster');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M7-E075');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/configure-from-cluster-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/configure-from-cluster-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/configure-from-cluster-wiring.test.ts'"));
});
