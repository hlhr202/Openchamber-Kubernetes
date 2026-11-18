// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves rollback is history-node-only, guards deployed, confirms, then rolls back', async () => {
  const exec = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(exec.includes('export async function helmRollback(resourceNode?: HelmHistoryNode)'));
  assert.ok(exec.includes("resourceNode.release.status === \"deployed\""));
  assert.ok(exec.includes("'This is the currently deployed release'"));
  assert.ok(exec.includes('You are about to rollback ${releaseName} to release version ${release.revision}. Continue?'));
  assert.ok(exec.includes(`'Rollback'`));
  assert.ok(exec.includes('helmExecAsync(`rollback ${releaseName} ${release.revision} --cleanup-on-fail`)'));
  assert.ok(extension.includes('registerCommand("extension.helmRollback"'));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const shared = await file('src/shared/helm-rollback-protocol.ts');
  for (const part of ['export function helmRollbackArguments(release: string, revision: number, kubeconfigPath: string)', "'--kubeconfig', kubeconfigPath, 'rollback', release, String(revision), '--cleanup-on-fail'", 'SERVER-SIDE EXECUTION IS', 'materializing credentials to disk']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('no server execution surface exists yet: no adapter, route, client or view for helm rollback', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('/v2/helm/rollback'));
  assert.ok(!bridge.includes('HelmRollbackClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.helmRollback');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M6-E076');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/helm-rollback-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|queries\/helm|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-rollback-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-rollback-wiring.test.ts'"));
});
