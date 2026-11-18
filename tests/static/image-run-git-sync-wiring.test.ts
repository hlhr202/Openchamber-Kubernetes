// Text/metadata only. Never import or invoke the ImageRun/GitSync clients, adapters or operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('the ImageRun transport is one sequential build -> push -> Pod POST dispatch with fixed budgets', async () => {
  const adapter = await file('src/service/adapters/image-run-cli.ts');
  for (const part of ["from './https-once.ts'", 'directConnection', "'build', '-t', input.image", "'bud', '-t', input.image", "['push', input.image]", 'fieldManager=kubectl-run', 'beforeDispatch()', '240_000', '120_000', "outcome: 'accepted'", 'transport.ca?.fill(0)']) assert.ok(adapter.includes(part), part);
  assert.ok(adapter.includes('docker first, buildah fallback') || adapter.includes('buildah'));
  assert.ok(!/spawnSync|exec\(|shell: true|console\.|setInterval|writeFile/.test(adapter));
  assert.ok((adapter.match(/await runCli\(/g) ?? []).length === 4); // detection(2) + build + push
});
test('the ImageRun operation runs on the universal G4 gate with a long bounded dispatch window', async () => {
  const operation = await file('src/service/operations/image-run.ts');
  for (const part of ['createG4SubmitGate<Parameters>', "step: 'image-run'", 'dispatchTimeoutMs: 420_000', 'bindResourceTarget']) assert.ok(operation.includes(part), part);
  assert.ok(!/execFile|spawn|writeFile|console\.|setInterval/.test(operation));
});
test('the git adapter is a bounded read-only probe plus ONE checkout, never force/reset/clean', async () => {
  const adapter = await file('src/service/adapters/git-cli.ts');
  for (const part of ["['log', '--pretty=%ar', '-n', '1', commitId]", "['checkout', commitId]", 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'shell: false', "commitId.startsWith('-')", 'process.kill(-child.pid']) assert.ok(adapter.includes(part), part);
  assert.ok(!/--force|--hard|checkout\s+--|reset|clean|console\.|writeFile/.test(adapter));
});
test('runtime authenticates both routes and constructs both operations with the shared write lock', async () => {
  const http = await file('src/service/runtime/http.ts'), main = await file('src/service/runtime/main.ts'), bridge = await file('src/host/bridge.ts');
  for (const route of ['/v2/operations/image-run', '/v2/operations/git-sync']) {
    const offset = http.indexOf(`url.pathname === '${route}'`);
    assert.ok(offset > http.indexOf('authorized(request.headers.authorization'), route);
  }
  assert.ok(http.includes('options.imageRuns.handle(input, controller.signal)') && http.includes('options.gitSyncs.handle(input, controller.signal)') && http.includes('options.imageRuns.close()') && http.includes('options.gitSyncs.close()'));
  assert.ok(main.includes('createImageRunOperations({ serviceGeneration, config, lock, execute: createImageRunAdapter(config) })'));
  assert.ok(main.includes('createGitSyncOperations({ serviceGeneration, config, lock, probe: gitCli.whenCreated, checkout: gitCli.checkout })'));
  assert.ok(bridge.includes('imageRuns?.prepare(') && bridge.includes('gitSyncs?.prepare(') && bridge.includes("resources.invalidate('pods', state.outcome.target)"));
});
test('the views keep explicit confirm and original ledger; the read graph cannot reach the new modules', async () => {
  const runView = await file('src/panel/image-run-view.ts'), syncView = await file('src/panel/git-sync-view.ts'), main = await file('src/panel/main.ts');
  for (const part of ['bridge()?.prepareImageRun(', 'bridge()?.submitImageRun()', 'bridge()?.cancelImageRun()', 'bridge()?.imageRunOutcomes()']) assert.ok(runView.includes(part), part);
  for (const part of ['bridge()?.prepareGitSync(', 'bridge()?.submitGitSync()', 'bridge()?.cancelGitSync()', 'bridge()?.gitSyncOutcomes()']) assert.ok(syncView.includes(part), part);
  assert.ok(!/innerHTML|writeClipboard|storage\./.test(runView + syncView));
  assert.ok(main.includes('mountImageRunView') && main.includes('mountGitSyncView') && main.includes('bridge.onImageRun(') && main.includes('bridge.onGitSync('));
  const check = await file('scripts/check-static.ts');
  for (const part of ['image-run-cli', 'git-cli', 'image-run-client', 'git-sync-client', 'image-run-view', 'git-sync-view']) assert.ok(check.includes(part), part);
});
test('the new value assertions stay in the registered readonly suites', async () => {
  for (const suite of ['tests/readonly/image-run-values.test.ts', 'tests/readonly/git-sync-values.test.ts']) {
    const code = await file(suite);
    assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|client|bridge|sdk)/.test(code));
  }
});
