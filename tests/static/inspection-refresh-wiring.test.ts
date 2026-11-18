// Source text only; never imports/runs bridge/SDK, actual worker/cache or any write handler.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (code: string, ...parts: string[]) => { let offset = -1; for (const part of parts) { const at = code.indexOf(part, offset + 1); assert.ok(at > offset, part); offset = at; } };

test('global current metadata is projected from the whole parsed snapshot before contexts are sliced', async () => {
  const page = await file('src/service/queries/config-page.ts'), schema = await file('src/shared/protocol.ts');
  ordered(page, 'snapshot.contexts.find(context => context.active)', 'currentContextInfo: current ?', 'contexts: rows.slice(');
  assert.ok(schema.includes('currentContextInfo: z.object(') && schema.includes('value.currentContextInfo.name === value.currentContext') && schema.includes('value.currentContextInfo.available === context.available'));
});
test('configuration client refuses same-identity current-summary drift on later pages', async () => {
  const client = await file('src/host/configuration-client.ts');
  assert.ok(client.includes('JSON.stringify(config.currentContextInfo) !== JSON.stringify(this.#config?.currentContextInfo)'));
});
test('bridge and diagnostics use global current metadata rather than a visible row while preserving ready/availability gates', async () => {
  const bridge = await file('src/host/bridge.ts'), panel = await file('src/panel/main.ts'), schema = await file('src/shared/protocol.ts');
  ordered(bridge.slice(bridge.indexOf('function target()')), "current?.phase === 'ready'", 'configurationReadTarget(config, `${viewId}:${projectRevision}`)');
  assert.ok(panel.includes('state.config?.currentContextInfo?.available') && schema.includes("config.status !== 'ready'") && schema.includes('!config.currentContextInfo?.available'));
  assert.ok(!bridge.includes('contexts.find(item => item.active && item.available)'));
});
test('read-only refreshed reference capture preserves original identity and does not modify exact-RV write validation', async () => {
  const code = await file('src/service/queries/inspection-reference.ts'), parent = await file('src/service/queries/parent-resource.ts');
  ordered(code, '...original, resourceVersion: refresh ?', 'verifyResourceObject(input, reference.data.type, reference.data)', 'Object.freeze(reference.data)');
  assert.ok(parent.includes('metadata.uid !== reference.uid || metadata.resourceVersion !== reference.resourceVersion'));
  assert.ok(!/operations\/|adapters\/|writeFile|spawn\(|fork\(/.test(code));
});
test('refreshed reader captures same-UID current RV before CLI and checks that exact RV afterward before publication', async () => {
  const code = await file('src/service/queries/resource-reader.ts'), inspect = code.slice(code.indexOf('async inspect('), code.indexOf('async namespaceInventory('));
  ordered(inspect, 'await verify(target, sharedSignal)', 'captureInspectionReference(', 'plan.reference, refresh)', "mode === 'wide' ? 'resource-wide' : 'resource-describe'", 'verifyResourceObject(', 'current.type, current)', 'await verify(target, sharedSignal)', 'project(text, current)');
});
test('new snapshot bindings are normalized to observed reference without refresh flag; continuations still verify exact reference', async () => {
  const code = await file('src/service/queries/inspection-output.ts'), schema = await file('src/shared/inspection-protocol.ts');
  ordered(code.slice(code.indexOf('const project =')), 'const source = inspectionRequestSchema.parse(', 'reference: reference ?? request.reference', 'sameInspectionObject(', 'JSON.stringify(source)', 'page(source, id, item, 0)');
  assert.ok(code.includes('reader.verifyReference(request.target, request.reference, signal)') && schema.includes('!value.refresh || !value.cursor'));
});
test('client explicitly requests refresh and updates only validated private reference after output integrity checks', async () => {
  const code = await file('src/host/inspection-client.ts');
  assert.ok(code.includes('{ ...this.#source, refresh: true }') && code.includes('request.refresh ? sameInspectionObject(page.reference, request.reference)'));
  ordered(code, 'const text = continuation ?', 'bytes !== page.totalBytes', 'reference: page.reference', 'this.#page = page');
});
test('new current-target/refresh tests are explicit read-only allowlist members with no write or actual runtime imports', async () => {
  const allowlist = await file('scripts/readonly-tests.ts');
  for (const path of ['tests/readonly/current-target.test.ts', 'tests/readonly/inspection-refresh.test.ts']) {
    assert.ok(allowlist.includes(`'${path}'`)); const code = await file(path);
    assert.ok(!/from ['"].*(?:adapters\/|operations\/|runtime\/|bridge|namespace-client|preference-client)/.test(code) && !/spawn\(|fork\(|readThroughWorker\(|runReadWorker\(/.test(code));
  }
});
