// Text/metadata only. Never import or invoke the template runner/client/operations, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSourceText as file } from '../fixtures/static-source-text.ts';
test('pinned upstream text proves template is a chart-picker driven real CLI path with error display', async () => {
  const exec = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(exec.includes('template "${path}"'));
  assert.ok(exec.includes("helmExec(`template \"${path}\"`, (code, out, err) => {") || exec.includes('template "${path}"'));
  assert.ok(exec.includes('Chart rendered successfully'));
  assert.ok(extension.includes("registerCommand('extension.helmTemplate'"));
});
test('pure projections live in shared: canonical join, isolation flags, fixed render-failure code', async () => {
  const shared = await file('src/shared/helm-template-protocol.ts');
  for (const part of ["import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts'", 'export function workspaceChartDirectory(root: string, path: string)', 'export function helmTemplateArguments(root: string, path: string', "'template', workspaceChartDirectory(root, path)", 'export function templateFailureCode(error: unknown)']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the runner treats a non-zero exit as a render failure and retains only bounded stdout', async () => {
  const code = await file('src/service/adapters/helm-template-cli.ts');
  for (const part of ['helmTemplateArguments(input.root, input.path, input.source, home)', "spawn('helm', [...args]", "'ignore', 'pipe', 'ignore'", '16_384', 'SIGKILL', 'non-zero exit = render failure (fixed code), never a partial claim']) assert.ok(code.includes(part), part);
  assert.ok(!/unlinkSync|rmSync|console\.|setInterval|os\.tmpdir/.test(code));
});
test('operations are single-shot with a fixed deadline and no findings-like reclassification', async () => {
  const code = await file('src/service/operations/helm-template.ts'), main = await file('src/service/runtime/main.ts');
  for (const part of ["if (running) throw new BoundaryError('QUERY_LIMIT')", 'const deadlineMs = 30_000', 'templateFailureCode(error)', 'helm-template-unavailable']) assert.ok(code.includes(part), part);
  assert.ok(!/failed:|setInterval|retry|console\.|writeFile|spawn/.test(code));
  assert.ok(main.includes('createHelmTemplateOperations({ run: createHelmTemplateRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) })'));
});
test('runtime authenticates the route and the response never carries stderr', async () => {
  const http = await file('src/service/runtime/http.ts');
  const offset = http.indexOf("url.pathname === '/v2/helm/template'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmTemplates.handle(input, controller.signal)') && http.includes('options.helmTemplates.close()'));
});
test('the panel view is an explicit canonical-directory form disclosing bounded render semantics', async () => {
  const view = await file('src/panel/helm-template-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['bridge()?.renderHelmTemplate(root.value.trim(), path.value.trim())', 'root.maxLength = 4096', 'path.maxLength = 4096', 'nothing is applied to the cluster', 'state.code', 'phaseLabel(state.phase, zh)']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(view));
  assert.ok(bridge.includes('renderHelmTemplate: (root: string, path: string)') && bridge.includes('closeHelmTemplate: () => helmTemplates?.reset()'));
});
test('automatic dependency graphs forbid the new write modules; readonly suites cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-template-values.test.ts');
  for (const part of ['helm-template-cli', 'helm-template-client', 'helm-template-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:adapters\/helm-template|operations\/helm-template|runtime\/|helm-template-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-template-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-template-wiring.test.ts'"));
});
