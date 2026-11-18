// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the flow: fixed marketplace search, external open, gated prompt', async () => {
  const extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt'), local = await file('tests/fixtures/baseline/kubernetes/src/components/localtunneldebugger/localtunneldebugger.ts.txt');
  assert.ok(extension.includes("registerCommand('extension.vsKubernetesFindLocalTunnelDebugProviders', kubernetesFindLocalTunnelDebugProviders)"));
  const command = extension.slice(extension.indexOf('function kubernetesFindLocalTunnelDebugProviders()'), extension.indexOf('function searchMarketplace(') + 400);
  assert.ok(command.includes('searchMarketplace("kubernetes-extension-local-tunnel-debug-provider")'));
  assert.ok(command.includes('const searchUrl = `https://marketplace.visualstudio.com/search?term=${searchTerm}&target=VSCode&category=All%20categories&sortBy=Relevance`;'));
  assert.ok(command.includes('browser.open(searchUrl)'));
  assert.ok(local.includes("'You do not have a Local Tunnel Debug Provider installed.'"));
  assert.ok(local.includes('const browseExtensions = "Find Providers on Marketplace";'));
  assert.ok(local.includes('if (selection === browseExtensions)'));
  assert.ok(local.includes("vscode.commands.executeCommand('extension.vsKubernetesFindLocalTunnelDebugProviders')"));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const protocol = await file('src/shared/find-local-tunnel-providers-protocol.ts');
  for (const part of ["return 'kubernetes-extension-local-tunnel-debug-provider'", 'return `https://marketplace.visualstudio.com/search?term=${searchTerm}&target=VSCode&category=All%20categories&sortBy=Relevance`;', "return 'You do not have a Local Tunnel Debug Provider installed.'", "return 'Find Providers on Marketplace';", "return selection === 'Find Providers on Marketplace';", 'SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED', 'never an original debug target, path or credential', 'a dismissed prompt opens no page', 'never substitute for the real F5 chain', 'No automated execution exists anywhere']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no marketplace route, client or auto-open anywhere', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('marketplace'));
  assert.ok(!bridge.includes('FindLocalTunnelDebugProviders'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsKubernetesFindLocalTunnelDebugProviders');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M7-E075');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/find-local-tunnel-providers-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/find-local-tunnel-providers-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/find-local-tunnel-providers-wiring.test.ts'"));
});
