// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the -it exec array, terminal name shape and bash probe', async () => {
  const extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt'), shell = await file('tests/fixtures/baseline/kubernetes/src/utils/container-shell.ts.txt');
  assert.ok(extension.includes('function terminalKubernetes(explorerNode?: ClusterExplorerResourceNode)'));
  assert.ok(extension.includes("const execCmd = `exec ${pod.metadata.name} -c ${container.name} -- ${cmd}`"));
  assert.ok(extension.includes("const terminalExecCmd: string[] = ['exec', '-it', podName];"));
  assert.ok(extension.includes("terminalExecCmd.push('--namespace', podNamespace);"));
  assert.ok(extension.includes("terminalExecCmd.push('--container', containerName);"));
  assert.ok(extension.includes("terminalExecCmd.push('--', terminalCmd);"));
  assert.ok(extension.includes('const terminalName = `${terminalCmd} on ${podName}` + (containerName ? `/${containerName}`: \'\');'));
  assert.ok(extension.includes("opts.value = 'bash';"));
  assert.ok(shell.includes('exec ${podName} ${nsarg} ${containerCommand} -- ls -la /bin/bash'));
  assert.ok(shell.includes("return 'sh';"));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const protocol = await file('src/shared/terminal-protocol.ts');
  for (const part of ["['exec', '-it', pod]", "'--namespace', namespace", "'--container', container", "'--', terminalCmd", 'export function terminalName(terminalCmd: string, pod: string, container: string | undefined)', "${terminalCmd} on ${pod}${container ? `/${container}` : ''}", "export function bashProbeArguments(pod: string, namespace: string | undefined, container: string | undefined)", "'ls', '-la', '/bin/bash'", "export function suggestedShell(bashPresent: boolean)", "return bashPresent ? 'bash' : 'sh';", 'SERVER-SIDE EXECUTION IS']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for the terminal', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('/v2/terminal'));
  assert.ok(!bridge.includes('TerminalClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsKubernetesTerminal');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M5-E006');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/terminal-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/terminal-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/terminal-wiring.test.ts'"));
});
