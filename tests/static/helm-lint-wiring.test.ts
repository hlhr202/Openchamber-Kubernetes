// Text/metadata only. Never import or invoke the lint runner/client/operations, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSourceText as file } from '../fixtures/static-source-text.ts';
test('pinned upstream text proves lint is a chart-picker driven real CLI path', async () => {
  const exec = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(exec.includes('lint "${path}"'));
  assert.ok(exec.includes('pickChart') || exec.includes('pickChart('));
  assert.ok(extension.includes("registerCommand('extension.helmLint'"));
});
test('pure projections live in shared: canonical join, isolation flags, findings-not-failure codes', async () => {
  const shared = await file('src/shared/helm-lint-protocol.ts');
  for (const part of ["import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts'", 'export function workspaceChartDirectory(root: string, path: string)', 'export function helmLintArguments(root: string, path: string', "'lint', workspaceChartDirectory(root, path)", 'export function lintFailureCode(error: unknown)']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the runner maps a non-zero exit to findings and retains only bounded stdout', async () => {
  const code = await file('src/service/adapters/helm-lint-cli.ts');
  for (const part of ['helmLintArguments(input.root, input.path, input.source, home)', "spawn('helm', [...args]", "'ignore', 'pipe', 'ignore'", '16_384', 'SIGKILL', 'non-zero exit = findings result (failed: true), not rejection']) assert.ok(code.includes(part), part);
  assert.ok(!/unlinkSync|rmSync|console\.|setInterval|os\.tmpdir/.test(code));
});
test('operations are single-shot with a fixed deadline and never reclassify findings as failures', async () => {
  const code = await file('src/service/operations/helm-lint.ts'), main = await file('src/service/runtime/main.ts');
  for (const part of ["if (running) throw new BoundaryError('QUERY_LIMIT')", 'const deadlineMs = 30_000', 'failed: result.failed', 'lintFailureCode(error)', 'helm-lint-unavailable']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|retry|console\.|writeFile|spawn/.test(code));
  assert.ok(main.includes('createHelmLintOperations({ run: createHelmLintRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) })'));
});
test('runtime authenticates the route and the response never carries stderr', async () => {
  const http = await file('src/service/runtime/http.ts');
  const offset = http.indexOf("url.pathname === '/v2/helm/lint'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmLints.handle(input, controller.signal)') && http.includes('options.helmLints.close()'));
});
test('the panel view is an explicit canonical-directory form disclosing the findings semantics', async () => {
  const view = await file('src/panel/helm-lint-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['bridge()?.lintHelmChart(root.value.trim(), path.value.trim())', 'root.maxLength = 4096', 'path.maxLength = 4096', 'Findings appear below', 'state.failed === true', 'nothing is installed']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(view));
  assert.ok(bridge.includes('lintHelmChart: (root: string, path: string)') && bridge.includes('closeHelmLint: () => helmLints?.reset()'));
});
test('automatic dependency graphs forbid the new write modules; readonly suites cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-lint-values.test.ts');
  for (const part of ['helm-lint-cli', 'helm-lint-client', 'helm-lint-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:adapters\/helm-lint|operations\/helm-lint|runtime\/|helm-lint-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-lint-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-lint-wiring.test.ts'"));
});
