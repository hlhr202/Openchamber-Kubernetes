// Text/metadata only: the forward target union and the stop-gate aggregate are verified
// structurally; real cluster resolution and gate decisions belong to human acceptance.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('the forward target union resolves Service/Deployment originals to one live backend pod', async () => {
  const query = await file('src/service/queries/forward-target.ts');
  for (const part of ["z.enum(['services', 'deployments'])", 'spec.selector', 'matchLabels', 'selectorQuery', 'shape.data.metadata.uid !== parsed.uid', 'STALE_TARGET', "page.data.items.length === 0", 'NOT_FOUND', "page.data.items.length > 1", 'CONFLICT', 'never a silent pick', "purpose: 'resource-object'", "purpose: 'resource-list'", 'labelSelector']) assert.ok(query.includes(part), part);
  const service = await file('src/service/sessions/session-service.ts');
  for (const part of ['original', 'resolveForwardTarget', "request.sessionKind === 'port-forward'", '!!request.session !== !!request.original', 'resolved.resourceVersion', 'resolved.servicePorts', 'backend']) assert.ok(service.includes(part), part);
  const reader = await file('src/service/queries/resource-reader.ts'), gateway = await file('src/service/queries/resource-gateway.ts');
  assert.ok(reader.includes("key(target, 'forward-target', randomUUID())") && reader.includes('readForwardTarget'));
  assert.ok(gateway.includes('resolveForwardTarget') && gateway.includes('forwardOriginalSchema'));
});
test('the stop-gate aggregate covers sessions and every write ledger with counts only', async () => {
  const http = await file('src/service/runtime/http.ts'), gate = await file('src/service/operations/g4-submit.ts'), session = await file('src/service/sessions/session-service.ts');
  assert.ok(http.includes("url.pathname === '/v2/status/stop-gate'"));
  for (const part of ['sessionService.gateStatus()', 'applyFiles.counts', 'imageRuns.counts', 'gitSyncs.counts', 'helmClusterWrites.counts', 'mergeKubeconfigs.counts', 'clusterOperations.counts', 'operations.counts()', 'namespaces.counts()', 'namespaceDeletes.counts()', 'contexts.counts()', 'contextDeletes.counts()', 'manifestCreates.counts()', 'manifestApplies.counts()', 'scales.counts()', 'cronJobRuns.counts()', 'exposes.counts()', 'configFileDeletes.counts()', 'configFileAdds.counts()', 'fileDeletes.counts()', 'fileSaves.counts()', 'Counts only']) assert.ok(http.includes(part), part);
  for (const part of ['inFlight', 'unknown', 'Stop-gate aggregate']) assert.ok(gate.includes(part), part);
  for (const part of ['gateStatus()', 'live:', 'detached:', 'closed:', 'leases:']) assert.ok(session.includes(part), part);
});
test('every legacy write operation exposes phase counts and the panel surfaces the gate', async () => {
  for (const name of ['delete', 'namespace', 'namespace-delete', 'context', 'context-delete', 'cronjob-run', 'expose', 'config-file-delete', 'config-file-add', 'file-delete', 'scale', 'manifest-create', 'manifest-apply', 'file-save']) {
    const code = await file(`src/service/operations/${name}.ts`);
    assert.ok(code.includes('counts()'), name);
    assert.ok(code.includes('never record content/targets'), name);
  }
  const view = await file('src/panel/sessions-debug-view.ts'), bridge = await file('src/host/bridge.ts'), main = await file('src/panel/main.ts');
  assert.ok(view.includes('setGate') && view.includes('stop-gate:'));
  assert.ok(bridge.includes("path: '/v2/status/stop-gate'"));
  assert.ok(main.includes('stopGateStatus'));
});
