// Synthetic read metadata, NDJSON frames and detached client projection only. Never SDK/worker/CLI/cache or operations/sessions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { eventFollowSourceSchema, eventFollowOpenSchema, eventFollowDeltaSchema, eventFollowPageSchema } from '../../src/shared/event-follow-protocol.ts';
import type { EventFollowSource, EventFollowDelta, EventFollowPage } from '../../src/shared/event-follow-protocol.ts';
import { eventOccurrences, eventLastObserved } from '../../src/shared/event-protocol.ts';
import { projectEventRow } from '../../src/service/queries/event-source.ts';
import { projectEventFollowDelta, planEventFollow } from '../../src/service/queries/event-follow-source.ts';
import { runEventFollow } from '../../src/service/queries/event-follow-runner.ts';
import { createReadTasks, createReadTaskBudget } from '../../src/service/queries/read-tasks.ts';
import { createWatchTasks } from '../../src/service/queries/watch-tasks.ts';
import { EventFollowBuffer } from '../../src/host/event-follow-buffer.ts';
import { EventFollowClient } from '../../src/host/event-follow-client.ts';
import type { EventFollowState } from '../../src/host/event-follow-client.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { parseReadWorkerStart } from '../../src/service/queries/read-worker-protocol.ts';
import { createWatchFrameDecoder } from '../../src/service/queries/watch-source.ts';

const source: EventFollowSource = { protocol: 2, recoveryPolicy: 'single-410-relist', target: { serviceGeneration: 's', projectId: 'p', configIdentity: 'c', context: 'active', namespace: 'default' }, selection: { mode: 'default' }, scope: { kind: 'current' }, namespace: { name: 'default', uid: 'ns-u', resourceVersion: 'n1' }, apiVersion: 'v1' };
const raw = (name = 'event', uid = 'event-u', rv = '1') => ({ apiVersion: 'v1', kind: 'Event', metadata: { name, namespace: 'default', uid, resourceVersion: rv, annotations: { secret: 'SYNTHETIC_SECRET' } }, involvedObject: { apiVersion: 'v1', kind: 'Pod', name: 'pod', namespace: 'default', uid: 'pod-u' }, reason: 'Synthetic', message: 'message', type: 'Normal', count: 2, series: { count: 4, lastObservedTime: '2026-10-23T10:00:00Z' } });
const delta = (type: 'SEED' | 'ADDED' | 'MODIFIED' | 'DELETED', rv = '1', name = 'event', uid = 'event-u', sequence = 1): EventFollowDelta => ({ type, resourceVersion: rv, row: projectEventRow(raw(name, uid, rv), 'default'), sequence });
const open = (view = 'a', epoch = 1, value = source) => ({ ...value, consumer: { view: view.repeat(32), epoch } });
const control = (page: EventFollowPage, after = 0) => ({ protocol: 2, handle: page.handle, after });
const signal = () => new AbortController().signal;
const tick = async () => { for (let n = 0; n < 16; n++) await Promise.resolve(); };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
function registry(budget?: ReturnType<typeof createReadTaskBudget>) {
  let now = 0; const runs: Array<{ signal: AbortSignal; emit: (value: Omit<EventFollowDelta, 'sequence'>) => void; done: ReturnType<typeof Promise.withResolvers<void>> }> = [];
  const tasks = createReadTasks({ generation: 's', kind: 'event-follow', sourceSchema: eventFollowSourceSchema, eventSchema: eventFollowDeltaSchema, pageSchema: eventFollowPageSchema, ...(budget ? { budget } : {}), clock: () => now,
    run: async (_source, signal, emit) => { const done = Promise.withResolvers<void>(); runs.push({ signal, emit, done }); await done.promise; } });
  return { tasks, runs, time(value: number) { now = value; tasks.sweep(); }, close() { tasks.close(); for (const run of runs) run.done.resolve(); } };
}
test('strict current/selected Namespace source binds the real namespace UID/RV and rejects scope substitution', () => {
  assert.ok(eventFollowOpenSchema.safeParse(open()).success);
  assert.ok(eventFollowSourceSchema.safeParse({ ...source, scope: { kind: 'namespace', ...source.namespace } }).success);
  for (const change of [{ namespace: { ...source.namespace, name: 'other' } }, { scope: { kind: 'namespace', ...source.namespace, uid: 'replacement' } }, { resource: 'pods' }, { path: '/arbitrary' }, { raw: 'SYNTHETIC_SECRET' }]) assert.equal(eventFollowSourceSchema.safeParse({ ...source, ...change }).success, false);
});
test('event Watch plan uses exact core/v1 namespace Events path and opaque List RV without a terminal or selector', () => {
  const plan = planEventFollow(source, 'rv:opaque/1'); assert.equal(plan.path, '/api/v1/namespaces/default/events'); assert.deepEqual(plan.query, { watch: 'true', resourceVersion: 'rv:opaque/1', timeoutSeconds: '5' });
  const args = kubectlReadArguments(plan, '/synthetic/pipe'); assert.ok(args.includes('--request-timeout=7s')); assert.ok(args.some(value => value.includes('--raw=/api/v1/namespaces/default/events?'))); assert.throws(() => planEventFollow(source, '0'), /INVALID_INPUT/);
});
test('private event purpose cannot widen namespace watch to arbitrary resources/subresources/query or an 8MB result', () => {
  const request = planEventFollow(source, '1'), input = { protocol: 1, kind: 'read', request, snapshot: new Uint8Array([1]), path: '/synthetic/bin' }; assert.equal(parseReadWorkerStart(input).request.purpose, 'namespace-event-watch');
  for (const change of [{ path: '/api/v1/namespaces/default/pods' }, { path: '/api/v1/namespaces/default/events/exec' }, { maximumBytes: 8_000_000 }, { query: { ...request.query, fieldSelector: 'metadata.name=x' } }, { query: { ...request.query, timeoutSeconds: '600' } }]) assert.throws(() => parseReadWorkerStart({ ...input, request: { ...request, ...change } }));
});
test('event row projection preserves real count/series/time but never raw annotations or arbitrary fields', () => {
  const event = projectEventFollowDelta({ type: 'MODIFIED', object: raw() }, 'default'); assert.ok(event.row); assert.equal(eventOccurrences(event.row), 4); assert.equal(eventLastObserved(event.row), '2026-10-23T10:00:00Z'); assert.equal(JSON.stringify(event).includes('SYNTHETIC_SECRET'), false);
});
test('wrong Event GVK/namespace and malformed type fail instead of becoming another resource watch', () => {
  for (const object of [{ ...raw(), kind: 'Pod' }, { ...raw(), apiVersion: 'events.k8s.io/v1' }, { ...raw(), metadata: { ...raw().metadata, namespace: 'other' } }]) assert.throws(() => projectEventFollowDelta({ type: 'ADDED', object }, 'default'));
  assert.throws(() => projectEventFollowDelta({ type: 'SEED', object: raw() }, 'default'), /RESOURCE_INVALID/);
});
test('watch Status errors expose only fixed codes; bookmarks only advance opaque resourceVersion', () => {
  for (const [code, failure] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [410, 'CONTINUATION_EXPIRED'], [429, 'QUERY_LIMIT']]) assert.throws(() => projectEventFollowDelta({ type: 'ERROR', object: { kind: 'Status', code, message: 'SYNTHETIC_SECRET' } }, 'default'), new RegExp(String(failure)));
  assert.deepEqual(projectEventFollowDelta({ type: 'BOOKMARK', object: { metadata: { resourceVersion: 'opaque' }, data: 'SYNTHETIC_SECRET' } }, 'default'), { type: 'BOOKMARK', resourceVersion: 'opaque' });
});
test('common frame decoder handles split Unicode/JSON, emits before EOF, rejects truncated or oversized frames', () => {
  const items: unknown[] = [], decoder = createWatchFrameDecoder(value => items.push(value)), bytes = encode({ type: 'ADDED', object: { ...raw(), message: '🌏' } });
  for (const byte of bytes) decoder.push(new Uint8Array([byte])); assert.equal(items.length, 1); decoder.finish();
  const bad = createWatchFrameDecoder(() => {}); bad.push(Buffer.from('{')); assert.throws(() => bad.finish(), /RESOURCE_INVALID/);
  assert.throws(() => createWatchFrameDecoder(() => {}).push(Buffer.alloc(262_145)), /BUDGET_EXCEEDED/);
});
test('bounded initial list pages preserve the same snapshot then begin a real watch at its List RV', async () => {
  let lists = 0, windows = 0, now = 0; const emitted: Array<Omit<EventFollowDelta, 'sequence'>> = [], starts: string[] = [];
  await runEventFollow(source, signal(), event => emitted.push(event), { verify: async () => {}, charge: () => {}, clock: () => now, pause: async () => {},
    list: async previous => { lists++; if (lists === 2) assert.deepEqual(previous, { resourceVersion: 'list-rv', continuation: 'next' }); return { apiVersion: source.apiVersion, namespace: source.namespace, rows: [projectEventRow(raw(`event${lists}`, `uid${lists}`), 'default')], resourceVersion: 'list-rv', continuation: lists === 1 ? 'next' : null }; },
    transport: async (_selection, request, _signal, emit) => { starts.push(request.query.resourceVersion ?? ''); now += 5000; await emit(encode({ type: 'MODIFIED', object: raw('event1', 'uid1', String(++windows)) })); } });
  assert.equal(lists, 2); assert.equal(windows, 10); assert.equal(starts[0], 'list-rv'); assert.equal(starts[1], '1'); assert.deepEqual(emitted.slice(0, 2).map(value => value.type), ['SEED', 'SEED']);
});
test('list snapshot drift/duplicate UID or repeated continuation never starts a watch', async () => {
  for (const failure of ['rv', 'duplicate', 'cursor']) { let page = 0, watches = 0;
    await assert.rejects(runEventFollow(source, signal(), () => {}, { verify: async () => {}, charge: () => {}, list: async () => { page++; return { apiVersion: source.apiVersion, namespace: source.namespace, resourceVersion: failure === 'rv' && page > 1 ? 'changed' : 'rv', continuation: 'next', rows: failure === 'duplicate' ? [projectEventRow(raw(), 'default')] : [] }; }, transport: async () => { watches++; } })); assert.equal(watches, 0);
  }
});
test('20-page initial-list cap fails explicitly without treating a partial list as a healthy start', async () => {
  let pages = 0; await assert.rejects(runEventFollow(source, signal(), () => {}, { verify: async () => {}, charge: () => {}, list: async () => ({ apiVersion: source.apiVersion, namespace: source.namespace, rows: [], resourceVersion: 'rv', continuation: `page${++pages}` }), transport: async () => { assert.fail('No watch before complete initial list'); } }), /QUERY_LIMIT/); assert.equal(pages, 20);
});
test('fast EOF and namespace drift discard old watch results without automatic relist or auth retry', async () => {
  for (const mode of ['eof', 'drift']) { let changed = false, calls = 0, lists = 0; const emitted: Array<Omit<EventFollowDelta, 'sequence'>> = [];
    await assert.rejects(runEventFollow(source, signal(), event => { emitted.push(event); }, { verify: async () => { if (changed) throw new BoundaryError('STALE_TARGET'); }, charge: () => {}, list: async () => { lists++; return { apiVersion: source.apiVersion, namespace: source.namespace, rows: [], resourceVersion: 'rv', continuation: null }; }, transport: async (_selection, _request, _signal, emit) => { calls++; if (mode === 'drift') { changed = true; await emit(encode({ type: 'ADDED', object: raw() })); } } }), mode === 'eof' ? /READ_TRANSPORT_UNAVAILABLE/ : /STALE_TARGET/);
    assert.equal(calls, 1); assert.equal(lists, 1); assert.deepEqual(emitted.map(event => event.type), ['RESYNC']);
  }
});
test('event buffer replaces counters instead of summing observations, duplicates are idempotent', () => {
  const buffer = new EventFollowBuffer(), first = delta('ADDED'); buffer.apply(first, 'default'); buffer.apply(first, 'default'); assert.equal(buffer.rows.length, 1); assert.equal(eventOccurrences(buffer.rows[0]!), 4);
  const second = delta('MODIFIED', '2'); if (second.row?.series) second.row.series.count = 7; buffer.apply(second, 'default'); assert.equal(eventOccurrences(buffer.rows[0]!), 7);
});
test('same-name Event recreation replaces old UID, and a late delete for the old UID cannot erase the replacement', () => {
  const buffer = new EventFollowBuffer(); buffer.apply(delta('SEED'), 'default'); buffer.apply(delta('ADDED', '2', 'event', 'new-u'), 'default'); buffer.apply(delta('DELETED', '3'), 'default'); assert.equal(buffer.rows.length, 1); assert.equal(buffer.rows[0]?.uid, 'new-u'); buffer.apply(delta('DELETED', '4', 'event', 'new-u'), 'default'); assert.equal(buffer.rows.length, 0);
});
test('same UID/RV conflicting content and UID name mutation fail, bookmarks never fabricate a row', () => {
  const buffer = new EventFollowBuffer(); buffer.apply(delta('SEED'), 'default'); const conflict = delta('MODIFIED'); if (conflict.row) conflict.row.message = 'different'; assert.throws(() => buffer.apply(conflict, 'default'), /STATE_UNAVAILABLE/);
  assert.throws(() => buffer.apply(delta('DELETED', '2', 'renamed'), 'default'), /STATE_UNAVAILABLE/); buffer.apply({ sequence: 2, type: 'BOOKMARK', resourceVersion: '2' }, 'default'); assert.equal(buffer.rows.length, 1);
});
test('view state enforces row and serialized byte limits, not an ever-growing audit history', () => {
  const buffer = new EventFollowBuffer(); for (let n = 0; n < 201; n++) buffer.apply(delta('ADDED', String(n), `event${n}`, `uid${n}`, n + 1), 'default'); assert.equal(buffer.rows.length, 200); assert.equal(buffer.truncated, true);
  buffer.clear(); for (let n = 0; n < 30; n++) { const value = delta('ADDED', String(n), `event${n}`, `uid${n}`, n + 1); if (value.row) value.row.message = 'a'.repeat(16_000); buffer.apply(value, 'default'); } assert.ok(Buffer.byteLength(JSON.stringify(buffer.rows)) < 256_500); assert.equal(buffer.truncated, true);
});
test('read-task core rejects an event too large for one poll instead of creating a permanently undrainable head', async () => {
  const f = registry(); try { const page = f.tasks.open(open()); await tick(); const value = delta('ADDED'); if (value.row) value.row.message = '\n'.repeat(16_384);
    assert.throws(() => f.runs[0]?.emit(value), /BUDGET_EXCEEDED/); assert.equal(f.tasks.poll(control(page)).head, 0);
  } finally { f.close(); }
});
test('Event Follow shares pending source work, independent cursors/lease and the global two-stream budget', async () => {
  const budget = createReadTaskBudget(), f = registry(budget), watches = createWatchTasks({ generation: 's', budget, run: async (_source, input) => new Promise<void>(resolve => input.addEventListener('abort', () => resolve(), { once: true })) });
  try { const a = f.tasks.open(open()), b = f.tasks.open(open('b')); await tick(); assert.equal(f.runs.length, 1); assert.equal(a.handle.task, b.handle.task); f.tasks.release(control(a)); assert.equal(f.runs[0]?.signal.aborted, false);
    watches.open({ protocol: 2, recoveryPolicy: 'single-410-relist', target: source.target, selection: source.selection, resource: 'pods', resourceVersion: '1', consumer: { view: 'c'.repeat(32), epoch: 1 } });
    assert.throws(() => f.tasks.open(open('d', 1, { ...source, scope: { kind: 'namespace', name: 'other', uid: 'ns-other', resourceVersion: 'n2' }, namespace: { name: 'other', uid: 'ns-other', resourceVersion: 'n2' } })), /QUERY_LIMIT/);
    f.time(15_000); assert.equal(f.runs[0]?.signal.aborted, true);
  } finally { watches.close(); f.close(); }
});
function clientFixture(transform?: (value: EventFollowPage) => unknown) {
  const f = registry(), states: EventFollowState[] = []; let pending: (() => void) | undefined;
  const client = new EventFollowClient(async request => { const input = JSON.parse(request.body) as unknown;
    try { let data: unknown; if (request.path.endsWith('/open')) data = f.tasks.open(input); else if (request.path.endsWith('/poll')) { const page = f.tasks.poll(input); data = transform ? transform(page) : page; } else { f.tasks.release(input); data = { released: true }; } return { status: 200, body: JSON.stringify(data) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  }, state => states.push(state), 'a'.repeat(32), callback => { pending = callback; return () => { pending = undefined; }; });
  return { ...f, client, states, async poll() { const callback = pending; pending = undefined; callback?.(); await tick(); }, close() { client.dispose(); f.close(); } };
}
test('SDK-shaped Event Follow client applies live row updates and Stop releases its read while preserving displayed rows', async () => {
  const f = clientFixture(); try { await f.client.start(source); await tick(); f.runs[0]?.emit(delta('SEED')); await f.poll(); f.runs[0]?.emit(delta('MODIFIED', '2')); await f.poll(); assert.equal(f.states.at(-1)?.rows.length, 1); f.client.stop(); await tick(); assert.equal(f.states.at(-1)?.rows.length, 1); assert.equal(f.states.at(-1)?.error, 'QUERY_CANCELLED'); assert.equal(f.runs[0]?.signal.aborted, true); } finally { f.close(); }
});
test('client ring loss clears old rows and explicitly reports a partial window, not a complete snapshot', async () => {
  const f = clientFixture(); try { await f.client.start(source); await tick(); f.runs[0]?.emit(delta('SEED')); await f.poll(); for (let n = 0; n < 200; n++) f.runs[0]?.emit(delta('ADDED', String(n), `event${n}`, `uid${n}`)); await f.poll(); assert.equal(f.states.at(-1)?.truncated, true); assert.equal(f.states.at(-1)?.rows.some(row => row.uid === 'event-u'), false); } finally { f.close(); }
});
test('client drains terminal short byte-limited pages all the way to head before releasing', async () => {
  const f = clientFixture(); try { await f.client.start(source); await tick(); for (let n = 0; n < 5; n++) { const value = delta('ADDED', String(n), `event${n}`, `uid${n}`); if (value.row) value.row.message = 'x'.repeat(10_000); f.runs[0]?.emit(value); } f.runs[0]?.done.resolve(); await tick(); await f.poll(); assert.ok((f.states.at(-1)?.page?.next ?? 0) < 5); for (let n = 0; n < 4; n++) await f.poll(); assert.equal(f.states.at(-1)?.rows.length, 5); assert.equal(f.states.at(-1)?.phase, 'completed'); } finally { f.close(); }
});
test('cross-source/namespace or forged event sequences never publish foreign messages', async () => {
  for (const mode of ['source', 'row', 'sequence']) { const f = clientFixture(page => mode === 'source' ? { ...page, source: { ...page.source, namespace: { ...page.source.namespace, uid: 'other' } } } : mode === 'row' ? { ...page, events: [{ ...delta('ADDED'), row: { ...delta('ADDED').row, namespace: 'other' } }], next: 1, head: 1 } : { ...page, events: [delta('ADDED', '1', 'event', 'event-u', 2)], next: 2, head: 2 });
    try { await f.client.start(source); await tick(); await f.poll(); assert.equal(f.states.at(-1)?.phase, 'error'); assert.equal(f.states.at(-1)?.rows.length, 0); } finally { f.close(); }
  }
});
test('late open after reset releases only its old consumer and cannot reattach a new view', async () => {
  const f = registry(), page = f.tasks.open(open()), states: EventFollowState[] = [], response = Promise.withResolvers<{ status: number; body: string }>(); let releases = 0;
  const client = new EventFollowClient(async request => { if (request.path.endsWith('/release')) { releases++; f.tasks.release(JSON.parse(request.body) as unknown); return { status: 200, body: '{}' }; } return response.promise; }, state => states.push(state), 'a'.repeat(32));
  const opening = client.start(source); client.reset(); response.resolve({ status: 200, body: JSON.stringify(page) }); await opening; await tick(); assert.equal(releases, 1); assert.equal(states.at(-1)?.phase, 'idle'); client.dispose(); f.close();
});
test('client actual unsettled calls stay bounded across resets instead of freeing phantom request slots', async () => {
  const response = Promise.withResolvers<{ status: number; body: string }>(), states: EventFollowState[] = []; let calls = 0;
  const client = new EventFollowClient(async () => { calls++; return response.promise; }, state => states.push(state), 'a'.repeat(32)); const pending = Array.from({ length: 5 }, () => client.start(source)); await tick(); assert.equal(calls, 4); assert.equal(states.at(-1)?.error, 'QUERY_LIMIT'); response.resolve({ status: 400, body: '{"error":{"code":"QUERY_CANCELLED"}}' }); await Promise.all(pending); client.dispose();
});
test('gateway initial list then stream is real, allows same Namespace UID RV advance, and rejects later namespace replacement', async () => {
  const namespace = { apiVersion: 'v1', kind: 'Namespace', metadata: { ...source.namespace, namespace: undefined } }, until = Promise.withResolvers<void>(); let watched = 0, lists = 0;
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), value = { ...source, target: { ...source.target, configIdentity: snapshot.snapshot.configIdentity } };
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => ({ status: 200, body: { async *[Symbol.asyncIterator]() { if (request.purpose === 'namespace-events') { lists++; yield Buffer.from(JSON.stringify({ apiVersion: 'v1', kind: 'EventList', metadata: { resourceVersion: 'list-rv' }, items: [raw()] })); } else yield Buffer.from(JSON.stringify(namespace)); } }, close: async () => {} }),
    watch: async (_selection, request, input, emit) => { assert.equal(request.purpose, 'namespace-event-watch'); assert.equal(request.query.resourceVersion, 'list-rv'); namespace.metadata.resourceVersion = 'n2'; await emit(encode({ type: 'MODIFIED', object: raw('event', 'event-u', '2') })); watched++; await Promise.race([until.promise, new Promise<void>(resolve => input.addEventListener('abort', () => resolve(), { once: true }))]); } });
   try { const page = await gateway.openEventFollow(open('a', 1, value), signal()); for (let n = 0; n < 100 && !watched; n++) await tick(); assert.equal(watched, 1); assert.equal(lists, 1); const rows = await gateway.pollEventFollow(control(page), signal()); assert.deepEqual(rows.events.map(event => event.type), ['SEED', 'RESYNC', 'MODIFIED']);
    namespace.metadata.uid = 'replacement'; until.resolve(); for (let n = 0; n < 100; n++) { await tick(); const state = await gateway.pollEventFollow(control(page), signal()); if (state.phase === 'error') { assert.equal(state.error, 'STALE_TARGET'); break; } if (n === 99) assert.fail('Namespace replacement must stop old read'); }
  } finally { until.resolve(); gateway.close(); }
});
test('explicit non-current Namespace events keep that original namespace without changing the browsing target', async () => {
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), namespace = { name: 'other', uid: 'other-u', resourceVersion: 'n1' }, value: EventFollowSource = { ...source, target: { ...source.target, configIdentity: snapshot.snapshot.configIdentity }, namespace, scope: { kind: 'namespace', ...namespace } };
  let watched = 0; const until = Promise.withResolvers<void>();
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => {
    assert.ok(request.path.startsWith('/api/v1/namespaces/other')); assert.equal(request.target.namespace, 'default');
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(request.purpose === 'namespace-events' ? { apiVersion: 'v1', kind: 'EventList', metadata: { resourceVersion: 'rv' }, items: [] } : { apiVersion: 'v1', kind: 'Namespace', metadata: namespace })); } }, close: async () => {} };
  }, watch: async (_selection, request, input, emit) => { assert.equal(request.path, '/api/v1/namespaces/other/events'); const row = raw(); row.metadata.namespace = 'other'; await emit(encode({ type: 'ADDED', object: row })); watched++; await Promise.race([until.promise, new Promise<void>(resolve => input.addEventListener('abort', () => resolve(), { once: true }))]); } });
   try { const page = await gateway.openEventFollow(open('a', 1, value), signal()); for (let n = 0; n < 100 && !watched; n++) await tick(); assert.equal(watched, 1); assert.equal((await gateway.pollEventFollow(control(page), signal())).events.find(event => event.row)?.row?.namespace, 'other'); }
  finally { until.resolve(); gateway.close(); }
});
test('aggregate event Follow raw-byte budget covers namespace checks and initial list as well as the watch stream', async () => {
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), value = { ...source, target: { ...source.target, configIdentity: snapshot.snapshot.configIdentity } }; let reads = 0, streams = 0;
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => { reads++; const content = request.purpose === 'namespace-events' ? { apiVersion: 'v1', kind: 'EventList', metadata: { resourceVersion: 'rv' }, items: [] } : { apiVersion: 'v1', kind: 'Namespace', metadata: source.namespace };
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ ...content, padding: 'x'.repeat(1_900_000) })); } }, close: async () => {} };
  }, watch: async () => { streams++; } });
  try { const page = await gateway.openEventFollow(open('a', 1, value), signal()); let state = page; for (let n = 0; n < 150 && state.phase !== 'error'; n++) { await tick(); state = await gateway.pollEventFollow(control(page), signal()); }
    assert.equal(state.error, 'BUDGET_EXCEEDED'); assert.equal(reads, 5); assert.equal(streams, 0);
  } finally { gateway.close(); }
});
