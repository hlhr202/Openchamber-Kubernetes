// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const source = (path: string) => readFile(new URL(`../../tests/fixtures/baseline/kubernetes/src/${path}.txt`, import.meta.url), 'utf8');
test('pinned upstream text proves the flow: AKS-only picker, sign-in gate, subscription, external delegation', async () => {
  const extension = await source('extension.ts'), aks = await source('components/cloudprovider/aksprovider.ts');
  assert.ok(extension.includes("registerCommand('extension.vsKubernetesCreateCluster', createClusterKubernetes)"));
  const select = extension.slice(extension.indexOf('async function selectProvider()'), extension.indexOf('async function createClusterKubernetes()'));
  assert.ok(select.includes('new AKSProvider(),'));
  assert.ok(select.includes('showQuickPick(providerNames, { placeHolder: "Select the cluster type" })'));
  assert.ok(select.includes("'Failed to get cluster type'"));
  assert.ok(select.includes("'Failed to get provider'"));
  assert.ok(select.includes('selectedProvider.isSignedIn()'));
  assert.ok(select.includes('selectedProvider.signIn()'));
  assert.ok(select.includes('Failed to sign in to ${selectedProvider.getName()}'));
  assert.ok(!select.includes('clusterProviderRegistry') && !select.includes('minikubeclusterprovider'));
  const command = extension.slice(extension.indexOf('async function createClusterKubernetes()'), extension.indexOf('const ADD_NEW_KUBECONFIG_PICK'));
  assert.ok(command.includes('showErrorMessage("Failed to get provider")'));
  assert.ok(command.includes('selectedProvider.result.prerequisites()'));
  assert.ok(command.includes('await selectedProvider.result.createCluster(subscriptionId)'));
  const create = aks.slice(aks.indexOf('async createCluster(inputs: any)'), aks.indexOf('// retrieves the list of AKS clusters'));
  assert.ok(create.includes('const aksExtensionId = "ms-kubernetes-tools.vscode-aks-tools";'));
  assert.ok(create.includes('The Azure Kubernetes Service extension is required to create a cluster. Do you want to install it?'));
  assert.ok(create.includes('"Install",'));
  assert.ok(create.includes('"Cancel"'));
  assert.ok(create.includes("if (install === \"Install\")"));
  assert.ok(create.includes("vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-kubernetes-tools.vscode-aks-tools')"));
  assert.ok(create.includes('waitForExtension(aksExtensionId)'));
  assert.ok(create.includes('vscode.commands.executeCommand("aks.createCluster", inputs)'));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const protocol = await file('src/shared/create-cluster-protocol.ts');
  for (const part of ["return 'Select the cluster type';", "return 'Failed to get cluster type';", "return 'Failed to get provider';", 'return `Failed to sign in to ${providerName}`;', "return 'ms-kubernetes-tools.vscode-aks-tools';", "return 'aks.createCluster';", "return 'The Azure Kubernetes Service extension is required to create a cluster. Do you want to install it?';", "INSTALL_BUTTON = 'Install'", "CANCEL_BUTTON = 'Cancel'", "return selection === 'Install';", 'SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED', 'never', 'impersonates a reachable creation chain', 'never installs VS Code extensions, fake', 'never called feasible', 'auto-recreated, resources deleted, or the account switched', 'No automated execution exists anywhere']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for cluster creation', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('create-cluster'));
  assert.ok(!bridge.includes('CreateClusterClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsKubernetesCreateCluster');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M7-E075');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/create-cluster-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/create-cluster-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/create-cluster-wiring.test.ts'"));
});
