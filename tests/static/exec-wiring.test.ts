// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the exec path: no default, shared terminal, missing namespace', async () => {
  const extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt'), kubectl = await file('tests/fixtures/baseline/kubernetes/src/kubectl.ts.txt');
  assert.ok(extension.includes('async function execKubernetesCore(isTerminal: boolean): Promise<void>'));
  assert.ok(extension.includes("{ prompt: 'Please provide a command to execute' }"));
  assert.ok(extension.includes('if (isTerminal) {'));
  assert.ok(extension.includes("opts.value = 'bash';"));
  assert.ok(extension.includes('const execCmd = `exec ${pod.metadata.name} -c ${container.name} -- ${cmd}`'));
  assert.ok(extension.includes('kubectl.invokeInSharedTerminal(execCmd)'));
  assert.ok(kubectl.includes('const kubectlCommand = `kubectl ${command}`'));
});
test('the shared protocol keeps the upstream projections verbatim with the namespace fix disclosed', async () => {
  const protocol = await file('src/shared/exec-protocol.ts');
  for (const part of ["export function execArguments(pod: string, namespace: string, container: string, command: string)", "'exec', pod, '--namespace', namespace, '-c', container, '--', command", 'export function sharedTerminalCommand(command: readonly string[])', '`kubectl ${command.join(\' \')}`', 'export function execPromptDefault(isTerminal: boolean)', 'return isTerminal ? \'bash\' : undefined;', 'DISCLOSED FIX', 'OMITS the namespace', 'SERVER-SIDE EXECUTION IS']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for exec', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('/v2/exec'));
  assert.ok(!bridge.includes('ExecClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsKubernetesExec');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M5-E006');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/exec-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/exec-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/exec-wiring.test.ts'"));
});
