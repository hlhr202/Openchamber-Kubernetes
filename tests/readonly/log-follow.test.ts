// Synthetic read tasks, Pod/Job metadata and bytes only. No worker/CLI/SDK/bridge, auth/cache or operation/session imports.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { logFollowSourceSchema, logFollowOpenSchema, logFollowEventSchema, logFollowPageSchema } from '../../src/shared/log-follow-protocol.ts';
import type { LogFollowSource, LogFollowEvent, LogFollowPage } from '../../src/shared/log-follow-protocol.ts';
import { logDisplayText } from '../../src/shared/pod-log-protocol.ts';
import { createLogFollowDecoder, logFollowProof, planLogFollow } from '../../src/service/queries/log-follow-source.ts';
import { runLogFollow } from '../../src/service/queries/log-follow-runner.ts';
import { createReadTasks, createReadTaskBudget } from '../../src/service/queries/read-tasks.ts';
import { createWatchTasks } from '../../src/service/queries/watch-tasks.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { parseReadWorkerStart, readWorkerDeadlineMs, logFollowWorkerDeadlineMs } from '../../src/service/queries/read-worker-protocol.ts';
import { LogFollowClient } from '../../src/host/log-follow-client.ts';
import type { LogFollowState } from '../../src/host/log-follow-client.ts';

const source: LogFollowSource = { protocol: 2, target: { serviceGeneration: 's', projectId: 'p', configIdentity: 'config', context: 'active', namespace: 'default' }, selection: { mode: 'default' },
  reference: { resource: 'pods', namespace: 'default', name: 'pod', uid: 'pod-u', resourceVersion: '1' }, container: 'app', options: { timestamps: false, sinceSeconds: null, tailLines: null } };
const jobSource: LogFollowSource = { ...source, origin: { resource: 'jobs', namespace: 'default', name: 'job', uid: 'job-u', resourceVersion: 'j1' } };
const pod = () => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod', namespace: 'default', uid: 'pod-u', resourceVersion: '1', labels: { app: 'one' } }, spec: { initContainers: [{ name: 'init' }], containers: [{ name: 'app' }] },
  status: { initContainerStatuses: [{ name: 'init', restartCount: 0, containerID: 'runtime://init', state: { terminated: { containerID: 'runtime://init' } } }], containerStatuses: [{ name: 'app', restartCount: 0, containerID: 'runtime://one', state: { running: {} } }] } });
const job = () => ({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'job', namespace: 'default', uid: 'job-u', resourceVersion: 'j1' }, spec: { selector: { matchLabels: { app: 'one' } } } });
const signal = () => new AbortController().signal;
const open = (view = 'a', epoch = 1, value = source) => ({ ...value, consumer: { view: view.repeat(32), epoch } });
const control = (page: LogFollowPage, after = 0) => ({ protocol: 2, handle: page.handle, after });
const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function registry(budget?: ReturnType<typeof createReadTaskBudget>) {
  let now = 0; const runs: Array<{ emit: (event: Omit<LogFollowEvent, 'sequence'>) => void; signal: AbortSignal; done: ReturnType<typeof Promise.withResolvers<void>> }> = [];
  const tasks = createReadTasks({ generation: 's', sourceSchema: logFollowSourceSchema, eventSchema: logFollowEventSchema, pageSchema: logFollowPageSchema, kind: 'pod-log-follow', ...(budget ? { budget } : {}), clock: () => now,
    run: async (_source, signal, emit) => { const done = Promise.withResolvers<void>(); runs.push({ signal, emit, done }); await done.promise; } });
  return { tasks, runs, time(value: number) { now = value; tasks.sweep(); }, close() { tasks.close(); for (const run of runs) run.done.resolve(); } };
}
test('Follow source is strict metadata/options only and consumes the same real Pod/Job origin selection', () => {
  assert.ok(logFollowOpenSchema.safeParse(open()).success); assert.ok(logFollowSourceSchema.safeParse(jobSource).success);
  for (const change of [{ previous: true }, { text: 'SYNTHETIC_SECRET' }, { argv: ['exec'] }, { options: { ...source.options, follow: true } }, { origin: { ...jobSource.origin, namespace: 'other' } }]) assert.equal(logFollowSourceSchema.safeParse({ ...source, ...change }).success, false);
});
test('Follow plan is one original namespace/container raw logs API stream, no terminal/log replay or exec', () => {
  const request = planLogFollow({ ...source, options: { timestamps: true, sinceSeconds: 5, tailLines: 20 } });
  assert.equal(request.path, '/api/v1/namespaces/default/pods/pod/log'); assert.deepEqual(request.query, { container: 'app', timestamps: 'true', follow: 'true', sinceSeconds: '5', tailLines: '20' });
  const args = kubectlReadArguments(request, '/synthetic/pipe'); assert.ok(args.includes('--request-timeout=50s')); assert.equal(args.includes('exec'), false); assert.equal(args.includes('logs'), false);
});
test('Follow private IPC accepts five exact query options but never broadens ordinary finite reads', () => {
  const request = planLogFollow({ ...source, options: { timestamps: true, sinceSeconds: 1, tailLines: 1 } }), input = { protocol: 1, kind: 'read', request, path: '/synthetic/bin', snapshot: new Uint8Array([1]) };
  assert.equal(parseReadWorkerStart(input).request.purpose, 'pod-log-follow');
  for (const change of [{ purpose: 'pod-logs' }, { maximumBytes: 8_000_000 }, { query: { ...request.query, follow: 'false' } }, { query: { ...request.query, previous: 'true' } }, { path: '/api/v1/namespaces/default/pods/pod/exec' }]) assert.throws(() => parseReadWorkerStart({ ...input, request: { ...request, ...change } }));
  assert.equal(readWorkerDeadlineMs, 8000); assert.equal(logFollowWorkerDeadlineMs, 55_000);
});
test('initial runtime proof is exact Pod UID/RV and selected real container identity', () => {
  assert.equal(typeof logFollowProof(pod(), undefined, source, true), 'string');
  const value = pod(); value.metadata.resourceVersion = '2'; assert.throws(() => logFollowProof(value, undefined, source, true), /STALE_TARGET/);
  value.metadata.uid = 'replacement'; assert.throws(() => logFollowProof(value, undefined, source, false), /STALE_TARGET/);
});
test('same Pod UID may change RV and running→terminated without treating the original source as a new container', () => {
  const before = logFollowProof(pod(), undefined, source, true), value = pod(); value.metadata.resourceVersion = '2';
  assert.equal(logFollowProof(value, undefined, source, false), before);
  const ended = { ...value, status: { ...value.status, containerStatuses: [{ name: 'app', restartCount: 0, containerID: 'runtime://one', state: { terminated: { containerID: 'runtime://one' } } }] } };
  assert.equal(logFollowProof(ended, undefined, source, false), before);
});
test('restart count, container ID and selected container kind change invalidate runtime proof', () => {
  const before = logFollowProof(pod(), undefined, source, true), value = pod(); value.status.containerStatuses[0]!.restartCount = 1;
  assert.notEqual(logFollowProof(value, undefined, source, false), before); value.status.containerStatuses[0]!.restartCount = 0; value.status.containerStatuses[0]!.containerID = 'runtime://two'; assert.notEqual(logFollowProof(value, undefined, source, false), before);
  assert.notEqual(logFollowProof(pod(), undefined, { ...source, container: 'init' }, true), before);
});
test('missing, waiting or duplicate container runtime metadata fails explicitly instead of mixing runs', () => {
  for (const statuses of [[], [{ name: 'app', restartCount: 0, state: { waiting: {} } }], [{ name: 'app', restartCount: 0, state: { running: {} } }], [pod().status.containerStatuses[0], pod().status.containerStatuses[0]]]) assert.throws(() => logFollowProof({ ...pod(), status: { containerStatuses: statuses } }, undefined, source, false));
  assert.throws(() => logFollowProof(pod(), undefined, { ...source, container: 'missing' }, false), /NOT_FOUND/);
});
test('Job origin permits same UID RV advance, but selector/membership/UID drift never changes actual log source silently', () => {
  const before = logFollowProof(pod(), job(), jobSource, true), value = job(); value.metadata.resourceVersion = 'j2'; assert.equal(logFollowProof(pod(), value, jobSource, false), before);
  value.metadata.uid = 'replacement'; assert.throws(() => logFollowProof(pod(), value, jobSource, false), /STALE_TARGET/);
  value.metadata.uid = 'job-u'; value.spec.selector.matchLabels.app = 'other'; assert.throws(() => logFollowProof(pod(), value, jobSource, false), /STALE_TARGET/);
});
test('UTF-8 decoder emits genuine increments before EOF and splits safely at surrogate boundaries', () => {
  const values: string[] = [], decoder = createLogFollowDecoder(event => values.push(event.text)), bytes = Buffer.from('hello🌏\n');
  decoder.push(bytes.subarray(0, 7)); assert.equal(values.join(''), 'hello'); decoder.push(bytes.subarray(7)); assert.equal(values.join(''), 'hello🌏\n'); decoder.finish();
  const output: string[] = [], second = createLogFollowDecoder(e => output.push(e.text)); second.push(Buffer.from('a'.repeat(4095) + '🌏end')); second.finish(); assert.deepEqual(output, ['a'.repeat(4095), '🌏end']);
});
test('invalid/truncated UTF-8 poisons the stream instead of showing replacement characters as valid logs', () => {
  const decoder = createLogFollowDecoder(() => {}); decoder.push(new Uint8Array([0xf0])); assert.throws(() => decoder.finish(), /CONTENT_INVALID/); assert.throws(() => decoder.push(Buffer.from('next')), /STATE_UNAVAILABLE/);
});
test('empty logs complete empty; stream byte/chunk budgets fail rather than fake a complete snapshot', () => {
  let count = 0; const decoder = createLogFollowDecoder(() => { count++; }); decoder.finish(); assert.equal(count, 0);
  const big = createLogFollowDecoder(() => {}); assert.throws(() => big.push(new Uint8Array(2_000_001)), /BUDGET_EXCEEDED/);
  const fragmented = createLogFollowDecoder(() => {}); assert.throws(() => { for (let n = 0; n < 2049; n++) fragmented.push(Buffer.from('x')); }, /BUDGET_EXCEEDED/);
});
test('one Follow transport yields chunks before completion and never reconnects or replays since/tail', async () => {
  let calls = 0, ended = false; const chunks: string[] = [];
  await runLogFollow(source, signal(), event => { assert.equal(ended, false); chunks.push(event.text); }, { verify: async () => 'same', transport: async (_selection, _request, _signal, emit) => { calls++; await emit(Buffer.from('first\n')); await emit(Buffer.from('second\n')); ended = true; } });
  assert.equal(calls, 1); assert.equal(chunks.join(''), 'first\nsecond\n');
});
test('runtime drift on a received chunk discards it before any visible text is emitted', async () => {
  let changed = false, chunks = 0;
  await assert.rejects(runLogFollow(source, signal(), () => { chunks++; }, { verify: async () => changed ? 'new' : 'old', transport: async (_selection, _request, _signal, emit) => { changed = true; await emit(Buffer.from('DO_NOT_PUBLISH')); } }), /STALE_TARGET/); assert.equal(chunks, 0);
});
test('idle monitor cancels only the owned read stream when runtime or target drifts', async () => {
  let changed = false, monitorWake: (() => void) | undefined, reads = 0; const started = Promise.withResolvers<void>();
  const running = runLogFollow(source, signal(), () => {}, { verify: async () => { reads++; return changed ? 'new' : 'old'; }, wait: async input => new Promise<void>(resolve => { monitorWake = resolve; input.addEventListener('abort', () => resolve(), { once: true }); }),
    transport: async (_selection, _request, input) => { started.resolve(); await new Promise<void>(resolve => input.addEventListener('abort', () => resolve(), { once: true })); } });
  await started.promise; changed = true; monitorWake?.(); await assert.rejects(running, /STALE_TARGET/); assert.equal(reads, 2);
});
test('Follow auth/permission errors are fixed failures with no automatic retry', async () => {
  let calls = 0; await assert.rejects(runLogFollow(source, signal(), () => {}, { verify: async () => 'same', transport: async () => { calls++; throw new BoundaryError('FORBIDDEN'); } }), /FORBIDDEN/); assert.equal(calls, 1);
});
test('Follow verification call budget is bounded even when one-byte chunks arrive rapidly', async () => {
  let emits = 0; await assert.rejects(runLogFollow(source, signal(), () => { emits++; }, { verify: async () => 'same', transport: async (_selection, _request, _signal, emit) => { for (let n = 0; n < 257; n++) await emit(Buffer.from('x')); } }), /BUDGET_EXCEEDED/); assert.equal(emits, 256);
});
test('shared Follow consumers retain independent cursors and Stop leaves a peer alive until the last lease/release', async () => {
  const f = registry(); try { const a = f.tasks.open(open()), b = f.tasks.open(open('b')); await tick(); assert.equal(f.runs.length, 1); f.runs[0]?.emit({ text: 'SYNTHETIC_LOG' }); assert.equal(f.tasks.poll(control(a)).events[0]?.text, 'SYNTHETIC_LOG');
    f.tasks.release(control(a)); assert.equal(f.runs[0]?.signal.aborted, false); f.time(15_000); assert.equal(f.runs[0]?.signal.aborted, true); assert.throws(() => f.tasks.release(control(b)), /VIEW_EXPIRED/);
  } finally { f.close(); }
});
test('Watch and Follow share two unsettled stream slots, including cancelled-but-not-settled reads', async () => {
  const budget = createReadTaskBudget(), f = registry(budget), watches = createWatchTasks({ generation: 's', budget, run: async (_source, input) => { await new Promise<void>(resolve => input.addEventListener('abort', () => resolve(), { once: true })); } });
  try { const a = f.tasks.open(open()); f.tasks.open(open('b', 1, { ...source, container: 'init' })); await tick();
    const watch = { protocol: 2, recoveryPolicy: 'single-410-relist', target: source.target, selection: source.selection, resource: 'pods', resourceVersion: '1', consumer: { view: 'c'.repeat(32), epoch: 1 } };
    assert.throws(() => watches.open(watch), /QUERY_LIMIT/); f.tasks.release(control(a)); assert.throws(() => watches.open({ ...watch, consumer: { ...watch.consumer, epoch: 2 } }), /QUERY_LIMIT/);
    f.runs[0]?.done.resolve(); await tick(); assert.ok(watches.open({ ...watch, consumer: { ...watch.consumer, epoch: 3 } }).handle);
  } finally { watches.close(); f.close(); }
});
test('terminal callbacks cannot append data after completed/error task state', async () => {
  const f = registry(); try { const a = f.tasks.open(open()); await tick(); f.runs[0]?.done.resolve(); await tick(); f.runs[0]?.emit({ text: 'late' }); assert.equal(f.tasks.poll(control(a)).head, 0); } finally { f.close(); }
});
function clientFixture() {
  const f = registry(), states: LogFollowState[] = []; let pending: (() => void) | undefined;
  const client = new LogFollowClient(async request => { const input = JSON.parse(request.body) as unknown;
    try { let data: unknown; if (request.path.endsWith('/open')) data = f.tasks.open(input); else if (request.path.endsWith('/poll')) data = f.tasks.poll(input); else { f.tasks.release(input); data = { released: true }; } return { status: 200, body: JSON.stringify(data) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  }, state => states.push(state), 'a'.repeat(32), callback => { pending = callback; return () => { pending = undefined; }; });
  return { ...f, client, states, async poll() { const callback = pending; pending = undefined; callback?.(); await tick(); }, close() { client.dispose(); f.close(); } };
}
test('Follow client batches incremental text, Clear preserves consumer/cursor and Stop preserves visible output', async () => {
  const f = clientFixture(); try { await f.client.start(source); await tick(); f.runs[0]?.emit({ text: 'first' }); await f.poll(); assert.equal(f.states.at(-1)?.text, 'first'); f.client.clear(); assert.equal(f.states.at(-1)?.text, ''); assert.equal(f.runs[0]?.signal.aborted, false);
    f.runs[0]?.emit({ text: 'next' }); await f.poll(); assert.equal(f.states.at(-1)?.text, 'next'); f.client.stop(); await tick(); assert.equal(f.states.at(-1)?.text, 'next'); assert.equal(f.states.at(-1)?.error, 'QUERY_CANCELLED'); assert.equal(f.runs[0]?.signal.aborted, true);
  } finally { f.close(); }
});
test('display source remains immutable through Clear and Stop, and reset removes the old source label', async () => {
  const f = clientFixture(); try {
    await f.client.start(source); await tick(); assert.deepEqual(f.states.at(-1)?.source, source); assert.ok(Object.isFrozen(f.states.at(-1)?.source));
    f.client.clear(); assert.deepEqual(f.states.at(-1)?.source, source); f.client.stop(); assert.deepEqual(f.states.at(-1)?.source, source);
    f.client.reset(); assert.equal(f.states.at(-1)?.source, undefined); assert.equal(f.states.at(-1)?.text, '');
  } finally { f.close(); }
});
test('terminal pages drain to head before release, even when byte budget returns fewer than 32 text events', async () => {
  const f = clientFixture(); try { await f.client.start(source); await tick(); for (let n = 0; n < 15; n++) f.runs[0]?.emit({ text: 'x'.repeat(4096) }); f.runs[0]?.done.resolve(); await tick();
    await f.poll(); assert.ok((f.states.at(-1)?.page?.next ?? 0) < 15); for (let n = 0; n < 10; n++) await f.poll(); assert.equal(f.states.at(-1)?.text.length, 15 * 4096); assert.equal(f.states.at(-1)?.phase, 'completed');
  } finally { f.close(); }
});
test('server ring gaps reset old visible prefix and report truncation instead of joining noncontiguous logs', async () => {
  const f = clientFixture(); try { await f.client.start(source); await tick(); f.runs[0]?.emit({ text: 'old-prefix' }); await f.poll(); for (let n = 0; n < 200; n++) f.runs[0]?.emit({ text: `n${n}\n` }); await f.poll(); assert.equal(f.states.at(-1)?.truncated, true); assert.equal(f.states.at(-1)?.text.includes('old-prefix'), false); } finally { f.close(); }
});
test('view rolling buffer is bounded and safe around emoji while controls remain plain escaped text', async () => {
  const f = clientFixture(); try { await f.client.start(source); await tick(); for (let n = 0; n < 40; n++) { f.runs[0]?.emit({ text: '🌏'.repeat(2048) }); await f.poll(); }
    assert.ok((f.states.at(-1)?.text.length ?? 0) <= 65_536); assert.equal(f.states.at(-1)?.truncated, true); assert.equal(logDisplayText('\u001b[31m<script>').startsWith('\\u001b'), true);
  } finally { f.close(); }
});
test('client four actual unsettled requests remain charged through repeated resets', async () => {
  const response = Promise.withResolvers<{ status: number; body: string }>(), states: LogFollowState[] = []; let calls = 0;
  const client = new LogFollowClient(async () => { calls++; return response.promise; }, state => states.push(state), 'a'.repeat(32));
  const pending = Array.from({ length: 5 }, () => client.start(source)); await tick(); assert.equal(calls, 4); assert.equal(states.at(-1)?.error, 'QUERY_LIMIT'); response.resolve({ status: 400, body: '{"error":{"code":"QUERY_CANCELLED"}}' }); await Promise.all(pending); client.dispose();
});
test('late open after reset is released without adopting any output in the new source', async () => {
  const f = registry(), page = f.tasks.open(open()), states: LogFollowState[] = [], deferred = Promise.withResolvers<{ status: number; body: string }>(); let releases = 0;
  const client = new LogFollowClient(async request => { if (request.path.endsWith('/release')) { releases++; f.tasks.release(JSON.parse(request.body) as unknown); return { status: 200, body: '{}' }; } return deferred.promise; }, state => states.push(state), 'a'.repeat(32));
  const pending = client.start(source); client.reset(); deferred.resolve({ status: 200, body: JSON.stringify(page) }); await pending; await tick(); assert.equal(states.at(-1)?.phase, 'idle'); assert.equal(releases, 1); client.dispose(); f.close();
});
test('client rejects mismatched source/container and never displays foreign output', async () => {
  const f = registry(), page = f.tasks.open(open()); const states: LogFollowState[] = [];
  const client = new LogFollowClient(async () => ({ status: 200, body: JSON.stringify({ ...page, source: { ...source, container: 'other' }, events: [{ text: 'FOREIGN', sequence: 1 }], next: 1, head: 1 }) }), state => states.push(state), 'a'.repeat(32));
  await client.start(source); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.text, ''); client.dispose(); f.close();
});
test('gateway Follow checks real Pod/Job runtime via shared finite reader before every incremental body publication', async () => {
  let changed = false, streamed = 0; const currentPod = pod(), currentJob = job(), until = Promise.withResolvers<void>();
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: changed ? 'https://changed.invalid' : 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), value = { ...jobSource, target: { ...source.target, configIdentity: snapshot.snapshot.configIdentity } };
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => { assert.equal(request.purpose, 'resource-object'); return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(request.path.includes('/jobs/') ? currentJob : currentPod)); } }, close: async () => {} }; },
    watch: async (_selection, request, input, emit) => { assert.equal(request.purpose, 'pod-log-follow'); currentPod.metadata.resourceVersion = '2'; currentJob.metadata.resourceVersion = 'j2'; await emit(Buffer.from('increment\n')); streamed++; await Promise.race([until.promise, new Promise<void>(resolve => input.addEventListener('abort', () => resolve(), { once: true }))]); } });
  try { const page = await gateway.openLogFollow(open('a', 1, value), signal()); for (let n = 0; n < 100 && !streamed; n++) await tick(); assert.equal(streamed, 1);
    assert.equal((await gateway.pollLogFollow(control(page), signal())).events[0]?.text, 'increment\n'); changed = true; await assert.rejects(gateway.pollLogFollow(control(page), signal()), /STALE_TARGET/);
  } finally { until.resolve(); gateway.close(); }
});
test('Clear during an unsettled open preserves the opening phase rather than silently hiding an active request', async () => {
  const response = Promise.withResolvers<{ status: number; body: string }>(), states: LogFollowState[] = [];
  const client = new LogFollowClient(async () => response.promise, state => states.push(state), 'a'.repeat(32)); const opening = client.start(source); client.clear(); assert.equal(states.at(-1)?.phase, 'opening');
  response.resolve({ status: 400, body: '{"error":{"code":"FORBIDDEN"}}' }); await opening; client.clear(); assert.equal(states.at(-1)?.error, 'FORBIDDEN'); client.dispose();
});
test('client rejects duplicate/gapped text sequences even if a forged page claims a consistent final head', async () => {
  const f = registry(), page = f.tasks.open(open()), states: LogFollowState[] = [];
  const client = new LogFollowClient(async () => ({ status: 200, body: JSON.stringify({ ...page, events: [{ text: 'first', sequence: 1 }, { text: 'gap', sequence: 3 }], next: 3, head: 3 }) }), state => states.push(state), 'a'.repeat(32));
  await client.start(source); assert.equal(states.at(-1)?.error, 'STATE_UNAVAILABLE'); assert.equal(states.at(-1)?.text, ''); client.dispose(); f.close();
});
test('failed initial exact Pod/Job metadata validation cannot start the Follow transport', async () => {
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), value = { ...source, target: { ...source.target, configIdentity: snapshot.snapshot.configIdentity } }, changed = pod(); changed.metadata.uid = 'replacement'; let streams = 0;
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async () => ({ status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(changed)); } }, close: async () => {} }), watch: async () => { streams++; } });
  try { const page = await gateway.openLogFollow(open('a', 1, value), signal()); let state = page; for (let n = 0; n < 100 && state.phase !== 'error'; n++) { await tick(); state = await gateway.pollLogFollow(control(page), signal()); }
    assert.equal(state.error, 'STALE_TARGET'); assert.equal(streams, 0); assert.equal(state.events.length, 0);
  } finally { gateway.close(); }
});
