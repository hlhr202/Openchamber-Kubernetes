// Text/metadata only. Never import or invoke the dep-up runner/client/operations, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSourceText as file } from '../fixtures/static-source-text.ts';
test('pinned upstream text proves dep up is a chart-picker driven real CLI path with failure logging', async () => {
  const exec = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(exec.includes('export function helmDepUp(arg: any /* Uri | TextDocument | undefined */)'));
  assert.ok(exec.includes("uri.scheme !== 'file'") && exec.includes('Chart is not on the filesystem'));
  assert.ok(exec.includes('dep up "${path}"') && exec.includes('UPDATE FAILED'));
  assert.ok(extension.includes("registerCommand('extension.helmDepUp'"));
});
test('pure projections live in shared: canonical join, isolation flags, fixed codes', async () => {
  const shared = await file('src/shared/helm-depup-protocol.ts');
  for (const part of ["import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts'", 'export function depUpArguments(root: string, path: string', "'dep', 'up', workspaceChartDirectory(root, path)", 'export function depUpFailureCode(error: unknown)']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the runner scopes workspace writes to the chart directory and retains only bounded stdout', async () => {
  const code = await file('src/service/adapters/helm-depup-cli.ts');
  for (const part of ['depUpArguments(input.root, input.path, input.source, home)', "spawn('helm', [...args]", "'ignore', 'pipe', 'ignore'", '16_384', 'SIGKILL', 'non-zero exit = update failure (fixed code), never a partial claim']) assert.ok(code.includes(part), part);
  assert.ok(!/unlinkSync|rmSync|console\.|setInterval|os\.tmpdir/.test(code));
});
test('operations are single-shot with a download-aware fixed deadline', async () => {
  const code = await file('src/service/operations/helm-depup.ts'), main = await file('src/service/runtime/main.ts');
  for (const part of ["if (running) throw new BoundaryError('QUERY_LIMIT')", 'const deadlineMs = 60_000', 'depUpFailureCode(error)', 'helm-dep-up-unavailable']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|retry|console\.|writeFile|spawn/.test(code));
  assert.ok(main.includes('createHelmDepUpOperations({ run: createHelmDepUpRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) })'));
});
test('runtime authenticates the route and the response never carries stderr', async () => {
  const http = await file('src/service/runtime/http.ts');
  const offset = http.indexOf("url.pathname === '/v2/helm/dep-up'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmDepUps.handle(input, controller.signal)') && http.includes('options.helmDepUps.close()'));
});
test('the panel view discloses the scoped workspace writes and canonical-only inputs', async () => {
  const view = await file('src/panel/helm-depup-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['bridge()?.runHelmDepUp(root.value.trim(), path.value.trim())', 'root.maxLength = 4096', 'path.maxLength = 4096', 'Chart.lock and charts/', 'partial changes', 'no automatic rollback']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(view));
  assert.ok(bridge.includes('runHelmDepUp: (root: string, path: string)') && bridge.includes('closeHelmDepUp: () => helmDepUps?.reset()'));
});
test('automatic dependency graphs forbid the new write modules; readonly suites cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-depup-values.test.ts');
  for (const part of ['helm-depup-cli', 'helm-depup-client', 'helm-depup-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:adapters\/helm-depup|operations\/helm-depup|runtime\/|helm-depup-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-depup-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-depup-wiring.test.ts'"));
});
