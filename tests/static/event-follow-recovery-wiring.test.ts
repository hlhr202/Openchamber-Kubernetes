// Text-only checks: no actual SDK/worker/CLI/credentials, writes or session lifecycle imports.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('event recovery is mandatory source policy and strict row-free markers, not backward-shaped wire fallback', async () => {
  const protocol = await file('src/shared/event-follow-protocol.ts'), bridge = await file('src/host/bridge.ts');
  assert.ok(protocol.includes("recoveryPolicy: z.literal('single-410-relist')") && protocol.includes("'RELISTING', 'RESYNC'")); assert.ok(bridge.includes("apiVersion: page.apiVersion, recoveryPolicy: 'single-410-relist'"));
});
test('event runner only retries one stream 410 after settled transport and 250ms pause, never initial/recovery list failures', async () => {
  const code = await file('src/service/queries/event-follow-runner.ts');
  assert.ok(code.includes("error.code !== 'CONTINUATION_EXPIRED' || verificationFailed || recovered || window === 9"));
  assert.ok(code.includes("publish({ type: 'RELISTING', resourceVersion }); await pause(); await options.verify(false)") && code.includes('await snapshot(); continue;'));
  assert.ok(code.includes('delay(250') && code.includes('window < 10') && code.includes('events > 4096'));
  const worker = await file('src/service/adapters/read-worker-client.ts'); assert.ok(worker.includes("worker.once('close'") && worker.includes('if (failure) reject(failure)'));
});
test('each event snapshot starts fresh and completes one API/Namespace/opaque List RV with duplicate and page limits', async () => {
  const code = await file('src/service/queries/event-follow-runner.ts'), start = code.indexOf('const snapshot = async () =>');
  assert.ok(code.indexOf('new Set<string>()', start) > start && code.includes('result.namespace.uid !== source.namespace.uid') && code.includes('result.apiVersion !== source.apiVersion'));
  for (const check of ['result.resourceVersion !== previous.resourceVersion', 'cursors.has(result.continuation)', 'seenUids.has(uid)', 'seenNames.has(name)', 'page < eventMaximumPages', "publish({ type: 'RESYNC', resourceVersion })"]) assert.ok(code.includes(check));
});
test('recovery reuses finite reader pool, accumulated byte/read budget and static authentication, not an alternate worker deadline', async () => {
  const gateway = await file('src/service/queries/resource-gateway.ts'), reader = await file('src/service/queries/resource-reader.ts');
  assert.ok(gateway.includes('reader.eventFollowPage(source.target, source.namespace, signal, budget, source.apiVersion, previous)') && gateway.includes('reader.verifyEventFollowNamespace(source.target, source.namespace, signal, initial, budget)'));
  const list = reader.slice(reader.indexOf('async eventFollowPage('), reader.indexOf('async followRuntime(')); assert.ok(list.includes('scheduler.run(') && list.includes('eventFollowJson(input, sharedSignal, budget)'));
  assert.ok(reader.includes('budget.reads > 256') && reader.includes('8_000_000 - budget.bytes'));
});
test('RELISTING clears old UID/name rows and RESYNC only marks completed list, never removes history-gap flags', async () => {
  const buffer = await file('src/host/event-follow-buffer.ts'), client = await file('src/host/event-follow-client.ts');
  assert.ok(buffer.includes("event.type === 'RELISTING') { this.clear(true)") && buffer.includes("event.type === 'RESYNC') { this.#synchronizing = false"));
  assert.ok(client.includes('synchronizing: this.#buffer.synchronizing') && client.includes('if (page.lost) this.#buffer.clear(true)') && client.includes('page.next < page.head'));
});
test('UI explicitly shows incomplete snapshot and persistent history gap without storage/terminal or fake completeness', async () => {
  const view = await file('src/panel/event-follow-view.ts');
  assert.ok(view.includes('Synchronizing; result is incomplete') && view.includes('Incomplete history') && view.includes('state.synchronizing') && view.includes('state.truncated'));
  assert.ok(!/innerHTML|localStorage|storage\.|writeFile|setInterval|createTerminal/.test(view));
});
test('recovery tests are explicitly allowlisted and import only independent synthetic read/parameter/display boundaries', async () => {
  const code = await file('tests/readonly/event-follow-recovery.test.ts'), readonly = await file('scripts/readonly-tests.ts'), statics = await file('scripts/static-tests.ts');
  assert.ok(readonly.includes("'tests/readonly/event-follow-recovery.test.ts'") && statics.includes("'tests/static/event-follow-recovery-wiring.test.ts'"));
  assert.ok(!/from ['"].*(?:adapters\/|runtime\/|operations\/|sessions\/|bridge|@openchamber)|spawn\(|fork\(|runReadWorker\(/.test(code));
});
