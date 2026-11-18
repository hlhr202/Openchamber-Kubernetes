// Text/metadata only. Never import or invoke the inspect runner/client/operations, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSourceText as file } from '../fixtures/static-source-text.ts';
test('pinned upstream text proves inspect is a virtual document over one shaped helm inspect call', async () => {
  const exec = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt'), provider = await file('tests/fixtures/baseline/kubernetes/src/helm.documentProvider.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(exec.includes('export function helmInspectChart(arg: any)') && exec.includes('inspectionScheme: helm.INSPECT_CHART_SCHEME') && exec.includes('generateFile: false'));
  assert.ok(provider.includes("const helm3Scope = (sv === exec.HelmSyntaxVersion.V2) ? '' : 'all'") && provider.includes("exec.helmExec(`inspect ${helm3Scope} ${id} ${versionArg}`, printer)"));
  assert.ok(provider.includes('shell.isSafe(version)') && provider.includes('Unexpected characters in chart version'));
  assert.ok(extension.includes("registerCommand('extension.helmInspectChart'"));
});
test('pure projections live in shared: scope branch, isolation flags, bounded tokens, fixed codes', async () => {
  const shared = await file('src/shared/helm-inspect-protocol.ts');
  for (const part of ["(syntax === 'v2' ? 'none' : 'all')", 'export function helmInspectArguments(syntax: HelmSyntax, chart: string', '`--repository-config=${source.paths.repositoryFile}`', "`--repository-cache=${cache}`, 'inspect'", "chart, ...(version ? ['--version', version] : [])", 'export function inspectFailureCode(error: unknown)']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the runner pipes only bounded stdout into the plugin-isolated cache download path', async () => {
  const code = await file('src/service/adapters/helm-inspect-cli.ts');
  for (const part of ['helmInspectArguments(input.syntax, input.chart, input.version, input.source, home)', 'mkdir(cache, { recursive: true })', "spawn('helm', [...args]", "'ignore', 'pipe', 'ignore'", '16_384', 'SIGKILL', 'stderr is never retained']) assert.ok(code.includes(part), part);
  assert.ok(!/unlinkSync|rmSync|console\.|setInterval/.test(code));
});
test('operations are single-shot with a fixed deadline and re-probe the syntax through the version reader', async () => {
  const code = await file('src/service/operations/helm-inspect.ts'), main = await file('src/service/runtime/main.ts');
  for (const part of ["if (running) throw new BoundaryError('QUERY_LIMIT')", 'const deadlineMs = 30_000', 'options.syntax(signal)', 'inspectFailureCode(error)', 'helm-chart-inspect-unavailable']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|retry|console\.|writeFile|spawn/.test(code));
  assert.ok(main.includes('createHelmInspectOperations({ run: createHelmInspectRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment), syntax: async probeSignal => (await helmVersions.read({ protocol: 2, kind: \'read\' }, probeSignal)).syntax })'));
});
test('runtime authenticates the route and the response never carries stderr or raw error bodies', async () => {
  const http = await file('src/service/runtime/http.ts');
  const offset = http.indexOf("url.pathname === '/v2/helm/inspect-chart'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmInspects.handle(input, controller.signal)') && http.includes('options.helmInspects.close()'));
});
test('the panel view is an explicit bounded form disclosing cache isolation, no values file', async () => {
  const view = await file('src/panel/helm-inspect-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['bridge()?.inspectHelmChart(chart.value.trim(), version.value.trim() || undefined)', 'chart.maxLength = 255', 'version.maxLength = 63', 'plugin cache', 'workspace and cluster are unchanged', 'phaseLabel(state.phase, zh)']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(view));
  assert.ok(bridge.includes('inspectHelmChart: (chart: string, version?: string)') && bridge.includes('closeHelmInspect: () => helmInspects?.reset()'));
});
test('automatic dependency graphs forbid the new write modules; readonly suites cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-inspect-values.test.ts');
  for (const part of ['helm-inspect-cli', 'helm-inspect-client', 'helm-inspect-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:adapters\/helm-inspect|operations\/helm-inspect|runtime\/|helm-inspect-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-inspect-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-inspect-wiring.test.ts'"));
});
