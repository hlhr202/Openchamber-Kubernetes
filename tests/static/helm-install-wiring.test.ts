// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves install runs with resolved namespace and generate-name, then extracts the release name', async () => {
  const exec = await file('tests/fixtures/baseline/kubernetes/src/helm.exec.ts.txt'), extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt');
  assert.ok(exec.includes('export async function helmInstall(kubectl: Kubectl, helmObject: helmrepoexplorer.HelmObject | undefined): Promise<void>'));
  assert.ok(exec.includes('const ns = await currentNamespace(kubectl);'));
  assert.ok(exec.includes("const nsArg = ns ? `--namespace ${ns}` : '';"));
  assert.ok(exec.includes("helmExecAsync(`install ${chartId} ${versionArg} ${nsArg} ${generateNameArg}`)"));
  assert.ok(exec.includes('const releaseName = extractReleaseName(sr.stdout);'));
  assert.ok(exec.includes('const HELM_INSTALL_NAME_HEADER = "NAME:";'));
  assert.ok(exec.includes("return '(unknown)';"));
  assert.ok(extension.includes("registerCommand('extension.helmInstall'"));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const shared = await file('src/shared/helm-install-protocol.ts');
  for (const part of ['export function installGenerateName(syntax: HelmSyntax)', "syntax === 'v3' || syntax === 'v4'", 'export function helmInstallArguments(syntax: HelmSyntax, chart: string, version: string | undefined, namespace: string, kubeconfigPath: string)', "'--kubeconfig', kubeconfigPath, 'install'", "'--namespace', namespace", "const HELM_INSTALL_NAME_HEADER = 'NAME:'", "return '(unknown)';", 'SERVER-SIDE EXECUTION IS']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('no server execution surface exists yet: no adapter, route, client or view for helm install', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts'), shared = await file('src/shared/helm-install-protocol.ts');
  assert.ok(!routes.includes('/v2/helm/install'));
  assert.ok(!bridge.includes('HelmInstallClient'));
  assert.ok(shared.includes('materialize credentials to disk'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.helmInstall');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M6-E076');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/helm-install-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|queries\/helm|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/helm-install-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/helm-install-wiring.test.ts'"));
});
