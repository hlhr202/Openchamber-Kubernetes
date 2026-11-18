// Text/metadata only. The protocol ships under static review; server-side execution is deferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('pinned upstream text proves the flow: fixed name, existence gates, explicit Delete, independent deletes', async () => {
  const extension = await file('tests/fixtures/baseline/kubernetes/src/extension.ts.txt'), session = await file('tests/fixtures/baseline/kubernetes/src/debug/debugSession.ts.txt');
  assert.ok(extension.includes("registerCommand('extension.vsKubernetesRemoveDebug', removeDebugKubernetes)"));
  const remove = extension.slice(extension.indexOf('function removeDebugKubernetes()'), extension.indexOf('// There is a possible race condition'));
  assert.ok(remove.includes("const deploymentName = name + '-debug';"));
  assert.ok(remove.includes(`vscode.window.showInformationMessage(deploymentName + ': nothing to clean up')`));
  assert.ok(remove.includes("const toDelete = deployment ? ('deployment' + (service ? ' and service' : '')) : 'service';"));
  assert.ok(remove.includes('showWarningMessage(`This will delete ${toDelete} ${deploymentName}`, \'Delete\')'));
  assert.ok(remove.includes("if (opt !== 'Delete')"));
  assert.ok(remove.includes("'delete service ' + deploymentName"));
  assert.ok(remove.includes("'delete deployment ' + deploymentName"));
  assert.ok(remove.includes('Error getting confirmation of delete: ${err}'));
  assert.ok(!remove.includes('await '));
  const cleanup = session.slice(session.indexOf('private async promptForCleanup('), session.indexOf('private async cleanupResource(') + 700);
  assert.ok(cleanup.includes('Resource ${resourceId} will continue running on the cluster.'));
  assert.ok(cleanup.includes('"Clean Up", "Always Clean Up"'));
  assert.ok(cleanup.includes('this.kubectl.invokeCommand(`delete ${resourceId}`)'));
  assert.ok(cleanup.includes('Starting to clean up debug resource...'));
  assert.ok(cleanup.includes('Resource ${resourceId} is removed successfully.'));
});
test('the shared protocol keeps the upstream projections verbatim with the deferral disclosed', async () => {
  const protocol = await file('src/shared/remove-debug-protocol.ts');
  for (const part of ['return name + \'-debug\';', "return deploymentName + ': nothing to clean up';", "return hasDeployment ? ('deployment' + (hasService ? ' and service' : '')) : 'service';", 'return `This will delete ${toDelete} ${deploymentName}`;', 'return `Error getting confirmation of delete: ${err}`;', 'return `Resource ${resourceId} will continue running on the cluster.`;', "return 'Starting to clean up debug resource...';", 'return `Resource ${resourceId} is removed successfully.`;', "DELETE_BUTTON = 'Delete'", "CLEAN_UP_BUTTON = 'Clean Up'", "ALWAYS_CLEAN_UP_BUTTON = 'Always Clean Up'", "return ['delete', 'service', deploymentName];", "return ['delete', 'deployment', deploymentName];", 'SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED', 'never a generic sweep of all -debug resources', 'a failed read is never faked as absence', 'never falls through, replays or', 'reports all-success', 'never deletes someone else\'s resources', 'never auto-runs this cleanup', 'No automated execution exists anywhere']) assert.ok(protocol.includes(part), part);
  assert.ok(!/child_process|spawn|writeFile|node:path/.test(protocol));
});
test('no server execution surface exists yet: no adapter, route, client or view for debug removal', async () => {
  const routes = await file('src/service/runtime/http.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(!routes.includes('remove-debug'));
  assert.ok(!bridge.includes('RemoveDebugClient'));
});
test('the deferral is registered in coverage as a reviewed partial bound to the human package', async () => {
  const coverage = JSON.parse(await readFile(new URL('../../docs/baseline/command-coverage.json', import.meta.url), 'utf8')) as { entries: { commandId: string; implementation: string; implementationEvidence: { evidence: string } }[] };
  const entry = coverage.entries.find(e => e.commandId === 'extension.vsKubernetesRemoveDebug');
  assert.ok(entry); assert.equal(entry.implementation, 'partial');
  assert.equal(entry.implementationEvidence.evidence, 'M7-E074');
});
test('the readonly suite covers pure values only and is registered in the allowlists', async () => {
  const readonly = await file('tests/readonly/remove-debug-values.test.ts');
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|client|bridge|sdk)|\.spawn\(|child_process/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/remove-debug-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/remove-debug-wiring.test.ts'"));
});
