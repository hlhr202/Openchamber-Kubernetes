// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves get is a virtual document over helm get with the syntax scope', async () => {
  const exec = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt'), virtualfs = await file('tests/fixtures/baseline/kubernetes/src/kuberesources.virtualfs.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(exec.includes('export function helmGet(resourceNode?: ClusterExplorerNode)'));
  assert.ok(exec.includes('export function helmfsUri(releaseName: string, revision: number | undefined): vscode.Uri'));
  assert.ok(virtualfs.includes("export const HELM_RESOURCE_AUTHORITY = \"helmget\";"));
  assert.ok(virtualfs.includes("(await helmSyntaxVersion()) === HelmSyntaxVersion.V2) ? '' : 'all'"));
  assert.ok(virtualfs.includes('get ${scopearg} ${value}${revarg}'));
  assert.ok(extension.includes("registerCommand('extension.helmGet'"));
});
test('the shared protocol keeps the upstream argument shape verbatim with the deferral disclosed', async () => {
  const shared = await file('src/shared/helm-get-protocol.ts');
  for (const part of ['export function helmGetArguments(syntax: HelmSyntax, release: string, revision: number | undefined, kubeconfigPath: string)', "'--kubeconfig', kubeconfigPath, 'get'", "revision ? [`--revision=${revision}`] : []", 'SERVER-SIDE EXECUTION IS', 'never materialize files']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('no server execution surface exists yet: no adapter, reader, route, client or view for helm get', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('/v2/helm/get-release'));
  assert.ok(!bridge.includes('HelmGetClient'));
  const shared = await file('src/shared/helm-get-protocol.ts');
  assert.ok(shared.includes('HUMAN package environment'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.helmGet');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M6-E075');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/helm-get-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|queries\/helm-get|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-get-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-get-wiring.test.ts'"));
});
