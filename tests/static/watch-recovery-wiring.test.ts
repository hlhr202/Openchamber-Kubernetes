// Text review only; no worker, SDK, CLI, filesystem product adapter or operation/session imports.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('existing pinned ListOptions describes consistent snapshots and expired continuation rejection', async () => {
  const code = await file('tests/fixtures/contracts/query-contract/kubernetes/apimachinery/pkg/apis/meta/v1/types.go.txt'); assert.ok(code.includes('consistent snapshot') && code.includes('410 ResourceExpired') && code.includes('it must restart their list without the continue field'));
});
test('resource-watch runner permits only one expired-history recovery with bounded attempts/backoff and aggregate quotas', async () => {
  const code = await file('src/service/queries/watch-runner.ts'); assert.ok(code.includes("error.code !== 'CONTINUATION_EXPIRED' || recovered") && code.includes('window === 9') && code.includes('window < 10') && code.includes('delay(250'));
  assert.ok(code.includes('budget.bytes > 8_000_000') && code.includes('budget.reads > 30') && code.includes("type: 'RELISTING'") && code.includes("type: 'RESYNC'")); assert.ok(!/operations\/|sessions\/|spawn\(|setInterval/.test(code));
});
test('relist uses the existing finite read scheduler and validates every page before returning only a new cursor', async () => {
  const reader = await file('src/service/queries/resource-reader.ts'), plan = await file('src/service/queries/watch-relist.ts');
  assert.ok(reader.includes("scheduler.run(key(source.target, 'watch-relist', randomUUID())") && reader.includes('page < 20') && reader.includes('resourceVersion !== value.resourceVersion') && reader.includes('tokens.has(value.continuation)') && reader.includes('source.object && names.size !== 1'));
  assert.ok(plan.includes("purpose: source.custom ? 'custom-resource-relist' : 'resource-list'") && plan.includes('projectWatchEvent') && !/writeFile|spawn\(|fetch\(|operations\/|sessions\//.test(plan));
});
test('gateway connects relist to resource Watch only, not log/event Follow or a new execution pool', async () => {
  const gateway = await file('src/service/queries/resource-gateway.ts'), watchStart = gateway.indexOf('const watches = createWatchTasks('), watchEnd = gateway.indexOf('async function bind(', watchStart);
  assert.ok(watchStart > 0 && watchEnd > watchStart);
  assert.equal(gateway.split('reader.watchRelist(').length - 1, 2);
  assert.equal(gateway.slice(watchStart, watchEnd).split('reader.watchRelist(').length - 1, 2);
  assert.ok(gateway.slice(watchStart, watchEnd).includes('if (source.custom)') && gateway.includes('relist: (source, signal, budget) => reader.watchRelist(source, signal, budget)'));
});
test('stream callback failures settle only after worker close, before relist can acquire a finite worker slot', async () => {
  const client = await file('src/service/adapters/read-worker-client.ts'); const close = client.indexOf("worker.once('close'"); assert.ok(close > client.indexOf('worker.kill(\'SIGTERM\')')); assert.ok(client.indexOf('if (failure) reject(failure)', close) > close); assert.ok(client.includes('stop(error instanceof BoundaryError ? error'));
});
test('source policy and UI status are explicit and old source shapes do not silently gain recovery', async () => {
  const protocol = await file('src/shared/watch-protocol.ts'), bridge = await file('src/host/bridge.ts'), ui = await file('src/panel/watch-view.ts'), client = await file('src/host/watch-client.ts');
  assert.ok(protocol.includes("recoveryPolicy: z.literal('single-410-relist')") && bridge.includes("recoveryPolicy: 'single-410-relist'")); assert.ok(ui.includes('state.recovery') && ui.includes('Resynchronization and lost events are marked') && client.includes("this.#recovery = 'resynced'"));
});
test('recovery tests are allowlisted and import no real execution boundaries or write handlers', async () => {
  const tests = await file('tests/readonly/watch-recovery.test.ts'), readonly = await file('scripts/readonly-tests.ts'), statics = await file('scripts/static-tests.ts'); assert.ok(readonly.includes("'tests/readonly/watch-recovery.test.ts'") && statics.includes("'tests/static/watch-recovery-wiring.test.ts'")); assert.ok(!/from ['"].*(?:node:fs|adapters\/|operations\/|sessions\/|runtime\/|bridge|@openchamber)|spawn\(|fork\(/.test(tests));
});
