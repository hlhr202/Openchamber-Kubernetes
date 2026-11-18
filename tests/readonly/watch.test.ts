// Independent synthetic READ tasks/bytes/metadata only. No SDK, worker, CLI, cache, real credentials or operations/sessions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { watchSourceSchema } from '../../src/shared/watch-protocol.ts';
import type { WatchPage, WatchSource, WatchEvent } from '../../src/shared/watch-protocol.ts';
import { createWatchTasks } from '../../src/service/queries/watch-tasks.ts';
import { createWatchDecoder, planResourceWatch, projectWatchEvent } from '../../src/service/queries/watch-source.ts';
import { runResourceWatch } from '../../src/service/queries/watch-runner.ts';
import { WatchClient } from '../../src/host/watch-client.ts';
import type { WatchState } from '../../src/host/watch-client.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { parseReadWorkerStart, watchAckSchema, watchChunkSchema } from '../../src/service/queries/read-worker-protocol.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';

const source: WatchSource = { protocol: 2, recoveryPolicy: 'single-410-relist', target: { serviceGeneration: 's', projectId: 'p', configIdentity: 'config', context: 'active', namespace: 'default' }, selection: { mode: 'default' }, resource: 'pods', resourceVersion: 'rv/opaque:1' };
const open = (view = 'a', epoch = 1, value = source) => ({ ...value, consumer: { view: view.repeat(32), epoch } });
const control = (page: WatchPage, after = 0) => ({ protocol: 2, handle: page.handle, after });
const event = (resourceVersion = '2'): Omit<WatchEvent, 'sequence'> => ({ type: 'MODIFIED', resourceVersion, name: 'pod', uid: 'u' });
const raw = (resourceVersion = '2') => ({ type: 'MODIFIED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pod', namespace: 'default', uid: 'u', resourceVersion, annotations: { token: 'SYNTHETIC_SECRET' } }, data: { password: 'SYNTHETIC_SECRET' }, spec: { secret: 'SYNTHETIC_SECRET' } } });
const line = (input = raw()) => Buffer.from(JSON.stringify(input) + '\n');
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  let now = 0, starts = 0; const runs: Array<{ signal: AbortSignal; emit: (event: Omit<WatchEvent, 'sequence'>) => void; done: ReturnType<typeof Promise.withResolvers<void>> }> = [];
  const tasks = createWatchTasks({ generation: 's', clock: () => now, run: async (_source, signal, emit) => { starts++; const done = Promise.withResolvers<void>(); runs.push({ signal, emit, done }); await done.promise; } });
  return { tasks, runs, starts: () => starts, time: (value: number) => { now = value; tasks.sweep(); }, close() { tasks.close(); for (const run of runs) run.done.resolve(); } };
}
test('pending opens share one real read task but retain independent server-minted consumer capabilities', async () => {
  const f = fixture(); try { const a = f.tasks.open(open()), b = f.tasks.open(open('b')); await tick(); assert.equal(f.starts(), 1); assert.equal(a.handle.task, b.handle.task); assert.notEqual(a.handle.consumer, b.handle.consumer); assert.notEqual(a.handle.token, b.handle.token); } finally { f.close(); }
});
test('one consumer release leaves the shared read alive; the last release aborts only the owned read signal', async () => {
  const f = fixture(); try { const a = f.tasks.open(open()), b = f.tasks.open(open('b')); await tick(); f.tasks.release(control(a)); assert.equal(f.runs[0]?.signal.aborted, false); f.tasks.release(control(b)); assert.equal(f.runs[0]?.signal.aborted, true); } finally { f.close(); }
});
test('open is idempotent within a view epoch, but released handles cannot resurrect that epoch', () => {
  const f = fixture(); try { const a = f.tasks.open(open()); assert.deepEqual(f.tasks.open(open()).handle, a.handle); f.tasks.release(control(a)); assert.throws(() => f.tasks.open(open()), /VIEW_EXPIRED/); } finally { f.close(); }
});
test('higher consumer epochs replace only that view; stale opens/controls cannot stop the new target', async () => {
  const f = fixture(); try {
    const a = f.tasks.open(open()), b = f.tasks.open(open('b')); await tick();
    const next = f.tasks.open(open('a', 2, { ...source, resource: 'nodes' })); await tick();
    assert.throws(() => f.tasks.open(open('a', 1)), /STALE_TARGET/); assert.throws(() => f.tasks.release(control(a)), /VIEW_EXPIRED/);
    assert.equal(f.tasks.poll(control(next)).phase, 'running'); assert.equal(f.tasks.poll(control(b)).phase, 'running');
  } finally { f.close(); }
});
test('old service generations and token/task/consumer tampering cannot control tasks', () => {
  const f = fixture(); try { const a = f.tasks.open(open()); for (const handle of [{ ...a.handle, generation: 'restarted' }, { ...a.handle, token: '0'.repeat(64) }, { ...a.handle, epoch: 2 }, { ...a.handle, consumer: crypto.randomUUID() }]) assert.throws(() => f.tasks.release({ protocol: 2, handle, after: 0 })); assert.equal(f.tasks.poll(control(a)).phase, 'starting'); } finally { f.close(); }
});
test('same view/epoch cannot be rebound to another context/namespace/resource', () => {
  const f = fixture(); try { f.tasks.open(open()); for (const change of [{ resource: 'nodes' }, { target: { ...source.target, namespace: 'other' } }]) assert.throws(() => f.tasks.open(open('a', 1, { ...source, ...change })), /STALE_TARGET/); } finally { f.close(); }
});
test('consumer leases renew independently and an expired view cannot cancel a renewed peer', async () => {
  const f = fixture(); try { const a = f.tasks.open(open()), b = f.tasks.open(open('b')); await tick(); f.time(10_000); f.tasks.poll(control(b)); f.time(15_000); assert.throws(() => f.tasks.poll(control(a)), /VIEW_EXPIRED/); assert.equal(f.runs[0]?.signal.aborted, false); f.time(25_000); assert.equal(f.runs[0]?.signal.aborted, true); } finally { f.close(); }
});
test('a pending startup cancelled before its microtask cannot start a transport or publish a late event', async () => {
  const f = fixture(); try { const a = f.tasks.open(open()); f.tasks.release(control(a)); await tick(); assert.equal(f.starts(), 0); } finally { f.close(); }
});
test('expired absolute task lifetime wins even when peers renew their leases', async () => {
  const f = fixture(); try { const a = f.tasks.open(open()); await tick(); for (let t = 10_000; t < 60_000; t += 10_000) { f.time(t); f.tasks.poll(control(a)); } f.time(60_000); assert.equal(f.runs[0]?.signal.aborted, true); assert.throws(() => f.tasks.poll(control(a)), /VIEW_EXPIRED/); } finally { f.close(); }
});
test('unsettled cancelled reads continue charging global slots instead of allowing unbounded orphaned transports', async () => {
  const f = fixture(); try { const a = f.tasks.open(open()); const b = f.tasks.open(open('b', 1, { ...source, resource: 'nodes' })); await tick(); f.tasks.release(control(a)); f.tasks.release(control(b)); assert.throws(() => f.tasks.open(open('c', 1, { ...source, resource: 'services' })), /QUERY_LIMIT/); f.runs[0]?.done.resolve(); await tick(); assert.ok(f.tasks.open(open('c', 2, { ...source, resource: 'services' })).handle); } finally { f.close(); }
});
test('ring overflow signals lost and per-consumer cursors do not drain or reorder another reader', async () => {
  const f = fixture(); try { const a = f.tasks.open(open()), b = f.tasks.open(open('b')); await tick(); for (let n = 0; n < 200; n++) f.runs[0]?.emit(event(String(n)));
    const pa = f.tasks.poll(control(a)); assert.equal(pa.lost, true); assert.equal(pa.first, 73); assert.equal(pa.events.length, 32); assert.deepEqual(f.tasks.poll(control(b)).events, pa.events);
    assert.equal(f.tasks.poll(control(a, pa.next)).lost, false); assert.throws(() => f.tasks.poll(control(a, 201)), /INVALID_INPUT/);
  } finally { f.close(); }
});
test('ring has a serialized byte cap as well as an item count and never retains raw secret fields', async () => {
  const f = fixture(); try { const a = f.tasks.open(open()); await tick(); for (let n = 0; n < 128; n++) f.runs[0]?.emit({ ...event('a'.repeat(1024)), uid: 'b'.repeat(1024) }); const page = f.tasks.poll(control(a)); assert.equal(page.lost, true); assert.ok(Buffer.byteLength(JSON.stringify(page.events)) <= 32_100); } finally { f.close(); }
});
test('read failure keeps fixed status only and a new epoch starts a fresh task, never revives old callbacks', async () => {
  const f = fixture(); try { const a = f.tasks.open(open()); await tick(); f.runs[0]?.done.reject(new BoundaryError('FORBIDDEN')); await tick(); assert.equal(f.tasks.poll(control(a)).error, 'FORBIDDEN'); const b = f.tasks.open(open('b')); await tick(); assert.notEqual(b.handle.task, a.handle.task); f.tasks.release(control(a)); f.runs[0]?.emit(event()); assert.equal(f.tasks.poll(control(b)).events.length, 0); } finally { f.close(); }
});
test('closing the read task registry rejects all handles and aborts read-only signals without a session executor', async () => {
  const f = fixture(); const a = f.tasks.open(open()); await tick(); f.close(); assert.equal(f.runs[0]?.signal.aborted, true); assert.throws(() => f.tasks.poll(control(a)), /SERVICE_CLOSED/); assert.throws(() => f.tasks.open(open()), /SERVICE_CLOSED/);
});
test('watch planning is exact full GVR/scope/RV and never allows arbitrary paths, exec, proxy or CRDs', () => {
  const plan = planResourceWatch(source); assert.equal(plan.path, '/api/v1/namespaces/default/pods'); assert.equal(plan.query.watch, 'true');
  const node = planResourceWatch({ ...source, resource: 'nodes' }); assert.equal(node.path, '/api/v1/nodes');
  for (const change of [{ resource: 'pods/exec' }, { path: '/arbitrary' }, { resourceVersion: '0' }]) assert.throws(() => planResourceWatch({ ...source, ...change }), /INVALID_INPUT/);
});
test('object watch uses metadata.name field selector and original UID, never shortName/path interpolation', () => {
  const plan = planResourceWatch({ ...source, object: { name: 'pod', uid: 'u' } }); assert.equal(plan.query.fieldSelector, 'metadata.name=pod'); assert.ok(kubectlReadArguments(plan, '/synthetic/pipe').some(arg => arg.includes('watch=true')));
});
test('private worker start admits only watch purpose with exact builtin path/query and ordinary 2MB budget', () => {
  const request = planResourceWatch(source), input = { protocol: 1, kind: 'read', request, snapshot: new Uint8Array([1]), path: '/synthetic/bin' };
  assert.equal(parseReadWorkerStart(input).request.purpose, 'resource-watch');
  for (const change of [{ maximumBytes: 8_000_000 }, { path: '/api/v1/namespaces/other/pods' }, { query: { ...request.query, fieldSelector: 'metadata.name=pod,other=x' } }, { query: { ...request.query, timeoutSeconds: '600' } }, { query: { ...request.query, follow: 'true' } }]) assert.throws(() => parseReadWorkerStart({ ...input, request: { ...request, ...change } }));
});
test('incremental framing emits before EOF and handles split UTF-8, split JSON, multiple frames and CRLF', () => {
  const events: unknown[] = [], decoder = createWatchDecoder(source, e => events.push(e)), bytes = line(raw('版本2'));
  for (const byte of bytes) decoder.push(new Uint8Array([byte])); assert.equal(events.length, 1); decoder.push(Buffer.from(JSON.stringify(raw('3')) + '\r\n' + JSON.stringify(raw('4')))); assert.equal(events.length, 2); decoder.finish(); assert.equal(events.length, 3);
});
test('watch metadata projection strips secret/data/annotations/spec and raw status error messages', () => {
  assert.equal(JSON.stringify(projectWatchEvent(raw(), source)).includes('SYNTHETIC_SECRET'), false);
  for (const [code, failure] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [410, 'CONTINUATION_EXPIRED'], [429, 'QUERY_LIMIT']]) assert.throws(() => projectWatchEvent({ type: 'ERROR', object: { kind: 'Status', code, message: 'SYNTHETIC_SECRET' } }, source), new RegExp(String(failure)));
});
test('wrong GVK, namespace, UID and same-name replacement cannot be merged into a watch', () => {
  const value = raw(); for (const object of [{ ...value.object, kind: 'Secret' }, { ...value.object, apiVersion: 'apps/v1' }, { ...value.object, metadata: { ...value.object.metadata, namespace: 'other' } }]) assert.throws(() => projectWatchEvent({ ...value, object }, source));
  assert.throws(() => projectWatchEvent(value, { ...source, object: { name: 'pod', uid: 'replacement' } }), /STALE_TARGET/);
});
test('bookmarks advance only opaque RV and are not fabricated object changes', () => {
  assert.deepEqual(projectWatchEvent({ type: 'BOOKMARK', object: { metadata: { resourceVersion: 'rv:opaque' }, data: 'SYNTHETIC_SECRET' } }, source), { type: 'BOOKMARK', resourceVersion: 'rv:opaque' });
});
test('truncated JSON, invalid Unicode and over-budget single frames fail whole rather than healthy empty snapshots', () => {
  for (const input of [Buffer.from('{"type":'), Buffer.from([0xff, 10]), Buffer.alloc(262_145, 32)]) { const decoder = createWatchDecoder(source, () => {}); assert.throws(() => { decoder.push(input); decoder.finish(); }); }
});
test('IPC chunk and ack schemas are bounded/strict and cannot transport alternate commands or configuration', () => {
  assert.equal(watchChunkSchema.safeParse({ protocol: 1, kind: 'watch-chunk', sequence: 1, body: new Uint8Array([1]) }).success, true);
  for (const body of [new Uint8Array(), new Uint8Array(16_385)]) assert.equal(watchChunkSchema.safeParse({ protocol: 1, kind: 'watch-chunk', sequence: 1, body }).success, false);
  assert.equal(watchAckSchema.safeParse({ protocol: 1, kind: 'watch-ack', sequence: 0 }).success, false); assert.equal(watchAckSchema.safeParse({ protocol: 1, kind: 'watch-ack', sequence: 1, argv: [] }).success, false);
});
test('normal finite watch windows resume the last opaque RV, bounded to ten with delay and no relist', async () => {
  let now = 0, windows = 0, pauses = 0; const versions: string[] = [], events: unknown[] = [];
  await runResourceWatch(source, new AbortController().signal, e => events.push(e), { clock: () => now, pause: async () => { pauses++; now += 250; }, verify: async () => {}, transport: async (_selection, request, _signal, emit) => { versions.push(request.query.resourceVersion ?? ''); now += 5000; await emit(line(raw(String(++windows)))); } });
  assert.equal(windows, 10); assert.equal(pauses, 9); assert.equal(events.length, 10); assert.deepEqual(versions.slice(0, 3), [source.resourceVersion, '1', '2']);
});
test('410 and fast EOF do not spin, relist or replay authentication automatically', async () => {
  for (const fail of [true, false]) { let calls = 0; await assert.rejects(runResourceWatch(source, new AbortController().signal, () => {}, { verify: async () => {}, transport: async () => { calls++; if (fail) throw new BoundaryError('CONTINUATION_EXPIRED'); } }), fail ? /CONTINUATION_EXPIRED/ : /READ_TRANSPORT_UNAVAILABLE/); assert.equal(calls, 1); }
});
test('target changes during a raw chunk verify discard it before parsing/publishing', async () => {
  let changed = false, events = 0;
  await assert.rejects(runResourceWatch(source, new AbortController().signal, () => { events++; }, { verify: async () => { if (changed) throw new BoundaryError('STALE_TARGET'); }, transport: async (_selection, _request, _signal, emit) => { changed = true; await emit(line()); } }), /STALE_TARGET/); assert.equal(events, 0);
});
test('gateway opens and releases read tasks via metadata capabilities; configuration drift cannot yield a poll for a new context', async () => {
  let changed = false, streamed = 0; const until = Promise.withResolvers<void>();
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: changed ? 'https://changed.invalid' : 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const current = await config.read({ mode: 'default' }), value = { ...source, target: { ...source.target, configIdentity: current.snapshot.configIdentity } };
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async () => { throw new Error('No finite list/snapshot is a Watch'); }, watch: async (_selection, request, signal, emit) => { assert.equal(request.purpose, 'resource-watch'); streamed++; await emit(line()); await Promise.race([until.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]); } });
  try { const page = await gateway.openWatch(open('a', 1, value), new AbortController().signal); for (let n = 0; n < 100 && !streamed; n++) await tick(); const result = await gateway.pollWatch(control(page), new AbortController().signal); assert.equal(result.events[0]?.resourceVersion, '2'); assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'), false); changed = true; await assert.rejects(gateway.pollWatch(control(page), new AbortController().signal), /STALE_TARGET/); } finally { until.resolve(); gateway.close(); }
});
test('object gateway projects only strict GVR fields into fresh metadata verification before streaming', async () => {
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const current = await config.read({ mode: 'default' }), value = { ...source, resourceVersion: '1', object: { name: 'pod', uid: 'u' }, target: { ...source.target, configIdentity: current.snapshot.configIdentity } };
  const until = Promise.withResolvers<void>(); let reads = 0, ready = false;
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => {
    assert.equal(request.purpose, 'resource-object'); assert.equal(request.path, '/api/v1/namespaces/default/pods/pod'); reads++;
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(raw('1').object)); } }, close: async () => {} };
  }, watch: async (_selection, request, signal, emit) => { assert.equal(reads, 1); assert.equal(request.query.fieldSelector, 'metadata.name=pod'); await emit(line()); ready = true; await Promise.race([until.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]); } });
  try {
    const page = await gateway.openWatch(open('a', 1, value), new AbortController().signal);
    for (let n = 0; n < 100; n++) { await tick(); const state = await gateway.pollWatch(control(page), new AbortController().signal); if (state.phase === 'error') assert.fail(state.error); if (state.events.length) break; }
    assert.ok(ready); assert.equal((await gateway.pollWatch(control(page), new AbortController().signal)).events[0]?.resourceVersion, '2'); gateway.releaseWatch(control(page));
  } finally { until.resolve(); gateway.close(); }
});
function clientFixture(transform?: (page: WatchPage) => unknown) {
  const f = fixture(), states: WatchState[] = []; let callback: (() => void) | undefined;
  const client = new WatchClient(async request => {
    const input = JSON.parse(request.body) as unknown;
    try { let result: unknown; if (request.path.endsWith('/open')) result = f.tasks.open(input); else if (request.path.endsWith('/poll')) result = f.tasks.poll(input); else { f.tasks.release(input); result = { protocol: 2, released: true }; }
      if (transform && request.path.endsWith('/poll')) result = transform(result as WatchPage); return { status: 200, body: JSON.stringify(result) };
    } catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  }, state => states.push(state), 'a'.repeat(32), fn => { callback = fn; return () => { callback = undefined; }; });
  return { ...f, client, states, poll: async () => { callback?.(); callback = undefined; for (let n = 0; n < 10; n++) await tick(); }, close() { client.dispose(); f.close(); } };
}
test('independent SDK-shaped client polls incremental DTOs once per scheduled batch and releases its consumer on stop', async () => {
  const f = clientFixture(); try { await f.client.start(source); await tick(); f.runs[0]?.emit(event()); await f.poll(); assert.equal(f.states.at(-1)?.changed, true); assert.equal(f.states.at(-1)?.page?.events.length, 1); f.client.reset(); await tick(); assert.equal(f.states.at(-1)?.phase, 'idle'); assert.equal(f.runs[0]?.signal.aborted, true); } finally { f.close(); }
});
test('client rejects cross-target/source/consumer responses and never displays wrong-target event data', async () => {
  const f = clientFixture(page => ({ ...page, source: { ...page.source, target: { ...page.source.target, namespace: 'other' } } })); try { await f.client.start(source); await tick(); f.runs[0]?.emit(event()); await f.poll(); assert.equal(f.states.at(-1)?.error, 'STALE_TARGET'); assert.equal(f.states.at(-1)?.page, undefined); } finally { f.close(); }
});
test('client rejects non-contiguous/non-monotonic cursors unless ring loss is explicit', async () => {
  const f = clientFixture(page => ({ ...page, events: [{ ...event(), sequence: 2 }], next: 2, lost: false })); try { await f.client.start(source); await f.poll(); assert.equal(f.states.at(-1)?.error, 'STATE_UNAVAILABLE'); } finally { f.close(); }
});
test('a late open response after target reset is released, not adopted or shown in the new view', async () => {
  const f = fixture(), states: WatchState[] = [], response = Promise.withResolvers<{ status: number; body: string }>(); let releases = 0;
  const client = new WatchClient(async request => { if (request.path.endsWith('/release')) { releases++; f.tasks.release(JSON.parse(request.body) as unknown); return { status: 200, body: '{}' }; } return response.promise; }, state => states.push(state), 'a'.repeat(32));
  const pending = client.start(source); client.reset(); const page = f.tasks.open(open()); response.resolve({ status: 200, body: JSON.stringify(page) }); await pending; await tick(); assert.equal(states.at(-1)?.phase, 'idle'); assert.equal(releases, 1); client.dispose(); f.close();
});
test('strict watch source excludes raw data, arbitrary URLs, credentials and unsupported resource types', () => {
  for (const change of [{ data: 'SYNTHETIC_SECRET' }, { url: 'https://elsewhere.invalid' }, { argv: ['exec'] }, { resource: 'custom.invalid' }]) assert.equal(watchSourceSchema.safeParse({ ...source, ...change }).success, false);
});
test('view tombstones are bounded to 64 even when all consumers share a single read', () => {
  const f = fixture(); try { for (let n = 0; n < 64; n++) f.tasks.open({ ...source, consumer: { view: n.toString(16).padStart(32, '0'), epoch: 1 } });
    assert.throws(() => f.tasks.open({ ...source, consumer: { view: 'f'.repeat(32), epoch: 1 } }), /QUERY_LIMIT/);
  } finally { f.close(); }
});
test('failed newer admission still advances a view tombstone, rejecting delayed middle epochs', async () => {
  const f = fixture(); try { f.tasks.open(open()); f.tasks.open(open('b', 1, { ...source, resource: 'nodes' })); await tick();
    assert.throws(() => f.tasks.open(open('a', 5, { ...source, resource: 'services' })), /QUERY_LIMIT/);
    assert.throws(() => f.tasks.open(open('a', 3, { ...source, resource: 'services' })), /STALE_TARGET/);
  } finally { f.close(); }
});
test('Watch decoder is poisoned after failure and cannot silently resume a truncated frame', () => {
  const decoder = createWatchDecoder(source, () => {}); assert.throws(() => decoder.push(Buffer.from('not-json\n')), /RESOURCE_INVALID/);
  assert.throws(() => decoder.push(line()), /STATE_UNAVAILABLE/); assert.throws(() => decoder.finish(), /STATE_UNAVAILABLE/);
});
test('single window and aggregate watch response byte budgets are independent of metadata ring capacity', async () => {
  const decoder = createWatchDecoder(source, () => {}); assert.throws(() => decoder.push(Buffer.alloc(2_000_001)), /BUDGET_EXCEEDED/);
  let now = 0, calls = 0; const padding = Buffer.alloc(1_000_001, 10);
  await assert.rejects(runResourceWatch(source, new AbortController().signal, () => {}, { clock: () => now, pause: async () => {}, verify: async () => {}, transport: async (_selection, _request, _signal, emit) => { calls++; now += 5000; await emit(padding); } }), /BUDGET_EXCEEDED/); assert.equal(calls, 8);
});
test('client actual unsettled open calls stay bounded across rapid target resets', async () => {
  const response = Promise.withResolvers<{ status: number; body: string }>(), states: WatchState[] = []; let calls = 0;
  const client = new WatchClient(async () => { calls++; return response.promise; }, state => states.push(state), 'a'.repeat(32));
  const pending = Array.from({ length: 5 }, () => client.start(source)); assert.equal(calls, 4); await tick(); assert.equal(states.at(-1)?.error, 'QUERY_LIMIT');
  response.resolve({ status: 400, body: '{"error":{"code":"QUERY_CANCELLED"}}' }); await Promise.all(pending); client.dispose();
});
