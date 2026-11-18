// Static text only: never imports/runs SDK, real adapters/workers, auth/cache or operations/sessions.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (code: string, ...parts: string[]) => { let last = -1; for (const part of parts) { const next = code.indexOf(part, last + 1); assert.ok(next > last, part); last = next; } };
test('Follow uses authenticated bounded short RPCs and never puts a 50-second logs stream in an SDK request', async () => {
  const code = await file('src/service/runtime/http.ts'); ordered(code, 'authorized(request.headers.authorization', "'/v2/logs/follow/open', '/v2/logs/follow/poll', '/v2/logs/follow/release'", 'boundedBody(request, controller.signal, resourceRequestBytes)', 'options.resources.openLogFollow(input, controller.signal)');
});
test('Watch and Follow use one generic read-only engine and a shared two-stream unsettled budget', async () => {
  const gateway = await file('src/service/queries/resource-gateway.ts'), wrapper = await file('src/service/queries/watch-tasks.ts'), tasks = await file('src/service/queries/read-tasks.ts');
  assert.ok(gateway.includes('const streamBudget = createReadTaskBudget()') && gateway.includes("budget: streamBudget, kind: 'pod-log-follow'") && gateway.includes('budget: streamBudget, run: async'));
  assert.ok(wrapper.includes('createReadTasks(') && tasks.includes('if (active >= 2)') && tasks.includes('releaseBudget?.()') && tasks.includes("task.phase !== 'running'"));
  assert.ok(!/from ['"].*(?:operations\/|sessions\/|adapters\/)/.test(tasks));
});
test('Follow runner is one stream only with checked publication, idle monitor and owned read cancellation', async () => {
  const code = await file('src/service/queries/log-follow-runner.ts'); ordered(code, 'options.verify(true, signal)', 'createLogFollowDecoder(emit)', 'await options.transport(', 'await verify(); if (readSignal.aborted)', 'decoder.push(chunk)');
  assert.ok(code.includes('delay(1000') && code.includes('checks > 256') && code.includes('local.abort(failure)') && code.includes('await monitor'));
  assert.ok(!/sinceTime|for \(let window|runResourceWatch|operations\/|sessions\/|spawn\(/.test(code));
});
test('runtime proof preserves original UID and source while permitting current RV, never restarts or Job selector drift', async () => {
  const code = await file('src/service/queries/log-follow-source.ts'); assert.ok(code.includes('initial ? source.reference.resourceVersion : version.data.metadata.resourceVersion') && code.includes('projectLogContainers(pod, reference)'));
  assert.ok(code.includes('status.restartCount, membership') && code.includes('jobLogMembership(') && !/writeFile|storage\.|clipboard|fetch\(/.test(code));
});
test('runtime metadata shares the old finite pool and has aggregate read/byte limits rather than an unbounded monitor', async () => {
  const code = await file('src/service/queries/resource-reader.ts'), part = code.slice(code.indexOf('async followRuntime('), code.indexOf('async explain('));
  assert.ok(part.includes('scheduler.run(') && part.includes('budget.reads > 512') && part.includes('budget.bytes += Buffer.byteLength(text)) > 16_000_000'));
  ordered(part, 'await verify(target, sharedSignal)', 'logFollowProof(currentPod, beforeJob', 'await verify(target, sharedSignal)');
});
test('private Follow deadline exception is bounded and applies only after validated start; ordinary worker remains eight seconds', async () => {
  const worker = await file('src/service/adapters/read-worker.ts'), client = await file('src/service/adapters/read-worker-client.ts'), protocol = await file('src/service/queries/read-worker-protocol.ts');
  ordered(worker, 'const start = parseReadWorkerStart(message)', "start.request.purpose === 'pod-log-follow'", 'logFollowWorkerDeadlineMs)');
  assert.ok(protocol.includes('readWorkerDeadlineMs = 8000') && protocol.includes('logFollowWorkerDeadlineMs = 55_000') && client.includes("start.request.purpose === 'pod-log-follow' ? logFollowWorkerDeadlineMs : readWorkerDeadlineMs"));
});
test('only Follow admits the fifth follow query option; no previous, arbitrary path or implicit shell', async () => {
  const code = await file('src/service/queries/kubectl-plan.ts'), protocol = await file('src/service/queries/read-worker-protocol.ts');
  assert.ok(code.includes("const follow = request.purpose === 'pod-log-follow'") && code.includes("request.query.follow !== 'true'") && code.includes("request.purpose === 'pod-log-follow' ? '--request-timeout=50s' : '--request-timeout=7s'"));
  assert.ok(protocol.includes("value.purpose === 'pod-log-follow' || Object.keys(value.query).length <= 4"));
});
test('Follow bridge uses actual selected Pod/Job source and resets reads on existing view lifecycle, no write/session imports', async () => {
  const code = await file('src/host/bridge.ts'); assert.ok(code.includes('reference: source.reference') && code.includes('origin: source.origin') && code.includes('logFollows.reset(); showPodLogs(state)') && code.includes('logFollows.dispose()'));
  const client = await file('src/host/log-follow-client.ts'); assert.ok(client.includes('this.#text.length > 65_536') && client.includes('page.next < page.head') && client.includes('if (page.lost)') && client.includes('this.#calls >= 4'));
  assert.ok(!/from ['"].*(?:operations\/|sessions\/|service\/)/.test(client));
});
test('Follow UI requires explicit Run and renders only safe text; settings stop while Clear does not stop', async () => {
  const ui = await file('src/panel/pod-log-view.ts'), view = await file('src/panel/log-follow-view.ts');
  assert.ok(ui.includes('bridge()?.runLogFollow(selected') && ui.includes('bridge()?.stopLogFollow(); bridge()?.clearPodLog()'));
  assert.ok(view.includes('viewer.show(state.text,') && view.includes('mountLogTextView(') && !/innerHTML|sendMessage|createElement\('a'\)|setInterval/.test(view));
});
test('Follow tests are allowlisted and cannot reach real worker/SDK/bridge, cached auth or operation/session control', async () => {
  const code = await file('tests/readonly/log-follow.test.ts'), allowlist = await file('scripts/readonly-tests.ts'); assert.ok(allowlist.includes("'tests/readonly/log-follow.test.ts'"));
  assert.ok(!/from ['"].*(?:adapters\/|operations\/|sessions\/|runtime\/|bridge)/.test(code) && !/spawn\(|fork\(|readThroughWorker\(|runReadWorker\(/.test(code));
});
