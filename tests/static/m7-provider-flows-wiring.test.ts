// Text/metadata only. Never import or invoke the provider-flow operation or its runners.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('the provider flows resolve LocalTunnel with the upstream-empty registry and fixed prompts', async () => {
  const flows = await file('src/service/operations/provider-flows.ts');
  for (const part of ['inScopeLocalTunnelProviders: readonly string[] = Object.freeze([])', "localTunnelConfiguredMissingMessage", "localTunnelNoneInstalledMessage", "You have configured VSCode to use Local Tunnel debugger", 'You do not have a Local Tunnel Debug Provider installed.', 'registry is fed by EXTERNAL extensions']) assert.ok(flows.includes(part), part);
  assert.ok(flows.includes('[...inScopeLocalTunnelProviders].sort()[0]')); // upstream resolution order
});
test('the template preview renders one file with a fresh proof and the upstream error branches', async () => {
  const flows = await file('src/service/operations/provider-flows.ts'), adapter = await file('src/service/adapters/helm-template-cli.ts');
  for (const part of ['chartDirectoryFor', 'relativeTemplateFor', "value.includes('/templates/')", 'skipsYamlValidation(relative)', 'analyseManifestBundle', 'upstream: no output', 'YAML failed to parse']) assert.ok(flows.includes(part), part);
  for (const part of ['--show-only', '--execute', 'previewBudget = 262_144', 'HelmTemplatePreviewRun']) assert.ok(adapter.includes(part), part);
});
test('the cluster provider list is the fixed in-scope set and configure feeds the explicit merge', async () => {
  const flows = await file('src/service/operations/provider-flows.ts'), bridge = await file('src/host/bridge.ts'), minikube = await file('src/service/adapters/minikube-cli.ts');
  assert.ok(flows.includes("inScopeClusterProviders = Object.freeze([{ id: 'minikube'"));
  assert.ok(flows.includes('minikube-config-view') && flows.includes('48_000'));
  assert.ok(flows.includes('EXPLICIT merge confirmation'));
  assert.ok(bridge.includes('openMarketplaceProviderSearch') && bridge.includes('marketplaceSearchUrl(marketplaceSearchTerm())') && bridge.includes('localTunnelStart') && bridge.includes('minikubeConfigView'));
  assert.ok(minikube.includes("['kubectl', '--', 'config', 'view']"));
});
test('runtime authenticates the provider-flows route and the panel exposes the four flows', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), view = await file('src/panel/cluster-view.ts');
  const offset = http.indexOf("url.pathname === '/v2/operations/provider-flows'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.providerFlows.handle(input, controller.signal)') && http.includes('options.providerFlows.close()'));
  assert.ok(main.includes('createProviderFlowOperations({ workspace, previewRun: createHelmTemplatePreviewRunner'));
  for (const part of ['localTunnelStart', 'openMarketplaceProviderSearch', 'clusterProviders(', 'minikubeConfigView()']) assert.ok(view.includes(part), part);
});
test('read paths stay clean and the suite is registered', async () => {
  const check = await file('scripts/check-static.ts');
  assert.ok(check.includes('operations|sessions|runtime')); // flows stay unreachable from read graphs
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/m7-provider-flows-wiring.test.ts'"));
});
test('the Telepresence traffic operations run one bounded CLI invocation per G4 confirmation', async () => {
  const adapter = await file('src/service/adapters/telepresence-cli.ts'), operations = await file('src/service/operations/cluster-operations.ts');
  for (const part of ["['status']", "['connect']", "['intercept', target, '--port', ports]", "['leave', target]", "['quit']", 'shell: false', 'process.kill(-child.pid']) assert.ok(adapter.includes(part), part);
  assert.ok(adapter.includes('agent injection'));
  for (const part of ["z.literal('telepresence-prepare')", "z.literal('telepresence-exact-traffic-operation')", "step: 'telepresence-traffic'", 'options.telepresence.connect(signal)', 'options.telepresence.intercept(parameters.workload, parameters.ports, signal)']) assert.ok(operations.includes(part), part);
  const main = await file('src/service/runtime/main.ts');
  assert.ok(main.includes('telepresence: createTelepresenceCliRunner(environment.path)'));
});
