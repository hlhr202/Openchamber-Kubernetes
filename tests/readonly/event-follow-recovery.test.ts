// Pure read protocol/runners with independent synthetic responses. No worker/SDK/CLI/auth/cache/session or write handlers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { eventFollowSourceSchema, eventFollowDeltaSchema, eventFollowPageSchema } from '../../src/shared/event-follow-protocol.ts';
import type { EventFollowSource, EventFollowDelta } from '../../src/shared/event-follow-protocol.ts';
import { eventCollectionPath, eventOccurrences } from '../../src/shared/event-protocol.ts';
import { runEventFollow } from '../../src/service/queries/event-follow-runner.ts';
import { projectEventRow } from '../../src/service/queries/event-source.ts';
import { EventFollowBuffer } from '../../src/host/event-follow-buffer.ts';
import { EventFollowClient } from '../../src/host/event-follow-client.ts';
import type { EventFollowState } from '../../src/host/event-follow-client.ts';
import { createReadTasks, createReadTaskBudget } from '../../src/service/queries/read-tasks.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';

const source: EventFollowSource = { protocol: 2, recoveryPolicy: 'single-410-relist', target: { serviceGeneration: 's', projectId: 'p', configIdentity: 'c', context: 'active', namespace: 'default' },
  selection: { mode: 'default' }, scope: { kind: 'current' }, namespace: { name: 'default', uid: 'ns-u', resourceVersion: 'n1' }, apiVersion: 'v1' };
const signal = () => new AbortController().signal;
const raw = (name = 'event', uid = name, rv = 'e1', count = 2) => ({ apiVersion: 'v1', kind: 'Event', metadata: { name, namespace: 'default', uid, resourceVersion: rv }, involvedObject: { kind: 'Pod', name: 'pod' }, message: 'synthetic', count });
const row = (name = 'event', uid = name, rv = 'e1', count = 2) => projectEventRow(raw(name, uid, rv, count), 'default');
const page = (resourceVersion = 'list-rv', continuation: string | null = null, rows = [row()]) => ({ apiVersion: source.apiVersion, namespace: source.namespace, resourceVersion, continuation, rows });
const marker = (type: 'RELISTING' | 'RESYNC', resourceVersion = 'list-rv', sequence = 1): EventFollowDelta => ({ type, resourceVersion, sequence });
const seed = (sequence = 1, name = 'event', uid = name, rv = 'e1', count = 2): EventFollowDelta => ({ type: 'SEED', resourceVersion: rv, sequence, row: row(name, uid, rv, count) });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const tick = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
const expired = () => new BoundaryError('CONTINUATION_EXPIRED');
function options(changes: Partial<Parameters<typeof runEventFollow>[3]> = {}): Parameters<typeof runEventFollow>[3] {
  let now = 0; return { verify: async () => {}, charge: () => {}, list: async () => page(), clock: () => now, pause: async () => {}, transport: async () => { now += 5000; }, ...changes };
}
test('Follow source must opt into the exact recovery shape; old/missing/unknown policies are rejected', () => {
  assert.ok(eventFollowSourceSchema.safeParse(source).success);
  for (const recoveryPolicy of [undefined, 'none', 'unlimited', 'single-410', 1]) assert.equal(eventFollowSourceSchema.safeParse({ ...source, recoveryPolicy }).success, false);
});
test('recovery markers carry only nonzero List RV, never rows, messages, targets or implicit defaults', () => {
  for (const type of ['RELISTING', 'RESYNC'] as const) {
    assert.ok(eventFollowDeltaSchema.safeParse(marker(type)).success);
    for (const change of [{ row: row() }, { message: 'SYNTHETIC_PRIVATE' }, { resourceVersion: '0' }, { resourceVersion: '' }, { type: 'RESET' }]) assert.equal(eventFollowDeltaSchema.safeParse({ ...marker(type), ...change }).success, false);
  }
});
test('initial complete list emits RESYNC even for zero rows before its first watch', async () => {
  const events: Array<Omit<EventFollowDelta, 'sequence'>> = []; let streams = 0;
  await runEventFollow(source, signal(), event => events.push(event), options({ list: async () => page('empty-list', null, []), transport: async () => { streams++; if (streams === 1) assert.deepEqual(events, [{ type: 'RESYNC', resourceVersion: 'empty-list' }]); }, clock: (() => { let time = 0; return () => time += 5000; })() }));
  assert.equal(streams, 10);
});
test('one HTTP-style 410 waits for old transport settlement, backs off, relists and continues at the new List RV', async () => {
  const closed = Promise.withResolvers<void>(), events: Array<Omit<EventFollowDelta, 'sequence'>> = [], order: string[] = []; let streams = 0, lists = 0;
  const running = runEventFollow(source, signal(), event => { events.push(event); order.push(event.type); }, options({ list: async () => { lists++; order.push(`list${lists}`); return page(`list${lists}`); }, pause: async () => { order.push('pause'); },
    transport: async (_selection, request) => { streams++; if (streams === 1) { await closed.promise; order.push('closed'); throw expired(); } assert.equal(request.query.resourceVersion, 'list2'); }, clock: (() => { let time = 0; return () => time += 5000; })() }));
  await tick(); assert.equal(lists, 1); assert.equal(events.some(event => event.type === 'RELISTING'), false); closed.resolve(); await running;
  assert.equal(lists, 2); assert.equal(streams, 10); assert.ok(order.indexOf('closed') < order.indexOf('RELISTING')); assert.ok(order.indexOf('RELISTING') < order.indexOf('pause')); assert.ok(order.indexOf('pause') < order.indexOf('list2'));
});
test('a streamed Status 410 triggers exactly one same-API list, not a continuation of the expired snapshot', async () => {
  let streams = 0, lists = 0; const events: Array<Omit<EventFollowDelta, 'sequence'>> = [];
  await runEventFollow(source, signal(), event => events.push(event), options({ list: async previous => { assert.equal(previous, undefined); lists++; return page(`list${lists}`); }, transport: async (_s, request, _signal, emit) => {
    if (++streams === 1) await emit(encode({ type: 'ERROR', object: { kind: 'Status', code: 410, message: 'SYNTHETIC_PRIVATE' } })); else assert.equal(request.query.resourceVersion, 'list2');
  }, clock: (() => { let time = 0; return () => time += 5000; })() }));
  assert.deepEqual(events.slice(0, 5).map(event => event.type), ['SEED', 'RESYNC', 'RELISTING', 'SEED', 'RESYNC']); assert.equal(JSON.stringify(events).includes('SYNTHETIC_PRIVATE'), false); assert.equal(lists, 2);
});
test('relist completes all pages at one RV and restarts duplicate detection without retaining old event identities', async () => {
  let streams = 0, lists = 0; const emitted: Array<Omit<EventFollowDelta, 'sequence'>> = [];
  await runEventFollow(source, signal(), event => emitted.push(event), options({ list: async previous => { lists++; if (lists === 1) return page('old'); if (lists === 2) { assert.equal(previous, undefined); return page('new', 'next'); } assert.deepEqual(previous, { resourceVersion: 'new', continuation: 'next' }); return page('new', null, [row('second')]); },
    transport: async (_s, request) => { if (++streams === 1) throw expired(); assert.equal(lists, 3); assert.equal(request.query.resourceVersion, 'new'); }, clock: (() => { let time = 0; return () => time += 5000; })() }));
  assert.equal(lists, 3); assert.deepEqual(emitted.slice(2).map(event => event.type), ['RELISTING', 'SEED', 'SEED', 'RESYNC']);
});
test('second 410 is terminal and does not create a third snapshot or extra backoff', async () => {
  let lists = 0, streams = 0, pauses = 0;
  await assert.rejects(runEventFollow(source, signal(), () => {}, options({ list: async () => { lists++; return page(); }, transport: async () => { streams++; throw expired(); }, pause: async () => { pauses++; } })), /CONTINUATION_EXPIRED/);
  assert.equal(lists, 2); assert.equal(streams, 2); assert.equal(pauses, 1);
});
test('401/403/404/429/network/malformed transport errors never relist or retry authentication', async () => {
  for (const code of ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'QUERY_LIMIT', 'READ_TRANSPORT_UNAVAILABLE', 'RESOURCE_INVALID'] as const) { let lists = 0, streams = 0;
    await assert.rejects(runEventFollow(source, signal(), () => {}, options({ list: async () => { lists++; return page(); }, transport: async () => { streams++; throw new BoundaryError(code); } })), new RegExp(code)); assert.equal(lists, 1); assert.equal(streams, 1);
  }
});
test('initial list expiry and recovery list expiry are not retried as watch expiration', async () => {
  for (const first of [true, false]) { let lists = 0, streams = 0;
    await assert.rejects(runEventFollow(source, signal(), () => {}, options({ list: async () => { if (++lists > (first ? 0 : 1)) throw expired(); return page(); }, transport: async () => { streams++; throw expired(); } })), /CONTINUATION_EXPIRED/);
    assert.equal(lists, first ? 1 : 2); assert.equal(streams, first ? 0 : 1);
  }
});
test('Namespace/config verification 410 inside a chunk is not mistaken for a recoverable stream 410', async () => {
  let checkingChunk = false, lists = 0;
  await assert.rejects(runEventFollow(source, signal(), () => {}, options({ verify: async () => { if (checkingChunk) throw expired(); }, list: async () => { lists++; return page(); }, transport: async (_s, _r, _i, emit) => { checkingChunk = true; await emit(encode({ type: 'BOOKMARK', object: { metadata: { resourceVersion: 'b' } } })); } })), /CONTINUATION_EXPIRED/);
  assert.equal(lists, 1);
});
test('ten stream attempts are an absolute task limit even when the last one expires', async () => {
  let streams = 0, lists = 0;
  await assert.rejects(runEventFollow(source, signal(), () => {}, options({ list: async () => { lists++; return page(); }, transport: async () => { if (++streams === 10) throw expired(); }, clock: (() => { let time = 0; return () => time += 5000; })() })), /CONTINUATION_EXPIRED/);
  assert.equal(streams, 10); assert.equal(lists, 1);
});
test('cancellation during backoff never starts a recovery list or a new watch', async () => {
  const controller = new AbortController(); let lists = 0, streams = 0;
  await assert.rejects(runEventFollow(source, controller.signal, () => {}, options({ list: async () => { lists++; return page(); }, transport: async () => { streams++; throw expired(); }, pause: async () => { controller.abort(); } })), /QUERY_CANCELLED/);
  assert.equal(lists, 1); assert.equal(streams, 1);
});
test('a cancelled relist returning late cannot publish seeds/RESYNC or start another watch', async () => {
  const controller = new AbortController(), blocked = Promise.withResolvers<ReturnType<typeof page>>(), entered = Promise.withResolvers<void>(); let lists = 0, streams = 0; const types: string[] = [];
  const running = runEventFollow(source, controller.signal, event => types.push(event.type), options({ list: async () => { if (++lists === 1) return page(); entered.resolve(); return blocked.promise; }, transport: async () => { streams++; throw expired(); } }));
  await entered.promise; controller.abort(); blocked.resolve(page('late')); await assert.rejects(running, /QUERY_CANCELLED/); assert.equal(streams, 1); assert.deepEqual(types, ['SEED', 'RESYNC', 'RELISTING']);
});
test('Namespace replacement before relist fails without following a new UID', async () => {
  let changed = false, lists = 0;
  await assert.rejects(runEventFollow(source, signal(), () => {}, options({ verify: async () => { if (changed) throw new BoundaryError('STALE_TARGET'); }, list: async () => { lists++; return page(); }, transport: async () => { changed = true; throw expired(); } })), /STALE_TARGET/); assert.equal(lists, 1);
});
test('relist API/namespace/UID substitution and opaque List RV drift fail before RESYNC or renewed watch', async () => {
  for (const mode of ['api', 'namespace', 'uid', 'rv']) { let lists = 0, streams = 0; const types: string[] = [];
    await assert.rejects(runEventFollow(source, signal(), event => types.push(event.type), options({ list: async () => { lists++; if (lists === 1) return page(); if (mode === 'rv') return lists === 2 ? page('new', 'next') : page('other');
      return { ...page('new'), ...(mode === 'api' ? { apiVersion: 'events.k8s.io/v1' as const } : { namespace: { ...source.namespace, ...(mode === 'uid' ? { uid: 'other' } : { name: 'other' }) } }) }; }, transport: async () => { streams++; throw expired(); } })), /STALE_TARGET/);
    assert.equal(streams, 1); assert.equal(types.filter(type => type === 'RESYNC').length, 1);
  }
});
test('relist repeated UID/name or continuation fails with no successful snapshot completion', async () => {
  for (const mode of ['uid', 'name', 'continuation']) { let lists = 0;
    await assert.rejects(runEventFollow(source, signal(), () => {}, options({ list: async () => { lists++; if (lists === 1) return page(); return page('new', 'same', mode === 'continuation' ? [] : [lists === 2 ? row() : mode === 'uid' ? row('other', 'event') : row('event', 'other')]); }, transport: async () => { throw expired(); } })), /RESOURCE_INVALID|QUERY_LIMIT/);
  }
});
test('relist with a continuation after page 20 fails whole; initial/recovery page budgets are finite', async () => {
  let lists = 0, streams = 0;
  await assert.rejects(runEventFollow(source, signal(), () => {}, options({ list: async () => ++lists === 1 ? page() : page('new', `next${lists}`, []), transport: async () => { streams++; throw expired(); } })), /QUERY_LIMIT/); assert.equal(lists, 21); assert.equal(streams, 1);
});
test('zero/invalid List RV and foreign event namespaces cannot seed or start a recovered stream', async () => {
  for (const invalid of [page('0'), page(''), page('rv', null, [{ ...row(), namespace: 'other' }])]) {
    await assert.rejects(runEventFollow(source, signal(), () => {}, options({ list: async () => invalid })), /RESOURCE_INVALID|STALE_TARGET/);
  }
});
test('aggregate byte charging is continuous across 410, not reset by the new snapshot', async () => {
  let charged = 0, streams = 0, lists = 0;
  await assert.rejects(runEventFollow(source, signal(), () => {}, options({ charge: bytes => { charged += bytes; if (charged > 100) throw new BoundaryError('BUDGET_EXCEEDED'); }, list: async () => { lists++; return page(); }, transport: async (_s, _r, _i, emit) => { streams++; if (streams === 1) { await emit(Buffer.from(' '.repeat(60))); throw expired(); } await emit(Buffer.from(' '.repeat(60))); } })), /BUDGET_EXCEEDED/);
  assert.equal(charged, 120); assert.equal(lists, 2); assert.equal(streams, 2);
});
test('4096 publication budget includes SEED/RELISTING/RESYNC and is not reset on recovery', async () => {
  let streams = 0, events = 0;
  await assert.rejects(runEventFollow(source, signal(), () => { events++; }, options({ transport: async (_s, _r, _i, emit) => { if (++streams === 1) throw expired(); for (let n = 0; n < 4092; n++) await emit(encode({ type: 'BOOKMARK', object: { metadata: { resourceVersion: 'b' } } })); } })), /BUDGET_EXCEEDED/);
  assert.equal(events, 4096); assert.equal(streams, 2);
});
test('RELISTING clears expired/deleted old rows, not just upserts new seeds; count and RV can decrease without summing', () => {
  const buffer = new EventFollowBuffer(); buffer.apply(seed(1, 'old'), 'default'); buffer.apply(seed(2, 'event', 'event', '99', 9), 'default'); buffer.apply(marker('RESYNC', 'old-rv', 3), 'default'); assert.equal(buffer.synchronizing, false);
  buffer.apply(marker('RELISTING', 'old-rv', 4), 'default'); assert.equal(buffer.rows.length, 0); assert.equal(buffer.truncated, true); assert.equal(buffer.synchronizing, true);
  buffer.apply(seed(5, 'event', 'event', '1', 1), 'default'); buffer.apply(marker('RESYNC', 'new-rv', 6), 'default'); assert.equal(buffer.synchronizing, false); assert.equal(buffer.rows.some(row => row.name === 'old'), false); const current = buffer.rows[0]; assert.ok(current); assert.equal(eventOccurrences(current), 1); assert.equal(buffer.truncated, true);
});
test('empty successful relist removes all old rows and preserves the historical gap disclosure', () => {
  const buffer = new EventFollowBuffer(); buffer.apply(seed(), 'default'); buffer.apply(marker('RELISTING'), 'default'); buffer.apply(marker('RESYNC', 'empty'), 'default'); assert.deepEqual(buffer.rows, []); assert.equal(buffer.synchronizing, false); assert.equal(buffer.truncated, true);
});
test('partial/failed relist never declares a complete snapshot; reset clears both rows and old gap state', () => {
  const buffer = new EventFollowBuffer(); buffer.apply(marker('RELISTING'), 'default'); buffer.apply(seed(), 'default'); assert.equal(buffer.synchronizing, true); assert.equal(buffer.truncated, true); buffer.clear(); assert.equal(buffer.rows.length, 0); assert.equal(buffer.synchronizing, true); assert.equal(buffer.truncated, false);
});
test('ring loss remains explicitly partial even after a later RESYNC, and lost completion is conservative', () => {
  const buffer = new EventFollowBuffer(); buffer.apply(seed(), 'default'); buffer.clear(true); buffer.apply(seed(20, 'suffix'), 'default'); assert.equal(buffer.synchronizing, true); buffer.apply(marker('RESYNC', 'new', 21), 'default'); assert.equal(buffer.truncated, true); assert.equal(buffer.synchronizing, false);
});
test('SDK-shaped client exposes markers across pages and Stop during relist releases only its read consumer', async () => {
  const done = Promise.withResolvers<void>(); let emit: ((event: Omit<EventFollowDelta, 'sequence'>) => void) | undefined, pending: (() => void) | undefined; const states: EventFollowState[] = [];
  const tasks = createReadTasks({ generation: 's', kind: 'event-follow', sourceSchema: eventFollowSourceSchema, eventSchema: eventFollowDeltaSchema, pageSchema: eventFollowPageSchema,
    run: async (_source, _signal, publish) => { emit = publish; await done.promise; } });
  const client = new EventFollowClient(async request => { const input = JSON.parse(request.body) as unknown; const data = request.path.endsWith('/open') ? tasks.open(input) : request.path.endsWith('/poll') ? tasks.poll(input) : (tasks.release(input), { released: true }); return { status: 200, body: JSON.stringify(data) }; }, state => states.push(state), 'a'.repeat(32), callback => { pending = callback; return () => { pending = undefined; }; });
  const poll = async () => { const run = pending; pending = undefined; run?.(); await tick(); };
  try { await client.start(source); await tick(); emit?.(seed()); emit?.(marker('RESYNC')); await poll(); assert.equal(states.at(-1)?.synchronizing, false); emit?.(marker('RELISTING')); await poll(); assert.equal(states.at(-1)?.rows.length, 0); assert.equal(states.at(-1)?.synchronizing, true); assert.equal(states.at(-1)?.truncated, true); client.stop(); assert.equal(states.at(-1)?.error, 'QUERY_CANCELLED'); emit?.(seed()); assert.equal(states.at(-1)?.rows.length, 0); }
  finally { client.dispose(); done.resolve(); tasks.close(); }
});
test('recovery remains in the same shared read task/expiry/lease; one consumer release does not cancel its peer', async () => {
  const done = Promise.withResolvers<void>(); let emit: ((event: Omit<EventFollowDelta, 'sequence'>) => void) | undefined, cancelled: AbortSignal | undefined;
  const tasks = createReadTasks({ generation: 's', kind: 'event-follow', budget: createReadTaskBudget(), sourceSchema: eventFollowSourceSchema, eventSchema: eventFollowDeltaSchema, pageSchema: eventFollowPageSchema, clock: () => 0,
    run: async (_source, input, publish) => { emit = publish; cancelled = input; await done.promise; } });
  try { const a = tasks.open({ ...source, consumer: { view: 'a'.repeat(32), epoch: 1 } }), b = tasks.open({ ...source, consumer: { view: 'b'.repeat(32), epoch: 1 } }); await tick(); emit?.(marker('RELISTING')); tasks.release({ protocol: 2, handle: a.handle, after: 0 }); assert.equal(cancelled?.aborted, false);
    const current = tasks.poll({ protocol: 2, handle: b.handle, after: 0 }); assert.equal(current.handle.task, a.handle.task); assert.equal(current.expiresAt, a.expiresAt); assert.equal(current.leaseUntil, b.leaseUntil); assert.equal(current.events[0]?.type, 'RELISTING'); }
  finally { done.resolve(); tasks.close(); }
});
test('gateway recovers core/grouped API in the same task and namespace, never negotiates another event version', async () => {
  for (const apiVersion of ['v1', 'events.k8s.io/v1'] as const) {
    const stop = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(); let lists = 0, streams = 0;
    const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
    const snapshot = await config.read({ mode: 'default' }), value = { ...source, apiVersion, target: { ...source.target, configIdentity: snapshot.snapshot.configIdentity } };
    const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => { const event = request.purpose === 'namespace-events'; if (event) { assert.equal(request.path, eventCollectionPath(apiVersion, 'default')); lists++; }
      const body = event ? { apiVersion, kind: 'EventList', metadata: { resourceVersion: `list${lists}` }, items: [] } : { apiVersion: 'v1', kind: 'Namespace', metadata: source.namespace };
      return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } }, close: async () => {} };
    }, watch: async (_selection, request, input) => { streams++; assert.equal(request.path, eventCollectionPath(apiVersion, 'default')); if (streams === 1) throw expired(); assert.equal(request.query.resourceVersion, 'list2'); ready.resolve(); await Promise.race([stop.promise, new Promise<void>(resolve => input.addEventListener('abort', () => resolve(), { once: true }))]); } });
    try { const opened = await gateway.openEventFollow({ ...value, consumer: { view: 'a'.repeat(32), epoch: 1 } }, signal()); await ready.promise; const current = await gateway.pollEventFollow({ protocol: 2, handle: opened.handle, after: 0 }, signal()); assert.equal(lists, 2); assert.equal(streams, 2); assert.equal(current.handle.task, opened.handle.task); assert.equal(current.expiresAt, opened.expiresAt); assert.deepEqual(current.events.map(event => event.type), ['RESYNC', 'RELISTING', 'RESYNC']); }
    finally { stop.resolve(); gateway.close(); }
  }
});
