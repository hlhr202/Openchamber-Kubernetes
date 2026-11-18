// Text/metadata only. Never import or invoke the package runner/client/operations, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSourceText as file } from '../fixtures/static-source-text.ts';
test('pinned upstream text proves packaging is pickChart + single-folder save + package -d', async () => {
  const exec = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(exec.includes('export function helmPackage()'));
  assert.ok(exec.includes('const options = { openLabel: "Save Package", canSelectFiles: false, canSelectFolders: true, canSelectMany: false }'));
  assert.ok(exec.includes("packagePath[0].scheme !== 'file'") && exec.includes('Packaging folder must be a filesystem folder'));
  assert.ok(exec.includes('package "${path}" -d "${packagePath[0].fsPath}"'));
  assert.ok(extension.includes("registerCommand('extension.helmPackage'"));
});
test('pure projections live in shared: canonical joins for both locations, isolation flags, fixed codes', async () => {
  const shared = await file('src/shared/helm-package-protocol.ts');
  for (const part of ["import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts'", "destinationRoot: workspaceRootSchema, destinationPath: workspaceRelativeSchema", "'package', workspaceChartDirectory(root, path), '-d', workspaceChartDirectory(destinationRoot, destinationPath)", 'export function packageFailureCode(error: unknown)']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the runner writes only into the designated workspace destination and retains bounded stdout', async () => {
  const code = await file('src/service/adapters/helm-package-cli.ts');
  for (const part of ['packageArguments(input.root, input.path, input.destinationRoot, input.destinationPath, input.source, home)', "mkdir(workspaceChartDirectory(input.destinationRoot, input.destinationPath), { recursive: true })", "spawn('helm', [...args]", "'ignore', 'pipe', 'ignore'", '16_384', 'SIGKILL', 'non-zero exit = packaging failure (fixed code), never a partial claim']) assert.ok(code.includes(part), part);
  assert.ok(!/unlinkSync|rmSync|console\.|setInterval|os\.tmpdir/.test(code));
});
test('operations are single-shot with a fixed deadline; partial archives are reported, never retried', async () => {
  const code = await file('src/service/operations/helm-package.ts'), main = await file('src/service/runtime/main.ts');
  for (const part of ["if (running) throw new BoundaryError('QUERY_LIMIT')", 'const deadlineMs = 30_000', 'packageFailureCode(error)', 'helm-package-unavailable']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|retry|console\.|writeFile|spawn/.test(code));
  assert.ok(main.includes('createHelmPackageOperations({ run: createHelmPackageRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) })'));
});
test('runtime authenticates the route and the response never carries stderr', async () => {
  const http = await file('src/service/runtime/http.ts');
  const offset = http.indexOf("url.pathname === '/v2/helm/package'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmPackages.handle(input, controller.signal)') && http.includes('options.helmPackages.close()'));
});
test('the panel view discloses the single filesystem effect and canonical-only inputs', async () => {
  const view = await file('src/panel/helm-package-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['bridge()?.runHelmPackage(chartRoot.input.value.trim(), chartPath.input.value.trim(), destinationRoot.input.value.trim(), destinationPath.input.value.trim())', '.tgz in the selected directory', 'without publishing or installing', 'phaseLabel(state.phase, zh)']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(view));
  assert.ok(bridge.includes('runHelmPackage: (root: string, path: string, destinationRoot: string, destinationPath: string)') && bridge.includes('closeHelmPackage: () => helmPackages?.reset()'));
});
test('automatic dependency graphs forbid the new write modules; readonly suites cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-package-values.test.ts');
  for (const part of ['helm-package-cli', 'helm-package-client', 'helm-package-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:adapters\/helm-package|operations\/helm-package|runtime\/|helm-package-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-package-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-package-wiring.test.ts'"));
});
