// Source/hash audit only. No real file adapter, SDK, CLI or operations are imported.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('eleven fixed Helm format/path texts have independent hashes and are not an approved runtime matrix', async () => {
  const index = JSON.parse(await file('docs/baseline/helm-sources.json')) as { evidence: string; scope: string; records: Array<{ path: string; tag: string; commit: string; bytes: number; sha256: string }> };
  assert.equal(index.evidence, 'M1-E051'); assert.equal(index.records.length, 11); assert.ok(index.scope.includes('not-cli-support'));
  for (const record of index.records) { const text = await file(`tests/fixtures/contracts/helm-contract/${record.path}.txt`); assert.equal(Buffer.byteLength(text), record.bytes); assert.equal(createHash('sha256').update(text).digest('hex'), record.sha256); assert.equal(record.tag, 'v3.19.0'); assert.match(record.commit, /^[a-f0-9]{40}$/); }
});
test('fixed upstream repo labels/version tooltip/order and refresh side effect are traced, not inferred from a mock tree', async () => {
  const upstream = await file('tests/fixtures/baseline/kubernetes/src/helm.repoExplorer.ts.txt'), search = await file('tests/fixtures/contracts/helm-contract/cmd/helm/search_repo.go.txt');
  assert.ok(upstream.includes('id.substring(repoName.length + 1)') && upstream.includes('App version:') && upstream.includes("helm.helmExecAsync('repo update')"));
  assert.ok(search.includes('o.version = ">0.0.0"') && search.includes('repo.LoadIndexFile(f)'));
});
test('cache file adapter uses bounded nofollow/nonblock readonly descriptors and stable metadata without creating files/directories', async () => {
  const code = await file('src/service/adapters/helm-repository-file.ts');
  assert.ok(code.includes('constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW') && code.includes('before.isFile()') && code.includes('Buffer.alloc(maximumBytes + 1)') && code.includes('await file.close()'));
  assert.ok(!/writeFile|mkdir|rename|unlink|spawn\(|fetch\(|process\.env|operations\/|sessions\//.test(code));
});
test('reader keeps cache sources explicit, HMACs full config/index inputs and never follows private cache paths or downloads', async () => {
  const code = await file('src/service/queries/helm-repositories.ts'); assert.ok(code.includes("createHmac('sha256', key)") && code.includes('`${branch.repository}-index.yaml`') && code.includes('HELM_INDEX_MISSING'));
  assert.ok(code.includes('concurrency: 2, queued: 8, consumers: 32, timeoutMs: 5000') && code.includes('480_000'));
  assert.ok(!/repo update|spawn\(|fetch\(|writeFile|mkdir|\.url|\.password|\.cache\b|operations\/|sessions\//.test(code));
});
test('authenticated bounded POST and service close wire only existing file reads, not Helm or cache refresh', async () => {
  const http = await file('src/service/runtime/http.ts'), runtime = await file('src/service/runtime/main.ts');
  assert.ok(http.indexOf('authorized(request.headers.authorization') < http.indexOf("url.pathname === '/v2/helm/repositories/read'")); assert.ok(http.includes('options.helmRepositories.read(input, controller.signal)') && http.includes('options.helmRepositories.close()'));
  assert.ok(runtime.includes('createHelmRepositoryReader(serviceGeneration, readHelmRepositoryFile, () => discoverHelmRepositories(helmEnvironment))'));
});
test('UI/bridge are explicit inert diagnostics and never mount a fake tree, version Inspect, storage or automatic file read', async () => {
  const ui = await file('src/panel/helm-repository-view.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(ui.includes('label.textContent = logDisplayText(node.label)') && ui.includes("node.kind === 'version'") && ui.includes('cached indexes'));
  assert.ok(!/innerHTML|localStorage|storage\.|window\.open|fetch\(|setInterval|\.read\(/.test(ui)); assert.ok(bridge.includes('helmRepositories.dispose()') && bridge.includes('helmRepositories.reset()'));
});
test('new read suites are explicit allowlist members and cannot import actual filesystem/SDK/runtime or operation handlers', async () => {
  const tests = await file('tests/readonly/helm-repositories.test.ts'), readonly = await file('scripts/readonly-tests.ts'), statics = await file('scripts/static-tests.ts');
  assert.ok(readonly.includes("'tests/readonly/helm-repositories.test.ts'") && statics.includes("'tests/static/helm-repository-wiring.test.ts'"));
  assert.ok(!/from ['"].*(?:node:fs|adapters\/|operations\/|sessions\/|runtime\/|bridge|@openchamber)|spawn\(|fork\(/.test(tests));
});
