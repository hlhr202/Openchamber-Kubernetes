// Text/metadata only. Never import or invoke the create runner/client/operations, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSourceText as file } from '../fixtures/static-source-text.ts';
test('pinned upstream text proves create is folder-pick + name box + helm create with optional open', async () => {
  const exec = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(exec.includes('export async function helmCreate(): Promise<void>'));
  assert.ok(exec.includes('const folder = await showWorkspaceFolderPick();'));
  assert.ok(exec.includes("const fullpath = filepath.join(folder.uri.fsPath, name);") && exec.includes('create "${fullpath}"'));
  assert.ok(exec.includes("'Open Chart.yaml'") && exec.includes("'Open Folder'"));
  assert.ok(extension.includes("registerCommand('extension.helmCreate'"));
});
test('pure projections live in shared: bounded name, canonical joins, isolation flags, fixed codes', async () => {
  const shared = await file('src/shared/helm-create-protocol.ts');
  for (const part of ["import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts'", "export const helmChartName = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)", 'export function createdChartPath(root: string, path: string, name: string)', "'create', createdChartPath(root, path, name)", 'export function createFailureCode(error: unknown)']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the runner scaffolds only inside the canonical parent and retains bounded stdout', async () => {
  const code = await file('src/service/adapters/helm-create-cli.ts');
  for (const part of ['createArguments(input.root, input.path, input.name, input.source, home)', "spawn('helm', [...args]", "'ignore', 'pipe', 'ignore'", '16_384', 'SIGKILL', 'No implicit install, no', 'non-zero exit = create failure (fixed code), never a partial claim']) assert.ok(code.includes(part), part);
  assert.ok(!/unlinkSync|rmSync|console\.|setInterval|os\.tmpdir/.test(code));
});
test('operations are single-shot with a fixed deadline and no auto-open or retry', async () => {
  const code = await file('src/service/operations/helm-create.ts'), main = await file('src/service/runtime/main.ts');
  for (const part of ["if (running) throw new BoundaryError('QUERY_LIMIT')", 'const deadlineMs = 30_000', 'createFailureCode(error)', 'helm-chart-create-unavailable']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|retry|console\.|writeFile|spawn|open/.test(code));
  assert.ok(main.includes('createHelmCreateOperations({ run: createHelmCreateRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) })'));
});
test('runtime authenticates the route and the response never carries stderr', async () => {
  const http = await file('src/service/runtime/http.ts');
  const offset = http.indexOf("url.pathname === '/v2/helm/create'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmCreates.handle(input, controller.signal)') && http.includes('options.helmCreates.close()'));
});
test('the panel view discloses the no-auto-open deviation and canonical-only inputs', async () => {
  const view = await file('src/panel/helm-create-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['bridge()?.runHelmCreate(root.value.trim(), path.value.trim(), name.value.trim())', 'name.maxLength = 128', 'without installing it', 'phaseLabel(state.phase, zh)']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(view));
  assert.ok(bridge.includes('runHelmCreate: (root: string, path: string, name: string)') && bridge.includes('closeHelmCreate: () => helmCreates?.reset()'));
});
test('automatic dependency graphs forbid the new write modules; readonly suites cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-create-values.test.ts');
  for (const part of ['helm-create-cli', 'helm-create-client', 'helm-create-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:adapters\/helm-create|operations\/helm-create|runtime\/|helm-create-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-create-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-create-wiring.test.ts'"));
});
