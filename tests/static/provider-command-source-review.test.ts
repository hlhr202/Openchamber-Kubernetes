// Frozen public source TEXT only. No provider/SDK/CLI/operations imports or execution, even for failure/cancel.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = (path: string) => readFile(new URL(`../../tests/fixtures/baseline/kubernetes/src/${path}.txt`, import.meta.url), 'utf8');
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (text: string, ...needles: string[]) => { let offset = -1; for (const needle of needles) { offset = text.indexOf(needle, offset + 1); assert.ok(offset >= 0, needle); } };

test('ten Run/provider/import/Minikube reviews bind actual registrations without runtime claims', async () => {
  const extension = await source('extension.ts');
  const coverage = JSON.parse(await file('docs/baseline/command-coverage.json')) as { entries: { commandId: string; evidence?: string; runtimeEvidence: unknown[] }[] };
  const entries = coverage.entries.filter(entry => entry.evidence === 'M1-E056'); assert.equal(entries.length, 10);
  for (const entry of entries) {
    assert.ok(extension.includes(`registerCommand('${entry.commandId}'`));
    assert.deepEqual(entry.runtimeEvidence, []);
  }
});
test('Run derives original project name/tag/user and builds then pushes before the actual kubectl run callback', async () => {
  const extension = await source('extension.ts'), run = extension.slice(extension.indexOf('function runKubernetes()'), extension.indexOf('export function tryFindKindNameFromEditor'));
  ordered(run, 'buildPushThenExec(async (name, image)', 'run ${name} --image=${image}');
  ordered(run, 'const buildResult = await shell.exec(await getBuildCommand(image))', 'buildResult.code === 0', 'const pushResult = await shell.exec(await getPushCommand(image))', 'pushResult.code === 0', 'fn(name, image)');
  const names = extension.slice(extension.indexOf('function findNameAndImageInternal'), extension.indexOf('function scaleKubernetes'));
  for (const needle of ['vscode.workspace.rootPath', 'docker.sanitiseTag(folderName)', 'findVersion()', 'vsdocker.imageUser', 'fn(name.trim(), image.trim())']) assert.ok(names.includes(needle));
});
test('Run image tools are Docker build versus Buildah bud with push, not an arbitrary shell adapter or implicit install permission', async () => {
  const registry = await source('image/imageToolRegistry.ts');
  for (const needle of ['Docker:', 'Buildah:', 'build -t ${image} .', 'bud -t ${image} .', 'push ${image}', 'Could not find ${buildTool.binName} binary']) assert.ok(registry.includes(needle));
});
test('reachable Create/Add paths instantiate only AKS, not the old Azure/Minikube wizard registry', async () => {
  const extension = await source('extension.ts'), select = extension.slice(extension.indexOf('async function selectProvider()'), extension.indexOf('const ADD_NEW_KUBECONFIG_PICK'));
  ordered(select, 'new AKSProvider()', 'selectedProvider.isSignedIn()', 'selectedProvider.signIn()');
  assert.ok(select.includes('provider.result.prerequisites()') && select.includes('provider.result.selectCluster(subscriptionId)') && select.includes('mergeToKubeconfig(kconfig)') && select.includes('selectedProvider.result.createCluster(subscriptionId)'));
  assert.ok(!select.includes('clusterProviderRegistry') && !select.includes('wizard') && !select.includes('minikubeclusterprovider'));
});
test('AKS subscription/cluster/credentials accesses can sign in and use authenticated Resource Graph POST, not automatic safe reads', async () => {
  const aks = await source('components/cloudprovider/aksprovider.ts');
  for (const needle of ['this.provider.getSubscriptions()', 'subscription.name', 'subscriptionId', 'createIfNone: true', 'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01', 'method: "POST"', 'Authorization: `Bearer ${token}`', 'listClusterUserCredentials(resourceGroup, clusterName)', 'Buffer.from(kubeconfigBase64).toString("utf8")']) assert.ok(aks.includes(needle));
});
test('AKS Create delegates to an external extension command and can install it upstream, which cannot be copied into official plugin integration', async () => {
  const aks = await source('components/cloudprovider/aksprovider.ts'), create = aks.slice(aks.indexOf('async createCluster('), aks.indexOf('// retrieves the list of AKS clusters'));
  for (const needle of ['ms-kubernetes-tools.vscode-aks-tools', 'workbench.extensions.installExtension', 'waitForExtension(aksExtensionId)', '"aks.createCluster", inputs']) assert.ok(create.includes(needle));
});
test('provider merge uses contributed node text and first path/first stanzas with explicit duplicate decisions, preserving existing current-context', async () => {
  const extension = await source('extension.ts'), config = await source('components/kubectl/kubeconfig.ts');
  assert.ok(extension.includes("target.nodeType !== 'contributed'") && extension.includes('target.provider.getKubeconfigYaml(target.value)'));
  for (const needle of ['kubeconfigPath.hostPath.split(path.delimiter)[0]', 'newConfig.clusters?.[0]', "'Overwrite', 'Keep Both', 'Cancel'", "renameWithSuffix = choice === 'Keep Both'", 'ctx.cluster = newCluster.name', 'ctx.user = newUser.name', 'if (!kcfileExists && newContext)']) assert.ok(config.includes(needle));
  const manifest = JSON.parse(await file('tests/fixtures/baseline/kubernetes/package.json.txt')) as { contributes: { menus: { commandPalette: { command: string; when: string }[] } } };
  for (const command of ['kubernetes.cloudExplorer.mergeIntoKubeconfig', 'kubernetes.cloudExplorer.saveKubeconfig']) assert.equal(manifest.contributes.menus.commandPalette.find(item => item.command === command)?.when, 'true');
});
test('merge backup deletion then rename then write is non-atomic and Save obtains credentials before cancelable new-file-only dialog', async () => {
  const config = await source('components/kubectl/kubeconfig.ts'); ordered(config, "const backupFile = kcfile + '.vscode-k8s-tools-backup'", 'await fs.unlinkAsync(backupFile)', 'await fs.renameAsync(kcfile, backupFile)', 'await fs.writeTextFile(kcfile, merged)');
  const extension = await source('extension.ts'), save = extension.slice(extension.indexOf('async function kubernetesSaveKubeconfig'), extension.indexOf('async function kubeconfigFromTreeNode'));
  ordered(save, 'await kubeconfigFromTreeNode(target)', 'await vscode.window.showSaveDialog', "kubeconfigFile.scheme !== 'file'", 'await fs.existsAsync(kcfile)', "showErrorMessage('File already exists')", 'await fs.writeTextFile');
  assert.ok(!save.includes('setActiveKubeconfig') && !save.includes('mergeToKubeconfig') && !save.includes('setKnownKubeconfigs'));
});
test('Local Tunnel selects configured or sorted provider and directly forwards target, with explicit missing-provider discovery only', async () => {
  const tunnel = await source('components/localtunneldebugger/localtunneldebugger.ts'), api = await source('api/implementation/localtunneldebugger/v1.ts');
  ordered(tunnel, 'getLocalTunnelDebugProvider()', 'this.providers.map((p) => p.id).sort()[0]', 'this.providers.find((p) => p.id === providerName)', 'providerToUse.startLocalTunnelDebugging(target)');
  assert.ok(tunnel.includes('selection === browseExtensions') && api.includes('this.localDebugger.register(localTunnelDebugProvider)'));
  assert.ok(!tunnel.includes('telepresence') && !tunnel.includes('await providerToUse') && !tunnel.includes('stopLocalTunnel'));
  const extension = await source('extension.ts'); assert.ok(extension.includes('searchMarketplace("kubernetes-extension-local-tunnel-debug-provider")'));
});
test('Minikube registered Start/Stop ignore selected profile and use a status read before actual non-awaited lifecycle, not create/delete wizard', async () => {
  const extension = await source('extension.ts'), mini = await source('components/clusterprovider/minikube/minikube.ts');
  assert.ok(extension.includes("registerCommand('extension.vsMinikubeStart', () => minikube.start({} as MinikubeOptions))") && extension.includes("registerCommand('extension.vsMinikubeStop', () => minikube.stop())"));
  const start = mini.slice(mini.indexOf('async function startMinikube'), mini.indexOf('async function stopMinikube'));
  ordered(start, 'checkPresent(context, CheckPresentMode.Alert)', 'await minikubeStatus(context)', 'status.running', '${flags} start`');
  const stop = mini.slice(mini.indexOf('async function stopMinikube'), mini.indexOf('async function minikubeStatus'));
  ordered(stop, 'checkPresent(context, CheckPresentMode.Alert)', 'await minikubeStatus(context)', '!status.running', 'stop`).then'); assert.ok(!stop.includes('delete'));
});
test('Minikube Status weak host-line parsing and upstream installer/update-check paths remain explicit unapproved dependencies', async () => {
  const mini = await source('components/clusterprovider/minikube/minikube.ts'), bin = await source('binutil.ts');
  const status = mini.slice(mini.indexOf('async function minikubeStatus'), mini.indexOf('async function checkPresent'));
  for (const needle of ['CheckPresentMode.Silent', '"${context.binPath}" status', 'result.stderr.length === 0', "status.includes('host')", "running: 'stopped' !== hostStatus"]) assert.ok(status.includes(needle));
  assert.ok(!status.includes('result.code') && mini.includes('update-check') && mini.includes('installMinikube(context.shell') && bin.includes('installDependencies()'));
});
