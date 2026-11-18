// Text/metadata only. Never import or invoke the values runner/client/operations, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSourceText as file } from '../fixtures/static-source-text.ts';
test('pinned upstream text proves fetch values is the generateFile branch of the same dispatcher', async () => {
  const exec = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt'), provider = await file('tests/fixtures/baseline/kubernetes/src/helm.documentProvider.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(exec.includes('export function helmFetchValues(arg: any)') && exec.includes('inspectionScheme: helm.FETCH_VALUES_SCHEME') && exec.includes('generateFile: true'));
  assert.ok(exec.includes('openHelmGeneratedValuesFile(uri)'));
  assert.ok(provider.includes('inspect values ${id} ${versionArg}') && provider.includes('query.generateFile'));
  assert.ok(extension.includes("registerCommand('extension.helmFetchValues'"));
});
test('pure projections live in shared and reuse the inspect token schemas, never copying them', async () => {
  const shared = await file('src/shared/helm-values-protocol.ts');
  for (const part of ["import { helmChartReference, helmChartVersion } from './helm-inspect-protocol.ts'", 'export function helmValuesArguments(chart: string, version: string | undefined', "`--repository-config=${source.paths.repositoryFile}`", "'inspect', 'values', chart", "chart, ...(version ? ['--version', version] : [])", 'export function valuesFailureCode(error: unknown)']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the runner pipes only bounded stdout and never writes any workspace file', async () => {
  const code = await file('src/service/adapters/helm-values-cli.ts');
  for (const part of ['helmValuesArguments(input.chart, input.version, input.source, home)', 'mkdir(cache, { recursive: true })', "spawn('helm', [...args]", "'ignore', 'pipe', 'ignore'", '16_384', 'SIGKILL', 'stderr is never retained', 'Nothing is written to any workspace']) assert.ok(code.includes(part), part);
  assert.ok(!/unlinkSync|rmSync|console\.|setInterval/.test(code));
});
test('operations are single-shot with a fixed deadline and no syntax probe (values has no scope)', async () => {
  const code = await file('src/service/operations/helm-values.ts'), main = await file('src/service/runtime/main.ts');
  for (const part of ["if (running) throw new BoundaryError('QUERY_LIMIT')", 'const deadlineMs = 30_000', 'options.defaults()', 'valuesFailureCode(error)', 'helm-values-fetch-unavailable']) assert.ok(code.includes(part), part);
  assert.ok(!/syntax|setInterval|retry|console\.|writeFile|spawn/.test(code));
  assert.ok(main.includes('createHelmValuesOperations({ run: createHelmValuesRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) })'));
});
test('runtime authenticates the route and the response never claims a saved path', async () => {
  const http = await file('src/service/runtime/http.ts');
  const offset = http.indexOf("url.pathname === '/v2/helm/fetch-values'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmValues.handle(input, controller.signal)') && http.includes('options.helmValues.close()'));
});
test('the panel view is an explicit bounded form that keeps the virtual-document/落盘 distinction', async () => {
  const view = await file('src/panel/helm-values-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['bridge()?.fetchHelmValues(chart.value.trim(), version.value.trim() || undefined)', 'chart.maxLength = 255', 'version.maxLength = 63', 'without saving files or installing', 'phaseLabel(state.phase, zh)']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(view));
  assert.ok(bridge.includes('fetchHelmValues: (chart: string, version?: string)') && bridge.includes('closeHelmValues: () => helmValues?.reset()'));
});
test('automatic dependency graphs forbid the new write modules; readonly suites cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-values-values.test.ts');
  for (const part of ['helm-values-cli', 'helm-values-client', 'helm-values-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:adapters\/helm-values|operations\/helm-values|runtime\/|helm-values-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-values-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-values-wiring.test.ts'"));
});
