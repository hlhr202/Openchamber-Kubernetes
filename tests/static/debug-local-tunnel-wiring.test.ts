// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const source = (path: string) => readFile(new URL(`../../tests/fixtures/baseline/kubernetes/src/${path}.txt`, import.meta.url), 'utf8');
test('pinned upstream text proves the flow: configured-or-first-sorted provider, void start, explicit missing prompts', async () => {
  const extension = await source('extension.ts'), debugger_ = await source('components/localtunneldebugger/localtunneldebugger.ts'), provider = await source('components/localtunneldebugger/localtunneldebugprovider.extension.ts'), api = await source('api/implementation/localtunneldebugger/v1.ts');
  assert.ok(extension.includes("registerCommand('extension.vsKubernetesDebugLocalTunnel', (target?: any) => { localTunnelDebugger.startLocalTunnelDebugSession(target); })"));
  assert.ok(debugger_.includes('const providerSetting: string | undefined = getLocalTunnelDebugProvider();'));
  assert.ok(debugger_.includes('const providerName: string | undefined = providerSetting ? providerSetting : this.providers.map((p) => p.id).sort()[0];'));
  assert.ok(debugger_.includes('this.providers.find((p) => p.id === providerName)'));
  assert.ok(debugger_.includes('providerToUse.startLocalTunnelDebugging(target);'));
  assert.ok(debugger_.includes("You have configured VSCode to use Local Tunnel debugger '${providerName}', but it is not installed.`"));
  assert.ok(debugger_.includes("'You do not have a Local Tunnel Debug Provider installed.'"));
  assert.ok(debugger_.includes('console.log(`Registered local tunnel debugger type ${provider.id}`)'));
  assert.ok(provider.includes('export interface LocalTunnelDebugProvider {'));
  assert.ok(provider.includes('startLocalTunnelDebugging(target?: any): void;'));
  assert.ok(api.includes('registerLocalTunnelDebugProvider(localTunnelDebugProvider: LocalTunnelDebuggerV1.LocalTunnelDebugProvider): void {'));
  assert.ok(api.includes('this.localDebugger.register(localTunnelDebugProvider);'));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const protocol = await file('src/shared/debug-local-tunnel-protocol.ts');
  for (const part of ['return providerSetting ? providerSetting : [...providerIds].sort()[0];', "return `You have configured VSCode to use Local Tunnel debugger '${providerName}', but it is not installed.`;", "return 'You do not have a Local Tunnel Debug Provider installed.';", 'return `Registered local tunnel debugger type ${id}`;', 'return providers.find((p) => p.id === providerName);', 'SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED', 'a REAL Telepresence provider must run the session in', 'void dispatch is never treated as a complete run', 'never', 'silently switching providers, installing, or starting', 'an unconfirmed forward of an arbitrary', 'never happens', 'a cancellation is not a traffic restoration', 'never runs the business cleanup', 'No automated execution exists anywhere']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for local tunnel debugging', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('local-tunnel'));
  assert.ok(!bridge.includes('LocalTunnelDebugClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsKubernetesDebugLocalTunnel');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M7-E075');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/debug-local-tunnel-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/debug-local-tunnel-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/debug-local-tunnel-wiring.test.ts'"));
});
