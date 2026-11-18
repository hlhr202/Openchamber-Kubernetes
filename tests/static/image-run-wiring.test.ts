// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the run flow: name/image derivation, tool commands, gated kubectl run', async () => {
  const extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt'), utils = await file('tests/fixtures/baseline/kubernetes/src/image/imageUtils.ts.txt'), registry = await file('tests/fixtures/baseline/kubernetes/src/image/imageToolRegistry.ts.txt');
  assert.ok(extension.includes('function runKubernetes()'));
  assert.ok(extension.includes('kubectl.invokeCommand(`run ${name} --image=${image}`)'));
  assert.ok(extension.includes('const name = docker.sanitiseTag(folderName);'));
  assert.ok(extension.includes('let image = `${name}:${version}`;'));
  assert.ok(extension.includes('image = `${user}/${image}`;'));
  assert.ok(extension.includes('Failed pushing the image to remote registry. Try to login to an image registry.'));
  assert.ok(extension.includes('Failed pushing the image to remote registry. Try setting vsdocker.imageUser.'));
  assert.ok(utils.includes("name.toLowerCase().replace(/[^a-z0-9._-]/g, '-');"));
  assert.ok(registry.includes('`${this.binName} build -t ${image} .`'));
  assert.ok(registry.includes('`${this.binName} bud -t ${image} .`'));
  assert.ok(registry.includes('`${this.binName} push ${image}`'));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const shared = await file('src/shared/image-run-protocol.ts');
  for (const part of ['export function sanitiseTag(name: string): string', "name.toLowerCase().replace(/[^a-z0-9._-]/g, '-')", 'export function runImageReference(folderName: string, version: string, user: string | undefined)', 'export function buildCommand(tool: ImageBuildTool, binName: string, image: string)', "'bud' : 'build'", 'export function pushCommand(binName: string, image: string)', 'export function kubectlRunArguments(name: string, image: string)', 'export function diagnosePushError(exitCode: number, error: string, hasImageUser: boolean)', 'APPROVED batch-2 G4 chain']) assert.ok(shared.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(shared));
});
test('the approved run execution surface exists and is gated: route, client and view wired', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(routes.includes('/v2/operations/image-run'));
  assert.ok(bridge.includes('ImageRunClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsKubernetesRun');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M4-E029');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/image-run-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/image-run-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/image-run-wiring.test.ts'"));
});
