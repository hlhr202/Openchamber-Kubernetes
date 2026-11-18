import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('default Job choice uses authenticated bounded short task endpoints, never a long SDK call', async () => {
  const code = await file('src/service/runtime/http.ts'); assert.ok(code.indexOf('authorized(request.headers.authorization') < code.indexOf("'/v2/logs/job/open'")); assert.ok(code.includes('options.resources.openJobLogSelection(input, controller.signal)') && code.includes('options.resources.releaseJobLogSelection(input)'));
});
test('all four read-task kinds share two actual unsettled slots and owned close, no new timeout exception', async () => {
  const code = await file('src/service/queries/resource-gateway.ts'), worker = await file('src/service/adapters/read-worker.ts'); assert.ok(code.includes("budget: streamBudget, kind: 'job-log-selection'") && code.includes('jobSelections.close()'));
  assert.ok(worker.includes("start.request.purpose === 'job-pod-watch' ? sendChunk : undefined")); const deadline = worker.slice(worker.indexOf('const start = parseReadWorkerStart(message)'), worker.indexOf('snapshot = start.snapshot')); assert.ok(!deadline.includes('job-pod-watch'));
});
test('Job selector and Pod metadata checks use original finite scheduler and aggregate budget, no public raw rank keys', async () => {
  const code = await file('src/service/queries/resource-reader.ts'); assert.ok(code.includes("'job-log-candidates', randomUUID()") && code.includes('eventFollowJson(input, sharedSignal, budget)') && code.includes('jobLogMembership(job, pod, target, current.origin, selected)'));
  const dto = await file('src/shared/job-log-selection-protocol.ts'); assert.ok(!/selector|restartCount|nodeName|labels|spec:|status:/.test(dto));
});
test('selection scans all bounded pages before choice and waits from original list RV without automatic relist', async () => {
  const code = await file('src/service/queries/job-log-selection-runner.ts'); assert.ok(code.includes('page < 20') && code.includes('compareJobLogCandidates(value, best) < 0') && code.includes('window < 10') && code.includes("throw new BoundaryError('QUERY_TIMEOUT')"));
  assert.ok(code.includes("error.code !== 'QUERY_CANCELLED'") && !/operations\/|sessions\/|spawn\(|setInterval/.test(code));
});
test('pinned ByLogging file is added without dropping existing source evidence', async () => {
  const code = await file('scripts/collect-query-contract.ts'); assert.ok(code.includes('pkg/util/podutils/podutils.go') && code.includes("evidence: 'M1-E049'") && code.includes('Existing pinned source omitted from collection'));
});
test('client admits a handoff only for completed source-bound single choice and retains four unsettled request cap', async () => {
  const code = await file('src/host/job-log-selection-client.ts'); assert.ok(code.includes('this.#calls >= 4') && code.includes('page.head > 1') && code.includes("page.phase === 'completed' && this.#choice") && code.includes('JSON.stringify(page.source) !== JSON.stringify(source)'));
  assert.ok(!/operations\/|sessions\/|service\/|storage\.|console\./.test(code));
});
test('Job diagnostic default entry and explicit selector picker coexist; handoff loads actual Pod containers, not logs or PTY', async () => {
  const panel = await file('src/panel/main.ts'), bridge = await file('src/host/bridge.ts'), ui = await file('src/panel/job-log-selection-view.ts');
  assert.ok(panel.includes('bridge?.openJobLog(origin)') && panel.includes("'Select Job log Pod'")); assert.ok(bridge.includes("reference: selected.reference, kind: 'containers'") && bridge.includes('jobSelections.reset()') && bridge.includes('jobSelections.dispose()'));
  assert.ok(ui.includes('status.textContent =') && !/innerHTML|clipboard|sendMessage|setInterval/.test(ui));
});
test('automatic Job-choice tests remain allowlisted synthetic reads, never real worker/SDK/cache/writes', async () => {
  const code = await file('tests/readonly/job-log-selection.test.ts'), allowlist = await file('scripts/readonly-tests.ts'); assert.ok(allowlist.includes("'tests/readonly/job-log-selection.test.ts'"));
  assert.ok(!/from ['"].*(?:adapters\/|runtime\/|operations\/|sessions\/|bridge|@openchamber)/.test(code) && !/spawn\(|fork\(|runReadWorker\(|readThroughWorker\(/.test(code));
});
