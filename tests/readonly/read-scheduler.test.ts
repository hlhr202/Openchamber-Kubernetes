import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { ReadScheduler } from '../../src/service/queries/read-scheduler.ts';

const code = (expected: string) => (error: unknown) => error instanceof BoundaryError && error.code === expected && error.message === expected;
const limits = { concurrency: 1, queued: 2, consumers: 4, timeoutMs: 1000 };
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test('scheduler is inert on construction; FIFO/concurrency and queue/consumer budgets are hard limits', async () => {
  const scheduler = new ReadScheduler<number>(limits);
  assert.deepEqual(scheduler.state, { closed: false, running: 0, queued: 0, consumers: 0 });
  const first = Promise.withResolvers<number>();
  const order: number[] = [];
  const a = scheduler.run(['a'], async () => { order.push(1); return first.promise; });
  const b = scheduler.run(['b'], async () => { order.push(2); return 2; });
  const c = scheduler.run(['c'], async () => { order.push(3); return 3; });
  await assert.rejects(scheduler.run(['d'], async () => 4), code('QUERY_LIMIT'));
  assert.equal(scheduler.state.running, 1);
  assert.equal(scheduler.state.queued, 2);
  first.resolve(1);
  assert.deepEqual(await Promise.all([a, b, c]), [1, 2, 3]);
  await flush();
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(scheduler.state, { closed: false, running: 0, queued: 0, consumers: 0 });
  scheduler.close();
});

test('shared read keeps independent consumers; cancelling one cannot abort another', async () => {
  const scheduler = new ReadScheduler<number>(limits);
  const pending = Promise.withResolvers<number>();
  const controller = new AbortController();
  let calls = 0;
  let producerSignal: AbortSignal | undefined;
  const load = async (signal: AbortSignal) => { calls++; producerSignal = signal; return pending.promise; };
  const a = scheduler.run(['instance-a', 'project-a', 'config-a', 'pods'], load, { signal: controller.signal });
  const b = scheduler.run(['instance-a', 'project-a', 'config-a', 'pods'], load);
  const cancelled = assert.rejects(a, code('QUERY_CANCELLED'));
  await flush();
  controller.abort(new Error('SYNTHETIC_SENSITIVE_ABORT_REASON'));
  await cancelled;
  assert.equal(producerSignal?.aborted, false);
  pending.resolve(10);
  assert.equal(await b, 10);
  assert.equal(calls, 1);
  scheduler.close();
});

test('last consumer cancellation aborts the read but does not free a still-running slot', async () => {
  const scheduler = new ReadScheduler<number>(limits);
  const pending = Promise.withResolvers<number>();
  const controller = new AbortController();
  let producerSignal: AbortSignal | undefined;
  let nextStarted = false;
  const a = scheduler.run(['a'], async signal => { producerSignal = signal; return pending.promise; }, { signal: controller.signal });
  const cancelled = assert.rejects(a, code('QUERY_CANCELLED'));
  await flush();
  controller.abort();
  await cancelled;
  const b = scheduler.run(['b'], async () => { nextStarted = true; return 2; });
  await flush();
  assert.equal(producerSignal?.aborted, true);
  assert.equal(nextStarted, false);
  assert.equal(scheduler.state.running, 1);
  pending.resolve(1);
  assert.equal(await b, 2);
  scheduler.close();
});

test('queued cancellation never invokes its loader and removes its queue/listener budget', async () => {
  const scheduler = new ReadScheduler<number>(limits);
  const pending = Promise.withResolvers<number>();
  const a = scheduler.run(['a'], () => pending.promise);
  const controller = new AbortController();
  let invoked = false;
  const b = scheduler.run(['b'], async () => { invoked = true; return 2; }, { signal: controller.signal });
  const rejected = assert.rejects(b, code('QUERY_CANCELLED'));
  controller.abort();
  await rejected;
  assert.equal(scheduler.state.queued, 0);
  pending.resolve(1);
  await a;
  await flush();
  assert.equal(invoked, false);
  scheduler.close();
});

test('timeout includes queue time; a shorter consumer deadline does not end another consumer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduler = new ReadScheduler<number>(limits);
  const pending = Promise.withResolvers<number>();
  const a = scheduler.run(['a'], () => pending.promise, { timeoutMs: 10 });
  const b = scheduler.run(['a'], () => pending.promise);
  const shortDeadline = assert.rejects(a, code('QUERY_TIMEOUT'));
  t.mock.timers.tick(10);
  await shortDeadline;
  assert.equal(scheduler.state.consumers, 1);
  let queuedInvoked = false;
  const c = scheduler.run(['c'], async () => { queuedInvoked = true; return 3; });
  const timeoutB = assert.rejects(b, code('QUERY_TIMEOUT'));
  const timeoutC = assert.rejects(c, code('QUERY_TIMEOUT'));
  t.mock.timers.tick(1000);
  await Promise.all([timeoutB, timeoutC]);
  pending.resolve(1);
  await flush();
  assert.equal(queuedInvoked, false);
  scheduler.close();
});

test('global shared-read deadline cannot be extended by new consumers; late success is discarded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduler = new ReadScheduler<number>(limits);
  const pending = Promise.withResolvers<number>();
  const a = scheduler.run(['a'], () => pending.promise);
  const failedA = assert.rejects(a, code('QUERY_TIMEOUT'));
  await flush();
  t.mock.timers.tick(900);
  const b = scheduler.run(['a'], () => pending.promise);
  const failedB = assert.rejects(b, code('QUERY_TIMEOUT'));
  t.mock.timers.tick(100);
  await Promise.all([failedA, failedB]);
  assert.equal(scheduler.state.running, 1);
  pending.resolve(8);
  await flush();
  assert.equal(scheduler.state.running, 0);
  scheduler.close();
});

test('keys partition instance/project/config/context/namespace/GVR/page identity and are tuple-safe', async () => {
  const scheduler = new ReadScheduler<string>({ ...limits, concurrency: 2 });
  const a = scheduler.run(['a/b', 'c'], async () => 'first');
  const b = scheduler.run(['a', 'b/c'], async () => 'second');
  assert.deepEqual(await Promise.all([a, b]), ['first', 'second']);
  assert.equal(await scheduler.run(['a/b', 'c'], async () => 'fresh'), 'fresh', 'completed results are not cached');
  scheduler.close();
});

test('consumer budget also bounds duplicate requests and never runs the rejected callback', async () => {
  const scheduler = new ReadScheduler<number>({ ...limits, consumers: 1 });
  const pending = Promise.withResolvers<number>();
  const a = scheduler.run(['a'], () => pending.promise);
  await assert.rejects(scheduler.run(['a'], async () => { throw new Error('must not run'); }), code('QUERY_LIMIT'));
  pending.resolve(1);
  await a;
  scheduler.close();
});

test('close rejects queued/running reads; unknown loader errors/abort reasons never escape', async () => {
  const scheduler = new ReadScheduler<number>(limits);
  const pending = Promise.withResolvers<number>();
  const a = scheduler.run(['SYNTHETIC_KEY'], () => pending.promise);
  const b = scheduler.run(['b'], async () => 2);
  const closedA = assert.rejects(a, code('SERVICE_CLOSED'));
  const closedB = assert.rejects(b, code('SERVICE_CLOSED'));
  await flush();
  scheduler.close();
  scheduler.close();
  await Promise.all([closedA, closedB]);
  await assert.rejects(scheduler.run(['a'], async () => 3), code('SERVICE_CLOSED'));
  assert.equal(JSON.stringify(scheduler.state).includes('SYNTHETIC'), false);
  pending.reject(new Error('SYNTHETIC_SECRET_NOT_FOR_DIAGNOSTICS'));
  await flush();
  const failing = new ReadScheduler<number>(limits);
  await assert.rejects(failing.run(['a'], () => { throw new Error('SYNTHETIC_SECRET'); }), code('STATE_UNAVAILABLE'));
  failing.close();
});

test('invalid limits, keys, timeouts and already-aborted consumers fail before loading', async () => {
  assert.throws(() => new ReadScheduler({ ...limits, concurrency: 0 }), code('INVALID_INPUT'));
  const scheduler = new ReadScheduler<number>(limits);
  for (const key of [[], [''], ['bad\nkey']]) await assert.rejects(scheduler.run(key, async () => 1), code('INVALID_INPUT'));
  for (const timeoutMs of [0, -1, 1001, NaN]) await assert.rejects(scheduler.run(['a'], async () => 1, { timeoutMs }), code('INVALID_INPUT'));
  await assert.rejects(scheduler.run(['a'], async () => 1, { signal: AbortSignal.abort() }), code('QUERY_CANCELLED'));
  assert.deepEqual(scheduler.state, { closed: false, running: 0, queued: 0, consumers: 0 });
  scheduler.close();
});

test('heap watermark refuses NEW consumers with QUERY_LIMIT without touching running reads', async () => {
  let pressure = false;
  const scheduler = new ReadScheduler<number>({ ...limits, heapPressure: () => ({ usedBytes: pressure ? 95 : 10, limitBytes: 100 }) });
  const pending = Promise.withResolvers<number>();
  const a = scheduler.run(['a'], () => pending.promise);
  await flush();
  pressure = true;
  await assert.rejects(scheduler.run(['b'], async () => 2), code('QUERY_LIMIT'));
  assert.equal(scheduler.state.running, 1); // the admitted read keeps its slot and finishes
  pressure = false;
  const b = scheduler.run(['b'], async () => 2);
  pending.resolve(1);
  assert.deepEqual(await Promise.all([a, b]), [1, 2]);
  scheduler.close();
});

test('a zero heap limit never trips the watermark; watermark is checked before queue admission', async () => {
  const scheduler = new ReadScheduler<number>({ ...limits, heapPressure: () => ({ usedBytes: 512, limitBytes: 0 }) });
  assert.equal(await scheduler.run(['a'], async () => 1), 1);
  scheduler.close();
  const gated = new ReadScheduler<number>({ concurrency: 1, queued: 0, consumers: 4, timeoutMs: 1000, heapPressure: () => ({ usedBytes: 100, limitBytes: 100 }) });
  await assert.rejects(gated.run(['x'], async () => 1), code('QUERY_LIMIT'));
  gated.close();
});
