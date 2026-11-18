// Text/metadata only. Never import or invoke the G4 ledger, HTTP runtime or any write adapter.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
test('the universal G4 submit gate keeps the audited chain: view, 60s confirmation, single dispatch, original ledger', async () => {
  const code = await file('src/service/operations/g4-submit.ts');
  for (const part of [
    'g4ViewLifetimeMs', 'g4ConfirmationLifetimeMs', 'g4PruneDue(record.outcome, now)',
    'options.lock.run(record.controller.signal', "update(record, 'dispatching')",
    'queued.length >= g4Limits.queued', 'running < g4Limits.running',
    "update(record, result.outcome, result.code, result.details)", "readonly outcome: 'accepted' | 'failed' | 'unknown'", "record.outcome.phase === 'dispatching' ? 'unknown'",
    'timingSafeEqual', 'CONFIRMATION_EXPIRED', "phase !== 'prepared'", "!equal(Buffer.from(record.proof), proof)",
  ]) assert.ok(code.includes(part), part);
  assert.ok(code.includes('Unknown records are never silently evicted'));
  assert.ok(code.includes('Dispatch may already have reached the API. Never kill it, retry it, or claim it was undone.'));
  assert.ok(!/records\.delete\(.*unknown|setInterval|console\.|writeFile|process\.env/.test(code));
  const imports = [...new Set([...code.matchAll(/from '\.\.\/\.\.\/shared\/([a-z0-9-]+\.ts)'/g)].map(match => match[1]))];
  assert.deepEqual(imports, ['errors.ts', 'g4-submit-protocol.ts', 'configuration.ts', 'identity.ts']);
  assert.ok(code.includes("from 'node:crypto'"));
});
test('shared gate constants are pure and the read graph cannot reach the stateful ledger', async () => {
  const shared = await file('src/shared/g4-submit-protocol.ts');
  for (const part of ['g4ViewGrantSchema', 'g4Limits', 'Object.freeze']) assert.ok(shared.includes(part), part);
  assert.ok(!/execFile|spawn|writeFile|console\./.test(shared));
  const check = await file('scripts/check-static.ts');
  assert.ok(check.includes('operations|sessions|runtime')); // graph rule still forbids read -> operations
  const readonly = await file('tests/readonly/g4-submit-values.test.ts');
  assert.ok(!/from ['"].*operations|from ['"].*adapters|from ['"].*runtime/.test(readonly));
  assert.ok((await file('scripts/readonly-tests.ts')).includes("'tests/readonly/g4-submit-values.test.ts'"));
  assert.ok((await file('scripts/static-tests.ts')).includes("'tests/static/g4-submit-wiring.test.ts'"));
});
test('the HTTP runtime enforces process-level in-flight request/body budgets and a v8 heap watermark', async () => {
  const http = await file('src/service/runtime/http.ts');
  for (const part of [
    'getHeapStatistics', 'heapWatermarkFraction = 0.9', 'inFlightRequestLimit = 64', 'inFlightBodyBudgetBytes = 8 * 1024 * 1024',
    'inFlight.requests >= inFlightRequestLimit || heapAboveWatermark()', "respond(response, 429, { error: { code: 'QUERY_LIMIT' } })",
    'inFlight.bodyBytes += chunk.byteLength', 'inFlight.bodyBytes > inFlightBodyBudgetBytes', 'inFlight.bodyBytes -= bytes', 'inFlight.requests--',
  ]) assert.ok(http.includes(part), part);
  const ordered = http.indexOf('inFlight.requests >= inFlightRequestLimit') > http.indexOf('authorized(request.headers.authorization');
  assert.ok(ordered, 'admission budget is checked after authentication');
  const scheduler = await file('src/service/queries/read-scheduler.ts');
  for (const part of ['getHeapStatistics', 'heapWatermarkFraction = 0.9', 'heapPressure', "new BoundaryError('QUERY_LIMIT')"]) assert.ok(scheduler.includes(part), part);
  assert.ok(scheduler.indexOf('heap.usedBytes > heapWatermarkFraction * heap.limitBytes') < scheduler.indexOf('const timeout = options.timeoutMs'));
});
test('the heap guard refusal path is covered by an injectable probe in the readonly scheduler suite', async () => {
  const test = await file('tests/readonly/read-scheduler.test.ts');
  assert.ok(test.includes('heapPressure'));
  assert.ok(test.includes('QUERY_LIMIT'));
});
