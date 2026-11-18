// Text/metadata only. Never import or invoke the fetch runner/client/operations, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSourceText as file } from '../fixtures/static-source-text.ts';
test('pinned upstream text proves fetch is input/chart node + folder pick + fetch --untar -d', async () => {
  const exec = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(exec.includes('export async function helmFetch(helmObject: helmrepoexplorer.HelmObject | undefined): Promise<void>'));
  assert.ok(exec.includes('shell.isSafe(chartId)') && exec.includes('Unexpected characters in chart name'));
  assert.ok(exec.includes('fetch ${chartId} --untar ${versionArg} -d "${destinationDir}"'));
  assert.ok(exec.includes('Helm fetch failed'));
  assert.ok(extension.includes("registerCommand('extension.helmFetch'"));
});
test('pure projections live in shared: token reuse, canonical join, isolation flags, fixed codes', async () => {
  const shared = await file('src/shared/helm-fetch-protocol.ts');
  for (const part of ["import { helmChartReference, helmChartVersion } from './helm-inspect-protocol.ts'", 'export function fetchArguments(chart: string, version: string | undefined', "'fetch', chart, '--untar'", "'-d', workspaceChartDirectory(root, path)", 'export function fetchFailureCode(error: unknown)']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the runner untars only into the designated destination and retains bounded stdout', async () => {
  const code = await file('src/service/adapters/helm-fetch-cli.ts');
  for (const part of ['fetchArguments(input.chart, input.version, input.root, input.path, input.source, home)', "mkdir(workspaceChartDirectory(input.root, input.path), { recursive: true })", "spawn('helm', [...args]", "'ignore', 'pipe', 'ignore'", '16_384', 'SIGKILL', 'non-zero exit = fetch failure (fixed code), never a partial claim']) assert.ok(code.includes(part), part);
  assert.ok(!/unlinkSync|rmSync|console\.|setInterval|os\.tmpdir/.test(code));
});
test('operations are single-shot with a download-aware fixed deadline', async () => {
  const code = await file('src/service/operations/helm-fetch.ts'), main = await file('src/service/runtime/main.ts');
  for (const part of ["if (running) throw new BoundaryError('QUERY_LIMIT')", 'const deadlineMs = 60_000', 'fetchFailureCode(error)', 'helm-fetch-unavailable']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|retry|console\.|writeFile|spawn/.test(code));
  assert.ok(main.includes('createHelmFetchOperations({ run: createHelmFetchRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) })'));
});
test('runtime authenticates the route and the response never carries stderr', async () => {
  const http = await file('src/service/runtime/http.ts');
  const offset = http.indexOf("url.pathname === '/v2/helm/fetch'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmFetches.handle(input, controller.signal)') && http.includes('options.helmFetches.close()'));
});
test('the panel view discloses the untar destination and canonical-only inputs', async () => {
  const view = await file('src/panel/helm-fetch-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['bridge()?.runHelmFetch(chart.value.trim(), version.value.trim() || undefined, root.value.trim(), path.value.trim())', 'chart.maxLength = 255', 'version.maxLength = 63', 'selected directory', 'inspect them before retrying', 'phaseLabel(state.phase, zh)']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(view));
  assert.ok(bridge.includes('runHelmFetch: (chart: string, version: string | undefined, root: string, path: string)') && bridge.includes('closeHelmFetch: () => helmFetches?.reset()'));
});
test('automatic dependency graphs forbid the new write modules; readonly suites cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-fetch-values.test.ts');
  for (const part of ['helm-fetch-cli', 'helm-fetch-client', 'helm-fetch-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:adapters\/helm-fetch|operations\/helm-fetch|runtime\/|helm-fetch-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-fetch-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-fetch-wiring.test.ts'"));
});
