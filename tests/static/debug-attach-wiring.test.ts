// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const source = (path: string) => readFile(new URL(`../../tests/fixtures/baseline/kubernetes/src/${path}.txt`, import.meta.url), 'utf8');
test('pinned upstream text proves the flow: pod/container picks, process probe, port gate, forward, provider attach configs', async () => {
  const extension = await source('extension.ts'), session = await source('debug/debugSession.ts'), utils = await source('debug/debugUtils.ts'), node = await source('debug/nodejsDebugProvider.ts'), dotnet = await source('debug/dotNetDebugProvider.ts'), python = await source('debug/pythonDebugProvider.ts'), go = await source('debug/goDebugProvider.ts'), java = await source('debug/javaDebugProvider.ts');
  assert.ok(extension.includes("registerCommand('extension.vsKubernetesDebugAttach', debugAttachKubernetes)"));
  const attach = extension.slice(extension.indexOf('const debugAttachKubernetes ='), extension.indexOf('async function selectPodKubernetes'));
  assert.ok(attach.includes('new DebugSession(kubectl).attach(workspaceFolder, explorerNode ? explorerNode.name : undefined, explorerNode ? explorerNode.namespace || undefined : undefined)'));
  const sessionAttach = session.slice(session.indexOf('async attach('), session.indexOf('private async startDebugging('));
  assert.ok(sessionAttach.includes('placeHolder: `Please select a pod to attach`'));
  assert.ok(sessionAttach.includes('placeHolder: "Please select a container to attach"'));
  assert.ok(sessionAttach.includes('getProcesses(this.kubectl, targetPod, targetPodNS, targetContainer)'));
  assert.ok(sessionAttach.includes('filterSupportedProcesses(processes)'));
  assert.ok(sessionAttach.includes('supportedProcesses && supportedProcesses.length === 1 ? +supportedProcesses[0].pid : undefined'));
  assert.ok(sessionAttach.includes('resolvePortsFromContainer(this.kubectl, targetPod, targetPodNS, targetContainer)'));
  assert.ok(sessionAttach.includes('Cannot resolve the debug port to attach. See the documentation for how to use this command.'));
  assert.ok(sessionAttach.includes('message: "Setting up port forwarding..."'));
  assert.ok(sessionAttach.includes('message: `Starting ${this.debugProvider!.getDebuggerType()} debug session...`'));
  assert.ok(sessionAttach.includes('To learn more about the usage of the debug feature'));
  assert.ok(utils.includes('`exec ${pod} ${nsarg} ${containerCommand} -- ps -o pid,command -e -w -w`'));
  assert.ok(node.includes('config.getNodejsDebugPort() || 9229'));
  assert.ok(node.includes('kill -s USR1 1'));
  assert.ok(node.includes('SIGUSR1'));
  assert.ok(dotnet.includes('request: "attach"'));
  assert.ok(dotnet.includes('debug attach failed for pod ${pod}.'));
  assert.ok(dotnet.includes('master/debug-on-kubernetes.md for troubleshooting.'));
  assert.ok(python.includes('type: "debugpy"'));
  assert.ok(go.includes('type: "go"'));
  assert.ok(go.includes('placeHolder: "/go/src/"'));
  assert.ok(java.includes('type: "java"'));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const protocol = await file('src/shared/debug-attach-protocol.ts');
  for (const part of ["return 'Please select a pod to attach';", "return 'Please select a container to attach';", "return 'Setting up port forwarding...';", 'return `Starting ${debuggerType} debug session...`;', "return 'Cannot resolve the debug port to attach. See the documentation for how to use this command.';", 'return `\\nTo learn more about the usage of the debug feature, take a look at ${url}`;', 'return `exec ${pod} ${nsarg} ${containerCommand} -- ps -o pid,command -e -w -w`;', 'processes && processes.length === 1 ? +processes[0]!.pid : undefined', 'NODE_DEFAULT_DEBUG_PORT = 9229', 'return `exec ${pod} ${nsarg} ${containerCommand} -- ${shell} -c "kill -s USR1 1"`;', "type: 'debugpy', request: 'attach', port", "type: 'go', request: 'attach', port", "return '/go/src/';", "type: 'java', request: 'attach', port", "return 'attach';", 'debug attach failed for pod ${pod}.', "DOTNET_FAILED_CHANNEL_TITLE = 'Failed to attach'", 'SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED', 'forwarding alone is never the', 'probes are not automatic reads either', 'never silently installed', 'is reported on its own', 'already sent is never claimed undone', 'fixing the .NET omission and the name-matched cleanup', 'attaches to a same-name new pod and never takes over across views', 'No automated execution', 'exists anywhere.']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for debug attach', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('debug-attach'));
  assert.ok(!bridge.includes('DebugAttachClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsKubernetesDebugAttach');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M7-E074');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/debug-attach-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/debug-attach-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/debug-attach-wiring.test.ts'"));
});
