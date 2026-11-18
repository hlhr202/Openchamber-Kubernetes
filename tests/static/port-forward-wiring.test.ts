// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the validation/build core and the port ceiling', async () => {
  const pf = await file('tests/fixtures/baseline/kubernetes/src/components/kubectl/port-forward.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(pf.includes('export async function portForwardKubernetes(kubectl: Kubectl, explorerNode?: any): Promise<void>'));
  assert.ok(pf.includes('const portPairs = portMapping.split(\' \');'));
  assert.ok(pf.includes('if (splitMapping.length > 2) {'));
  assert.ok(pf.includes(`Invalid ports. Please enter a valid port mapping ie: 8888:5000 or 5000. Valid port range:  1 – ${'${MAX_PORT_COUNT}'}`));
  assert.ok(pf.includes("if (portSpecifier === PortSpecifier.AllowEmpty && ['', '0'].includes(port))"));
  assert.ok(pf.includes('return 0 < Number(port) && Number(port) <= MAX_PORT_COUNT;'));
  assert.ok(pf.includes('export function buildPortMapping(portString: string, namedPorts: ExtractedPort[] = [])'));
  assert.ok(pf.includes('const MAX_PORT_COUNT = 65535;'));
  assert.ok(extension.includes("registerCommand('extension.vsKubernetesPortForward'"));
});
test('the shared protocol keeps the upstream projections verbatim with the deviations disclosed', async () => {
  const protocol = await file('src/shared/port-forward-protocol.ts');
  for (const part of ['export const MAX_PORT_COUNT = 65535;', 'export function isPortValid(', "portSpecifier === PortSpecifier.AllowEmpty && ['', '0'].includes(port)", 'return 0 < Number(port) && Number(port) <= MAX_PORT_COUNT;', 'export function validatePortPair(', 'Invalid port mapping: ${portPair}', 'Valid port range:  1 – ${MAX_PORT_COUNT}', 'export function buildPortMapping(portString: string, namedPorts: readonly ExtractedPort[] = [])', 'DISCLOSED', 'rejects duplicates explicitly', 'SERVER-SIDE EXECUTION IS', 'never claimed client-reachable']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for port-forward', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('/v2/port-forward'));
  assert.ok(!bridge.includes('PortForwardClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsKubernetesPortForward');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M5-E006');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/port-forward-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/port-forward-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/port-forward-wiring.test.ts'"));
});
