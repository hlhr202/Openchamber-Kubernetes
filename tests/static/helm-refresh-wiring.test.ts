// Text/metadata only. Never import or invoke the refresh runner/client/operations, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSourceText as file } from '../fixtures/static-source-text.ts';
test('pinned upstream explorer text proves refresh is one repo update plus tree invalidation', async () => {
  const explorer = await file('tests/fixtures/baseline/kubernetes/src/helm.repoExplorer.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(explorer.includes("await helm.helmExecAsync('repo update')") && explorer.includes('this.onDidChangeTreeDataEmitter.fire(undefined)'));
  assert.ok(extension.includes("registerCommand('extension.vsKubernetesRefreshHelmRepoExplorer'"));
});
test('pure projections live in shared: cache isolation, read-only config flag, fixed failure codes', async () => {
  const shared = await file('src/shared/helm-refresh-protocol.ts');
  for (const part of ['export function pluginCacheDirectory(home: string)', '/.openchamber-kubernetes/helm-cache', 'export function helmRefreshArguments(source: HelmRepositorySource, home: string)', '`--repository-config=${source.paths.repositoryFile}`', "`--repository-cache=${cache}`, 'repo', 'update'", 'export function refreshFailureCode(error: unknown)']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|node:path|writeFile/.test(shared));
});
test('the runner writes only the plugin-isolated cache and keeps partial results without rollback', async () => {
  const code = await file('src/service/adapters/helm-repo-refresh-cli.ts');
  for (const part of ['helmRefreshArguments(source, home)', 'mkdir(cache, { recursive: true })', "spawn('helm', [...args]", "from '../../shared/helm-refresh-protocol.ts'", 'SIGKILL', 'A non-zero exit keeps the already-written cache (partial update) without rollback or replay']) assert.ok(code.includes(part), part);
  assert.ok(!/writeFile|unlinkSync|rmSync|console\.|setInterval|--repository-config=/.test(code)); // config flag shaped only in shared
});
test('operations allow a single run with no queueing or retry and surface fixed codes', async () => {
  const code = await file('src/service/operations/helm-refresh.ts');
  for (const part of ["if (running) throw new BoundaryError('QUERY_LIMIT')", 'options.defaults()', 'refreshFailureCode(error)', 'helm-repo-refresh-unavailable']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|retry|console\.|writeFile|spawn/.test(code));
});
test('runtime authenticates the route; success only resets the repository view for the next read', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), bridge = await file('src/host/bridge.ts');
  const offset = http.indexOf("url.pathname === '/v2/helm/repo-refresh'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmRefreshes.handle(input, controller.signal)') && http.includes('options.helmRefreshes.close()'));
  assert.ok(main.includes('createHelmRefreshOperations({ run: createHelmRepoRefreshRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) })'));
  assert.ok(bridge.includes("if (state.phase === 'done') helmRepositories.reset()") && bridge.includes('helmRefreshes?.run()'));
});
test('the panel view is an explicit button disclosing cache isolation and no-rollback semantics', async () => {
  const view = await file('src/panel/helm-refresh-view.ts');
  for (const part of ['bridge()?.runHelmRepoRefresh()', 'plugin cache', 'without changing your Helm repository configuration', 'phaseLabel(state.phase, zh)']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(view));
});
test('automatic dependency graphs forbid the new write modules; readonly suites cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-refresh-values.test.ts');
  for (const part of ['helm-repo-refresh-cli', 'helm-refresh-client', 'helm-refresh-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:adapters\/helm-repo-refresh|operations\/helm-refresh|runtime\/|helm-refresh-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-refresh-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-refresh-wiring.test.ts'"));
});
