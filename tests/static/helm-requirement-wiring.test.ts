// Text/metadata only. Never import or invoke the requirement reader/client, real or mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readSourceText as file } from '../fixtures/static-source-text.ts';
test('pinned upstream text proves the Requirement shape, the editor insertion and the lookup chain', async () => {
  const exec = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(exec.includes('export function insertRequirement()'));
  assert.ok(exec.includes('ed.insertSnippet(new vscode.SnippetString(req.toString()));'));
  assert.ok(exec.includes('export function searchForChart(name: string): Requirement | undefined'));
  assert.ok(exec.includes('req.repository = repo.url;') && exec.includes('req.version = releases[0].version;'));
  assert.ok(exec.includes('- name: ${this.name}'));
  assert.ok(extension.includes("registerCommand('extension.helmInsertReq'"));
});
test('pure projections live in shared: upstream text shape with the @alias and no URL field', async () => {
  const shared = await file('src/shared/helm-requirement-protocol.ts');
  for (const part of ["import { helmRepositoryName } from './helm-repository-protocol.ts'", 'export function requirementText(repository: string, chart: string, version: string)', '- name: ${chart}', 'repository: @${repository}', 'NEVER leave the read boundary']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the reader reuses the repository-file boundary and pure projections with the original scheduler shape', async () => {
  const code = await file('src/service/queries/helm-requirement-reader.ts');
  for (const part of ['createHelmRequirementReader(readFile: HelmRepositoryFileRead, defaults', "import { projectHelmIndex, projectHelmRepositories } from './helm-repository-source.ts'", 'ReadScheduler<HelmRequirementResponse>({ concurrency: 2, queued: 8, consumers: 32, timeoutMs: 5000 })', 'posix.normalize(repositoryFile) !== repositoryFile', 'projectHelmRepositories(config.content).includes(repository)', 'projectHelmIndex(index.content).find(item => item.name === chart)', 'requirementText(repository, chart, version)']) assert.ok(code.includes(part), part);
  assert.ok(!/spawn|child_process|writeFile|console\./.test(code));
});
test('runtime wires the reader over the same repository file adapter and authenticates the route', async () => {
  const main = await file('src/service/runtime/main.ts'), http = await file('src/service/runtime/http.ts');
  assert.ok(main.includes('createHelmRequirementReader(readHelmRepositoryFile, () => discoverHelmRepositories(helmEnvironment))'));
  const offset = http.indexOf("url.pathname === '/v2/helm/requirement'"); assert.ok(offset > http.indexOf('authorized(request.headers.authorization'));
  assert.ok(http.slice(offset, offset + 700).includes('options.helmRequirements.read(input, controller.signal)') && http.includes('options.helmRequirements.close()'));
});
test('the client is a bounded read-only lookup with no insertion or clipboard coupling', async () => {
  const client = await file('src/host/helm-requirement-client.ts');
  for (const part of ["path: '/v2/helm/requirement'", 'response.body.length > 4096', 'reset()', 'dispose()']) assert.ok(client.includes(part), part);
  assert.ok(!/insertSnippet|clipboard|writeText|execCommand/.test(client));
});
test('the panel view displays the bounded text only and discloses the alias deviation', async () => {
  const view = await file('src/panel/helm-requirement-view.ts'), bridge = await file('src/host/bridge.ts');
  for (const part of ['bridge()?.lookupHelmRequirement(repository.value.trim(), chart.value.trim())', 'repository.maxLength = 128', 'chart.maxLength = 128', 'Preview only', 'files are not edited']) assert.ok(view.includes(part), part);
  assert.ok(!/innerHTML|storage\.|writeClipboard|console\./.test(view));
  assert.ok(bridge.includes('lookupHelmRequirement: (repository: string, chart: string)') && bridge.includes('closeHelmRequirement: () => helmRequirements?.reset()'));
});
test('automatic dependency graphs forbid the new client/view from readonly roots; suites are registered', async () => {
  const check = await file('scripts/check-static.ts'), readonly = await file('tests/readonly/helm-requirement-values.test.ts');
  for (const part of ['helm-requirement-client', 'helm-requirement-view']) assert.ok(check.includes(part), part);
  assert.ok(!/from ['"].*(?:adapters\/|operations\/helm|runtime\/|helm-requirement-client|helm-fetch-client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-requirement-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-requirement-wiring.test.ts'"));
});
