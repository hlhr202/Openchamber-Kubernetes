// Fixed public text only. Never import upstream or plugin session/provider/control code.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const root = new URL('../../', import.meta.url);
const source = (path: string) => readFile(new URL(`tests/fixtures/baseline/kubernetes/src/${path}.txt`, root), 'utf8');
const local = (path: string) => readFile(new URL(path, root), 'utf8');

test('Terminal tree shell suggestion is real Exec while picker command precedes Pod/container selection', async () => {
  const extension = await source('extension.ts'), shell = await source('utils/container-shell.ts');
  const terminal = extension.slice(extension.indexOf('async function terminalKubernetes('), extension.indexOf('async function syncKubernetes('));
  assert.ok(terminal.includes('suggestedShellForContainer(kubectl') && terminal.includes("['exec', '-it', podName]"));
  assert.ok(terminal.indexOf('showInputBox(opts)') < terminal.indexOf('selectPod(PodSelectionScope.App, PodSelectionFallback.AnyPod)'));
  assert.ok(shell.includes('-- ls -la /bin/bash') && shell.includes("return 'sh'"));
  const exec = terminal.slice(terminal.indexOf('const execCmd ='), terminal.indexOf('function execTerminalOnContainer('));
  assert.ok(exec.includes('exec ${pod.metadata.name} -c ${container.name} -- ${cmd}') && !exec.includes('--namespace'));
});
test('Forward preserves source resource kinds, Service port rather than targetPort and permissive upstream numeric grammar', async () => {
  const forward = await source('components/kubectl/port-forward.ts');
  assert.ok(forward.includes('resourceNode.kind.apiName') && forward.includes('resourceNode.namespace || await kubectlUtils.currentNamespace'));
  const service = forward.slice(forward.indexOf('function extractServicePorts('), forward.indexOf('function extractDeploymentPorts('));
  assert.ok(service.includes('port: k8sport.port') && !service.includes('targetPort:'));
  assert.ok(forward.includes('0 < Number(port) && Number(port) <= MAX_PORT_COUNT') && !forward.includes('Number.isInteger'));
  assert.ok(forward.includes("['', '0'].includes(port)") && forward.includes('localPort: undefined'));
});
test('ordinary Forward emits success before terminal launch and never registers its status-bar session', async () => {
  const forward = await source('components/kubectl/port-forward.ts');
  const launch = forward.slice(forward.indexOf('async function portForwardToResource('));
  assert.ok(launch.indexOf('host.showInformationMessage') < launch.indexOf('kubectl.invokeInNewTerminal'));
  assert.ok(launch.includes('Promise.all(portMapping.map(buildUsablePortPair))') && launch.includes('port: 10000'));
  assert.ok(!forward.includes('registerPortForward(') && !forward.includes('await kubectl.invokeInNewTerminal'));
});
test('showSessions has a separate Stop confirmation and API registration is conditional, not generic tree Forward', async () => {
  const ui = await source('components/kubectl/port-forward-ui.ts'), api = await source('api/implementation/kubectl/v1.ts');
  assert.ok(ui.includes("const stopForwarding = 'Stop Forwarding'") && ui.includes('chosen.session.terminator.dispose()'));
  assert.ok(ui.includes('PFSESSIONKEY/${session.podName}/${session.podNamespace') && !ui.includes('contextName'));
  assert.ok(api.includes("options.showInUI.location === 'status-bar'") && api.includes('registerPortForward(session)'));
  assert.ok(api.includes('pfProcess.kill()') && api.includes('unregisterPortForward(cookie)'));
});
test('Dashboard source is proxy/file/browser or AKS Pod forwarding, not Cluster Info and not a working terminal reuse proof', async () => {
  const dashboard = await source('components/kubectl/dashboard.ts');
  assert.ok(dashboard.includes('http://localhost:8001/ui/') && dashboard.includes("resolve(__dirname, 'proxy.out')"));
  assert.ok(dashboard.includes("invokeInNewTerminal('proxy'") && dashboard.includes('`tee ${PROXY_OUTPUT_FILE}`'));
  assert.ok(dashboard.includes('items[0].spec.containers[0].livenessProbe!') && dashboard.includes('}, 2500)'));
  assert.equal([...dashboard.matchAll(/\bterminal\s*=/g)].length, 1); // Only close assignment; declaration has a type annotation.
  assert.ok(!dashboard.includes('terminal = await'));
});
test('Debug Launch retains reachable legacy node branch and provider callbacks can delete or persist Always Clean Up', async () => {
  const extension = await source('extension.ts'), debug = await source('debug/debugSession.ts'), registry = await source('debug/providerRegistry.ts');
  const entry = extension.slice(extension.indexOf('const debugKubernetes ='), extension.indexOf('const debugAttachKubernetes ='));
  assert.ok(entry.includes('["node"]') && entry.includes('buildPushThenExec(debugInternal)'));
  for (const provider of ['DotNet', 'Go', 'Java', 'Nodejs', 'Python']) assert.ok(registry.includes(`new ${provider}DebugProvider()`));
  assert.ok(debug.includes('await this.promptForCleanup(`deployment/${appName}`)') && debug.includes('await config.setAlwaysCleanUp()'));
  assert.ok(debug.includes('proxyResult.proxyProcess.kill()') && debug.includes('debugSession.name === sessionName'));
});
test('Attach probes processes and Node signal, while final .NET pipe drops namespace/container despite selection', async () => {
  const debug = await source('debug/debugSession.ts'), utils = await source('debug/debugUtils.ts'), node = await source('debug/nodejsDebugProvider.ts'), dotnet = await source('debug/dotNetDebugProvider.ts');
  assert.ok(debug.includes('resource.spec.containers') && debug.includes('getProcesses(this.kubectl, targetPod, targetPodNS, targetContainer)'));
  assert.ok(utils.includes('-- ps -o pid,command -e -w -w') && node.includes('kill -s USR1 1'));
  assert.ok(dotnet.includes('pipeArgs: [ "exec", "-i", pod, "--", "/bin/sh", "-c" ]'));
  assert.ok(dotnet.includes('name: ".NET Core Kubernetes Attach"') && dotnet.includes('return false;', dotnet.indexOf('public isPortRequired')));
  for (const file of ['dotNet', 'Go', 'Java', 'Python']) {
    const name = file[0]?.toLowerCase() + file.slice(1); const text = await source(`debug/${name}DebugProvider.ts`);
    assert.ok(text.includes('extensionUtils.installVscodeExtension('));
  }
});
test('Remove Debug uses fixed workspace name and nonawaited deletions; SelectPod is registered selection only', async () => {
  const extension = await source('extension.ts');
  const remove = extension.slice(extension.indexOf('function removeDebugKubernetes('), extension.indexOf('// There is a possible race condition'));
  assert.ok(remove.includes("name + '-debug'") && remove.includes("opt !== 'Delete'"));
  assert.ok(remove.includes("'delete service '") && remove.includes("'delete deployment '") && !remove.includes('await '));
  const picker = extension.slice(extension.indexOf('async function selectPodKubernetes('), extension.indexOf('const debugInternal ='));
  assert.ok(picker.includes('return selectedPod.name') && !picker.includes('startDebugging') && !picker.includes('exec '));
});
test('pure port grammar is allowlisted without session control, OS/SDK/network/allocator or implicit wiring', async () => {
  const grammar = await local('src/shared/port-mapping.ts'), tests = await local('tests/readonly/port-mapping.test.ts');
  assert.ok(!/from ['"].*(?:node:|service\/|host\/|sdk|portfinder)|fetch\(|spawn\(|listen\(|\.submit\(|\.prepare\(/.test(grammar));
  assert.ok(!/from ['"].*(?:node:(?:fs|net|http|child_process)|service\/|host\/|sdk|portfinder)|fetch\(|spawn\(|listen\(|\.submit\(|\.prepare\(/.test(tests));
  assert.ok(grammar.includes('Object.freeze') && grammar.includes('occupied.has(localPort)') && grammar.includes('previous !== item.port'));
  assert.ok((await local('scripts/readonly-tests.ts')).includes("'tests/readonly/port-mapping.test.ts'"));
  assert.ok(!(await local('src/host/bridge.ts')).includes('parsePortMappings') && !(await local('src/service/runtime/http.ts')).includes('parsePortMappings'));
});
