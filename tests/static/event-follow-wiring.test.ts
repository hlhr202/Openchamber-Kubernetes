// Source text review only. Do not import/run SDK, workers/adapters, auth/cache or operation/session lifecycle.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (code: string, ...parts: string[]) => { let last = -1; for (const part of parts) { const next = code.indexOf(part, last + 1); assert.ok(next > last, part); last = next; } };
test('Follow Events uses authenticated bounded JSON RPCs, not a raw long-lived SDK response', async () => {
  const code = await file('src/service/runtime/http.ts'); ordered(code, 'authorized(request.headers.authorization', "'/v2/events/follow/open', '/v2/events/follow/poll', '/v2/events/follow/release'", 'boundedBody(request, controller.signal, resourceRequestBytes)', 'options.resources.openEventFollow(input, controller.signal)');
});
test('Event Follow consumes the same two-stream budget and common read-task engine without a new worker lifetime exception', async () => {
  const gateway = await file('src/service/queries/resource-gateway.ts'); assert.ok(gateway.includes("budget: streamBudget, kind: 'event-follow'") && gateway.includes('eventFollows.close()') && gateway.includes('eventFollows.release(input)'));
  const worker = await file('src/service/adapters/read-worker.ts'); assert.ok(worker.includes("start.request.purpose === 'namespace-event-watch' || start.request.purpose === 'job-pod-watch' ? sendChunk : undefined"));
  const deadline = worker.slice(worker.indexOf('const start = parseReadWorkerStart(message)'), worker.indexOf('snapshot = start.snapshot')); assert.ok(!deadline.includes('namespace-event-watch'));
});
test('Namespace verification is fresh in the original finite pool with initial exact RV and subsequent same UID only', async () => {
  const reader = await file('src/service/queries/resource-reader.ts'), part = reader.slice(reader.indexOf('async verifyEventFollowNamespace('), reader.indexOf('async followRuntime('));
  assert.ok(part.includes('scheduler.run(') && part.includes('initial ? namespace : undefined') && part.includes('current.uid !== namespace.uid'));
  assert.ok(reader.includes('budget.reads > 256') && reader.includes('8_000_000 - budget.bytes'));
});
test('initial event LIST completes bounded continuation before watch at the same opaque RV, with one explicit 410 recovery only', async () => {
  const code = await file('src/service/queries/event-follow-runner.ts'); ordered(code, 'await options.verify(true)', 'page < eventMaximumPages', 'await options.list(previous)', "type: 'SEED'", 'window < 10', 'planEventFollow(source, resourceVersion)');
  assert.ok(code.includes('result.resourceVersion !== previous.resourceVersion') && code.includes('cursors.has(result.continuation)') && code.includes('delay(250') && code.includes('events > 4096'));
  assert.ok(!/sessions\/|operations\/|spawn\(|setInterval|ECONNRESET/.test(code));
});
test('event projection requires the bound API Event and exact namespace, strips raw extensions and maps Status failures before reflecting bodies', async () => {
  const code = await file('src/service/queries/event-follow-source.ts'); assert.ok(code.includes("apiVersion: z.literal(apiVersion), kind: z.literal('Event')") && code.includes('projectEventRow(event.object, namespace, apiVersion)') && code.includes('requireReadSuccess(status.data.code)'));
  assert.ok(!/innerHTML|writeFile|storage\.|message:.*Status/.test(code));
});
test('common read-task admission rejects oversized single events before sequence/head progress, fixing undrainable ring entries', async () => {
  const code = await file('src/service/queries/read-tasks.ts'); ordered(code, 'const parsed = options.eventSchema.safeParse(', 'if (bytes > 32_000)', 'freeze(parsed.data); task.sequence++');
  assert.ok(code.includes('head: task.sequence') && code.includes('task.bytes > 65_536'));
});
test('view projection replaces counts by UID, handles old-UID deletion and bounds current rows/bytes instead of accumulating an audit archive', async () => {
  const code = await file('src/host/event-follow-buffer.ts'); assert.ok(code.includes("event.type === 'DELETED'") && code.includes('prior && prior !== row.uid') && code.includes('this.#rows.size > 200 || this.#bytes > 256_000'));
  assert.ok(!/count\s*\+=|parseInt\(.*resourceVersion|Date\.now|operations\/|sessions\//.test(code));
});
test('Follow Events has an explicit ready-page entry, inherits target reset, renders messages as text and never opens a terminal', async () => {
  const bridge = await file('src/host/bridge.ts'), view = await file('src/panel/event-follow-view.ts');
  assert.ok(bridge.includes('namespace: page.namespace') && bridge.includes('eventFollows.reset(); showEvents(state)') && bridge.includes('eventFollows.dispose()'));
  assert.ok(view.includes('td.textContent = logDisplayText(text)') && !/innerHTML|clipboard|sendMessage|createElement\('a'\)|setInterval/.test(view));
});
test('SDK Event Follow client enforces original binding, four unsettled requests, sequence/head drain and explicit gap reset', async () => {
  const code = await file('src/host/event-follow-client.ts'); assert.ok(code.includes('this.#calls >= 4') && code.includes('JSON.stringify(page.source) !== JSON.stringify(source)') && code.includes('this.#buffer.clear(true)') && code.includes('page.next < page.head'));
  assert.ok(!/from ['"].*(?:service\/|operations\/|sessions\/)/.test(code));
});
test('Event Follow automated tests are allowlisted and never reach real workers, cache/auth or operation/session control', async () => {
  const code = await file('tests/readonly/event-follow.test.ts'), allowlist = await file('scripts/readonly-tests.ts'); assert.ok(allowlist.includes("'tests/readonly/event-follow.test.ts'"));
  assert.ok(!/from ['"].*(?:adapters\/|runtime\/|operations\/|sessions\/|bridge)/.test(code) && !/spawn\(|fork\(|runReadWorker\(|readThroughWorker\(/.test(code));
});
