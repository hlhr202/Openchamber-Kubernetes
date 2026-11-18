// Text/metadata only. Never import or invoke the dependencies runner/client/operations, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSourceText as file } from '../fixtures/static-source-text.ts';
test('pinned upstream text proves dependencies is fetch-to-temp then dep list then parse', async () => {
  const exec = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt'), utils = await file('tests/fixtures/baseline/kubernetes/src/outputUtils.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt'), helm = await file('tests/fixtures/baseline/kubernetes/src/helm.ts.txt');
  assert.ok(exec.includes('export async function helmDependencies(') && exec.includes('helmDependenciesLaunchViewer'));
  assert.ok(exec.includes('tmp.dirSync({ prefix: "vsk-fetchfordeps-", unsafeCleanup: true })') && exec.includes('fetch ${chartId} ${versionArg} -d "${tempDirObj.name}"'));
  assert.ok(exec.includes('dep list "${chartPath}"') && exec.includes('parseLineOutput(lines, helm.HELM_OUTPUT_COLUMN_SEPARATOR)'));
  assert.ok(exec.includes('fs.unlinkSync(chartPath)') && exec.includes('tempDirObj.removeCallback()'));
  assert.ok(utils.includes('export function parseLineOutput(lineOutput: string[], columnSeparator: RegExp)') && utils.includes('const headers = lineOutput.shift();'));
  assert.ok(helm.includes('export const HELM_OUTPUT_COLUMN_SEPARATOR = /\\t+/g;'));
  assert.ok(extension.includes("registerCommand('extension.helmDependencies'"));
});
test('pure projections live in shared: isolation flags, upstream-literal dep list, bounded table', async () => {
  const shared = await file('src/shared/helm-dependencies-protocol.ts');
  for (const part of ["import { helmChartReference, helmChartVersion } from './helm-inspect-protocol.ts'", 'export function helmDependencyFetchArguments(chart: string', "'fetch', chart", "'-d', targetDirectory", "export function helmDependencyListArguments(chartPath: string): readonly string[] {\n  return ['dep', 'list', chartPath];", 'export function parseDependencyTable(stdout: string)', 'header-only table ⇒ rows: [] ⇒ the chart has no dependencies']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the runner fetches into the plugin-owned temp root and always cleans like the upstream finally', async () => {
  const code = await file('src/service/adapters/helm-dependencies-cli.ts');
  for (const part of ['pluginTempRoot(home)', 'mkdtemp(`${root}/vsk-fetchfordeps-`)', 'helmDependencyFetchArguments(input.chart, input.version, tempDirectory, input.source, home).args', 'helmDependencyListArguments(chartPath)', "'ignore', capture ? 'pipe' : 'ignore'", '16_384', 'unlink(chartPath)', 'rmdir(tempDirectory)', 'Upstream finally: unlink the archive, then remove the temp directory']) assert.ok(code.includes(part), part);
  assert.ok(!/unlinkSync|rmSync|console\.|setInterval|os\.tmpdir/.test(code));
});
test('operations are single-shot with a fixed deadline and parse via the shared pure projection', async () => {
  const code = await file('src/service/operations/helm-dependencies.ts'), main = await file('src/service/runtime/main.ts');
  for (const part of ["if (running) throw new BoundaryError('QUERY_LIMIT')", 'const deadlineMs = 30_000', 'parseDependencyTable(stdout)', 'dependenciesFailureCode(error)', 'helm-dependencies-unavailable']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|retry|console\.|writeFile|spawn/.test(code));
  assert.ok(main.includes('createHelmDependenciesOperations({ run: createHelmDependenciesRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) })'));
});
test('runtime authenticates the route and the response is always the bounded table pair', async () => {
  const http = await file('src/service/runtime/http.ts');
  const offset = http.indexOf("url.pathname === '/v2/helm/dependencies'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmDependencies.handle(input, controller.signal)') && http.includes('options.helmDependencies.close()'));
});
test('the panel view discloses the temp-fetch lifecycle and the empty-table meaning', async () => {
  const view = await file('src/panel/helm-dependencies-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['bridge()?.listHelmDependencies(chart.value.trim(), version.value.trim() || undefined)', 'chart.maxLength = 255', 'version.maxLength = 63', 'plugin temporary storage', 'workspace is unchanged', '(no dependencies)']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(view));
  assert.ok(bridge.includes('listHelmDependencies: (chart: string, version?: string)') && bridge.includes('closeHelmDependencies: () => helmDependencies?.reset()'));
});
test('automatic dependency graphs forbid the new write modules; readonly suites cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-dependencies-values.test.ts');
  for (const part of ['helm-dependencies-cli', 'helm-dependencies-client', 'helm-dependencies-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:adapters\/helm-dependencies|operations\/helm-dependencies|runtime\/|helm-dependencies-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-dependencies-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-dependencies-wiring.test.ts'"));
});
