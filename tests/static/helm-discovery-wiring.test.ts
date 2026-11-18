// Text-only runtime/SDK/path audit. Never imports the runtime, real file adapter, SDK or write chain.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('fixed Helm path precedence and platform defaults are grounded in six additional public texts', async () => {
  const environment = await file('tests/fixtures/contracts/helm-contract/pkg/cli/environment.go.txt'), lazy = await file('tests/fixtures/contracts/helm-contract/pkg/helmpath/lazypath.go.txt'), darwin = await file('tests/fixtures/contracts/helm-contract/pkg/helmpath/lazypath_darwin.go.txt'), unix = await file('tests/fixtures/contracts/helm-contract/pkg/helmpath/lazypath_unix.go.txt');
  assert.ok(environment.includes('envOr("HELM_REPOSITORY_CONFIG", helmpath.ConfigPath("repositories.yaml"))') && environment.includes('envOr("HELM_REPOSITORY_CACHE", helmpath.CachePath("repository"))'));
  assert.ok(lazy.includes('base := os.Getenv(helmEnvVar)') && lazy.includes('base = os.Getenv(xdgEnvVar)') && darwin.includes('"Library", "Preferences"') && unix.includes('".cache"'));
});
test('official host forwards XDG but not HELM path overrides; implementation does not probe parent environment', async () => {
  const code = await file('tests/fixtures/baseline/openchamber/packages/web/server/lib/guests/service.js.txt'), start = code.indexOf('const INHERITED_SERVICE_ENV_NAMES'), end = code.indexOf('const inheritedServiceEnv', start), whitelist = code.slice(start, end);
  assert.ok(whitelist.includes('XDG_CONFIG_HOME') && whitelist.includes('XDG_CACHE_HOME') && !whitelist.includes('HELM_'));
  const runtime = await file('src/service/runtime/main.ts'); for (const name of ['HELM_REPOSITORY_CONFIG', 'HELM_REPOSITORY_CACHE', 'HELM_CONFIG_HOME', 'HELM_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) assert.ok(runtime.includes(`process.env.${name}`));
  assert.ok(!/Object\.entries\(process\.env\)|\.\.\.process\.env|process\.env\.HELM_KUBETOKEN|spawn\(|helm env/.test(runtime));
});
test('default discovery is pure/lazy and HMAC source partition includes resolved paths, not merely default mode', async () => {
  const discovery = await file('src/service/queries/helm-repository-discovery.ts'), reader = await file('src/service/queries/helm-repositories.ts');
  assert.ok(!/from ['"]node:(?:fs|child_process|os)|process\.env\.|fetch\(|spawn\(|writeFile|mkdir/.test(discovery));
  assert.ok(reader.includes('JSON.stringify(source)') && reader.includes('identity([request.binding, source.paths, config])') && reader.includes('resolvedSelection: source.paths, sourceOrigins: source.origins'));
});
test('independent health/read lifecycle shares four unsettled calls and rejects old connection revisions', async () => {
  const client = await file('src/host/helm-repository-client.ts'); assert.ok(client.includes('healthSchema.safeParse(value)') && client.includes('utf8ByteLength(response.body) > 4096') && client.includes('revision !== this.#revision'));
  assert.ok(client.includes('this.#calls >= 4') && client.includes('await this.#health()') && client.includes('serviceGeneration: health.data.serviceGeneration'));
});
test('bridge and UI no longer gate Helm on kubeconfig ready or reset it for an unrelated config failure', async () => {
  const bridge = await file('src/host/bridge.ts'), panel = await file('src/panel/main.ts'), ui = await file('src/panel/helm-repository-view.ts');
  assert.ok(bridge.includes("path: '/health'") && bridge.includes('helmRepositories.connect(selection, `${viewId}:${projectRevision}`)'));
  assert.ok(bridge.includes('helmRepositories.observeGeneration(state.config.serviceGeneration)'));
  assert.ok(!bridge.includes("state.phase !== 'ready') { helmRepositories.reset()") && !panel.includes('helmRepositories.available('));
  assert.ok(ui.includes("mode === 'default' ? { mode: 'default' }") && ui.includes('page.resolvedSelection.repositoryFile') && ui.includes('Specify paths if needed'));
});
test('default response schema is strict and all new synthetic tests are allowlisted without runtime imports', async () => {
  const protocol = await file('src/shared/helm-repository-protocol.ts'), tests = await file('tests/readonly/helm-repository-discovery.test.ts'), readonly = await file('scripts/readonly-tests.ts'), statics = await file('scripts/static-tests.ts');
  assert.ok(protocol.includes('resolvedSelection: helmRepositoryPathsSchema, sourceOrigins: helmRepositoryOriginsSchema'));
  assert.ok(readonly.includes("'tests/readonly/helm-repository-discovery.test.ts'") && statics.includes("'tests/static/helm-discovery-wiring.test.ts'"));
  assert.ok(!/from ['"].*(?:node:fs|adapters\/|operations\/|sessions\/|runtime\/|bridge|@openchamber)|spawn\(|fork\(/.test(tests));
});
