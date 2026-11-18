// Text/metadata only. Never import or invoke the dry-run runner/client/operations, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSourceText as file } from '../fixtures/static-source-text.ts';
test('pinned upstream text proves the dry-run install branch and its syntax-dependent flags', async () => {
  const exec = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(exec.includes('helmDryRun runs a helm install with --dry-run and --debug set.') || exec.includes('// helmDryRun runs a helm install with --dry-run and --debug set.'));
  assert.ok(exec.includes("const generateNameArg = (syntaxVersion === HelmSyntaxVersion.V3 || syntaxVersion === HelmSyntaxVersion.V4) ? '--generate-name' : ''"));
  assert.ok(exec.includes("(syntaxVersion === HelmSyntaxVersion.V4) ? '--dry-run=client' : '--dry-run'"));
  assert.ok(exec.includes('install ${dryRunArg} ${generateNameArg} --debug "${path}"'));
  assert.ok(extension.includes("registerCommand('extension.helmDryRun'"));
});
test('pure projections live in shared: verbatim argument branch, isolation flags, fixed codes', async () => {
  const shared = await file('src/shared/helm-dryrun-protocol.ts');
  for (const part of ["import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts'", "syntax === 'v4' ? '--dry-run=client' : '--dry-run'", "syntax === 'v3' || syntax === 'v4' ? ['--generate-name'] : []", "'install', dryRunArg, ...generateNameArg, '--debug'", 'export function dryRunFailureCode(error: unknown)']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the runner keeps the dry run non-cluster and retains only bounded stdout', async () => {
  const code = await file('src/service/adapters/helm-dryrun-cli.ts');
  for (const part of ['dryRunArguments(input.syntax, input.root, input.path, input.source, home)', "spawn('helm', [...args]", "'ignore', 'pipe', 'ignore'", '16_384', 'SIGKILL', 'non-zero exit = dry-run failure (fixed code), never a partial claim']) assert.ok(code.includes(part), part);
  assert.ok(!/kubeconfig|--kube|unlinkSync|rmSync|console\.|setInterval/.test(code));
});
test('operations are single-shot with a fixed deadline and re-probe the syntax through the version reader', async () => {
  const code = await file('src/service/operations/helm-dryrun.ts'), main = await file('src/service/runtime/main.ts');
  for (const part of ["if (running) throw new BoundaryError('QUERY_LIMIT')", 'const deadlineMs = 30_000', 'options.syntax(signal)', 'dryRunFailureCode(error)', 'helm-dry-run-unavailable']) assert.ok(code.includes(part), part);
  assert.ok(!/setInterval|retry|console\.|writeFile|spawn/.test(code));
  assert.ok(main.includes('createHelmDryRunOperations({ run: createHelmDryRunRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment), syntax: async probeSignal => (await helmVersions.read({ protocol: 2, kind: \'read\' }, probeSignal)).syntax })'));
});
test('runtime authenticates the route and the response never carries stderr', async () => {
  const http = await file('src/service/runtime/http.ts');
  const offset = http.indexOf("url.pathname === '/v2/helm/dry-run'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmDryRuns.handle(input, controller.signal)') && http.includes('options.helmDryRuns.close()'));
});
test('the panel view is an explicit form disclosing the install branch, syntax echo and no-cluster promise', async () => {
  const view = await file('src/panel/helm-dryrun-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['bridge()?.runHelmDryRun(root.value.trim(), path.value.trim())', 'root.maxLength = 4096', 'path.maxLength = 4096', 'without installing resources', 'phaseLabel(state.phase, zh)']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(view));
  assert.ok(bridge.includes('runHelmDryRun: (root: string, path: string)') && bridge.includes('closeHelmDryRun: () => helmDryRuns?.reset()'));
});
test('automatic dependency graphs forbid the new write modules; readonly suites cover pure values only', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-dryrun-values.test.ts');
  for (const part of ['helm-dryrun-cli', 'helm-dryrun-client', 'helm-dryrun-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:adapters\/helm-dryrun|operations\/helm-dryrun|runtime\/|helm-dryrun-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-dryrun-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-dryrun-wiring.test.ts'"));
});
