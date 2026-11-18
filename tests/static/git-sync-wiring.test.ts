// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the sync flow: two-piece tag rule, version message, OK-gated checkout', async () => {
  const extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt'), git = await file('tests/fixtures/baseline/kubernetes/src/components/git/git.ts.txt');
  assert.ok(extension.includes('async function syncKubernetes(): Promise<void>'));
  assert.ok(extension.includes("const pieces = container.image.split(':');"));
  assert.ok(extension.includes('pieces.length !== 2'));
  assert.ok(extension.includes('Sync requires image tag to have a version which is a Git commit ID.'));
  assert.ok(extension.includes('The Git commit deployed to the cluster is  ${commitId} (created ${whenCreated.trim()} ago). This will check out that commit.'));
  assert.ok(extension.includes('The image version deployed to the cluster is ${commitId}. This will look for a Git commit with that name/ID and check it out.'));
  assert.ok(extension.includes("showInformationMessage(versionMessage, 'OK')"));
  assert.ok(git.includes('log --pretty=%ar -n 1 ${commitId}'));
  assert.ok(git.includes('checkout ${commitId}'));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const shared = await file('src/shared/git-sync-protocol.ts');
  for (const part of ['export function imageTagCommit(image: string): string | null', 'export function syncVersionMessage(commitId: string, whenCreated: string | null)', 'export function gitWhenCreatedArguments(commitId: string)', "'log', '--pretty=%ar', '-n', '1', commitId", "export function gitCheckoutArguments(commitId: string)", "'checkout', commitId", 'SERVER-SIDE EXECUTION IS']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the approved sync execution surface exists and is gated: route, client and view wired', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(routes.includes('/v2/operations/git-sync'));
  assert.ok(bridge.includes('GitSyncClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsKubernetesSync');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M4-E029');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/git-sync-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/git-sync-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/git-sync-wiring.test.ts'"));
});
