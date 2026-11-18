// Detached synthetic read bodies/tasks only. No filesystem, SDK, CLI, worker or operation/session execution.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { watchEventSchema, watchSourceSchema } from '../../src/shared/watch-protocol.ts';
import type { WatchSource, WatchEvent } from '../../src/shared/watch-protocol.ts';
import { planWatchRelist, projectWatchRelist } from '../../src/service/queries/watch-relist.ts';
import { runResourceWatch } from '../../src/service/queries/watch-runner.ts';
import { createResourceReader } from '../../src/service/queries/resource-reader.ts';
import { createWatchTasks } from '../../src/service/queries/watch-tasks.ts';
import { WatchClient } from '../../src/host/watch-client.ts';
import type { WatchState } from '../../src/host/watch-client.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { projectWatchEvent } from '../../src/service/queries/watch-source.ts';
const source: WatchSource = { protocol: 2, recoveryPolicy: 'single-410-relist', target: { serviceGeneration: 's', projectId: 'p', configIdentity: 'c', context: 'active', namespace: 'default' }, selection: { mode: 'default' }, resource: 'pods', resourceVersion: 'old:opaque' };
const signal = () => new AbortController().signal, expired = () => new BoundaryError('CONTINUATION_EXPIRED'), secret = 'SYNTHETIC_PRIVATE';
const object = (name = 'pod', uid = 'u') => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name, uid, namespace: 'default', resourceVersion: 'item-rv', annotations: { token: secret } }, data: { password: secret }, spec: { token: secret } });
const list = (rv = 'list:new', continuation = '', items: unknown[] = [{ metadata: object().metadata, data: object().data, spec: object().spec }]) => ({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: rv, continue: continuation }, items });
const budget = () => ({ bytes: 0, reads: 0 });
function readerFixture(pages: unknown[]) {
  const requests: Array<ReturnType<typeof planWatchRelist>> = []; let index = 0, changed = false;
  const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => changed ? { ...target, namespace: 'changed' } : target,
    read: async request => { requests.push(request); const text = JSON.stringify(pages[index++]); return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(text ?? '{}'); } }, close: async () => {} }; } });
  return { reader, requests, change: () => { changed = true; }, close: () => reader.close() };
}
test('relist uses the exact builtin collection/scope with limit and optional object-name filter, never the expired RV', () => {
  const plan = planWatchRelist(source, 'token+/='); assert.equal(plan.purpose, 'resource-list'); assert.equal(plan.path, '/api/v1/namespaces/default/pods'); assert.deepEqual(plan.query, { limit: '100', continue: 'token+/=' });
  const selected = planWatchRelist({ ...source, object: { name: 'pod', uid: 'u' } }); assert.deepEqual(selected.query, { limit: '100', fieldSelector: 'metadata.name=pod' });
  assert.equal(planWatchRelist({ ...source, resource: 'nodes' }).path, '/api/v1/nodes'); assert.ok(kubectlReadArguments(plan, '/synthetic/pipe').some(arg => arg.includes('limit=100')));
});
test('relist planning rejects malformed continuations and cannot smuggle arbitrary watch paths or resource versions', () => {
  for (const token of ['x\nsecret', 'x'.repeat(8193)]) assert.throws(() => planWatchRelist(source, token), /INVALID_INPUT/);
  assert.throws(() => planWatchRelist({ ...source, resourceVersion: '0' }), /INVALID_INPUT/);
});
test('relist projects metadata identities only and never forwards data, annotations, spec or raw list objects', () => {
  const projected = projectWatchRelist(list(), source); assert.deepEqual(projected, { resourceVersion: 'list:new', continuation: '', identities: [{ name: 'pod', uid: 'u' }] }); assert.equal(JSON.stringify(projected).includes(secret), false);
});
test('typed relist accepts missing or partial item TypeMeta without relaxing actual Watch envelopes', () => {
  for (const typeMeta of [{}, { apiVersion: 'v1' }, { kind: 'Pod' }, { apiVersion: 'v1', kind: 'Pod' }]) {
    const item = { metadata: object().metadata, ...typeMeta }, before = JSON.stringify(item);
    assert.deepEqual(projectWatchRelist(list('new', '', [item]), source).identities, [{ name: 'pod', uid: 'u' }]);
    assert.equal(JSON.stringify(item), before);
  }
  assert.throws(() => projectWatchEvent({ type: 'ADDED', object: { metadata: object().metadata } }, source), /RESOURCE_INVALID/);
  for (const typeMeta of [{ apiVersion: 'apps/v1' }, { kind: 'Secret' }, { apiVersion: null }, { kind: '' }]) {
    assert.throws(() => projectWatchRelist(list('new', '', [{ metadata: object().metadata, ...typeMeta }]), source), /RESOURCE_INVALID/);
  }
  for (const metadata of [{ ...object().metadata, uid: undefined }, { ...object().metadata, resourceVersion: undefined }]) {
    assert.throws(() => projectWatchRelist(list('new', '', [{ metadata }]), source), /RESOURCE_INVALID/);
  }
});
test('cluster-scoped relist inherits Node type but never fabricates or accepts a namespace', () => {
  const nodeSource = { ...source, resource: 'nodes' as const };
  const metadata = { name: 'node', uid: 'node-uid', resourceVersion: 'node-rv' };
  const page = { apiVersion: 'v1', kind: 'NodeList', metadata: { resourceVersion: 'list-rv' }, items: [{ metadata }] };
  assert.deepEqual(projectWatchRelist(page, nodeSource).identities, [{ name: 'node', uid: 'node-uid' }]);
  assert.throws(() => projectWatchRelist({ ...page, items: [{ metadata: { ...metadata, namespace: 'default' } }] }, nodeSource), /STALE_TARGET/);
});
test('list projection enforces exact GVK and namespace, with nonzero opaque collection RV', () => {
  for (const change of [{ kind: 'SecretList' }, { apiVersion: 'apps/v1' }, { metadata: { resourceVersion: '0' } }, { items: [{ ...object(), metadata: { ...object().metadata, namespace: 'other' } }] }]) assert.throws(() => projectWatchRelist({ ...list(), ...change }, source));
});
test('object relist rejects a same-name new UID and unrelated names instead of rebinding', () => {
  const selected = { ...source, object: { name: 'pod', uid: 'u' } };
  for (const item of [object('pod', 'replacement'), object('other')]) assert.throws(() => projectWatchRelist(list('new', '', [item]), selected), /STALE_TARGET/);
});
test('list page count/continuation shape is bounded and unknown sensitive fields do not become defaults', () => {
  assert.throws(() => projectWatchRelist(list('r', '', Array.from({ length: 101 }, (_, n) => object(`pod-${n}`, `u-${n}`))), source), /RESOURCE_INVALID/);
  assert.throws(() => projectWatchRelist(list('r', 'bad\n'), source), /RESOURCE_INVALID/); assert.deepEqual(projectWatchRelist(list('r', '', []), source).identities, []);
});
test('reader consumes all relist pages at one collection RV in the existing finite reader pool', async () => {
  const f = readerFixture([list('opaque/new', 'next', []), list('opaque/new', '', [object()])]);
  try { const used = budget(); assert.equal(await f.reader.watchRelist(source, signal(), used), 'opaque/new'); assert.equal(used.reads, 2); assert.ok(used.bytes > 0); assert.equal(f.requests[1]?.query.continue, 'next'); assert.ok(f.requests.every(request => request.query.resourceVersion === undefined)); } finally { f.close(); }
});
test('changing List RV rejects a mixed relist snapshot rather than publishing a new watch cursor', async () => {
  const f = readerFixture([list('r1', 'next', []), list('r2', '', [])]); try { await assert.rejects(f.reader.watchRelist(source, signal(), budget()), /STALE_TARGET/); } finally { f.close(); }
});
test('repeated continuation tokens fail without an unbounded pagination loop', async () => {
  const f = readerFixture([list('r', 'same', []), list('r', 'same', [])]); try { await assert.rejects(f.reader.watchRelist(source, signal(), budget()), /RESOURCE_INVALID/); assert.equal(f.requests.length, 2); } finally { f.close(); }
});
test('duplicate identities across pages fail, without manufacturing a consistent complete list', async () => {
  for (const second of [object(), object('other', 'u'), object('pod', 'other')]) {
    const f = readerFixture([list('r', 'next'), list('r', '', [second])]); try { await assert.rejects(f.reader.watchRelist(source, signal(), budget()), /RESOURCE_INVALID/); } finally { f.close(); }
  }
});
test('a continuation after twenty pages fails explicitly rather than truncating or starting another list', async () => {
  const f = readerFixture(Array.from({ length: 20 }, (_, n) => list('r', `next-${n}`, []))); try { await assert.rejects(f.reader.watchRelist(source, signal(), budget()), /BUDGET_EXCEEDED/); assert.equal(f.requests.length, 20); } finally { f.close(); }
});
test('empty collection is valid but an absent object after full filtered list is NOT_FOUND', async () => {
  const f = readerFixture([list('r', '', []), list('r', '', [])]); try { assert.equal(await f.reader.watchRelist(source, signal(), budget()), 'r'); await assert.rejects(f.reader.watchRelist({ ...source, object: { name: 'pod', uid: 'u' } }, signal(), budget()), /NOT_FOUND/); } finally { f.close(); }
});
test('relist shares raw byte/read budgets and fails before another transport when exhausted', async () => {
  const f = readerFixture([list()]); try { await assert.rejects(f.reader.watchRelist(source, signal(), { bytes: 8_000_000, reads: 1 }), /BUDGET_EXCEEDED/); await assert.rejects(f.reader.watchRelist(source, signal(), { bytes: 0, reads: 30 }), /BUDGET_EXCEEDED/); assert.equal(f.requests.length, 0); } finally { f.close(); }
});
test('target drift and pre-cancellation cannot start a relist read against a new target', async () => {
  const f = readerFixture([list()]); try { f.change(); await assert.rejects(f.reader.watchRelist(source, signal(), budget()), /STALE_TARGET/); const controller = new AbortController(); controller.abort(); await assert.rejects(f.reader.watchRelist(source, controller.signal, budget()), /QUERY_CANCELLED/); assert.equal(f.requests.length, 0); } finally { f.close(); }
});
test('one HTTP410 emits explicit relisting/resync and resumes from the opaque NEW List RV, within ten watch attempts', async () => {
  const events: Array<Omit<WatchEvent, 'sequence'>> = [], versions: string[] = []; let now = 0, relists = 0, pauses = 0;
  await runResourceWatch(source, signal(), event => events.push(event), { clock: () => now, verify: async () => {}, pause: async () => { pauses++; },
    relist: async (_source, _signal, used) => { relists++; used.bytes += 500; used.reads++; return 'new/opaque:rv'; },
    transport: async (_selection, request) => { versions.push(request.query.resourceVersion ?? ''); if (versions.length === 1) throw expired(); now += 5000; } });
  assert.equal(relists, 1); assert.equal(versions.length, 10); assert.equal(versions[1], 'new/opaque:rv'); assert.equal(pauses, 9); assert.deepEqual(events.map(event => event.type), ['RELISTING', 'RESYNC']); assert.equal(events[1]?.resourceVersion, 'new/opaque:rv');
});
test('ERROR Status410 inside a stream takes the same bounded recovery path, without exposing its message', async () => {
  let calls = 0, now = 0; const events: unknown[] = [];
  await runResourceWatch(source, signal(), event => events.push(event), { clock: () => now, verify: async () => {}, pause: async () => {}, relist: async () => 'new', transport: async (_s, _r, _signal, emit) => { if (++calls === 1) await emit(Buffer.from(JSON.stringify({ type: 'ERROR', object: { kind: 'Status', code: 410, message: secret } }) + '\n')); now += 5000; } });
  assert.equal(calls, 10); assert.equal(JSON.stringify(events).includes(secret), false); assert.equal(events.length, 2);
});
test('a second expired watch never relists twice, recursively recovers, or renews its task lifetime', async () => {
  let reads = 0, lists = 0; await assert.rejects(runResourceWatch(source, signal(), () => {}, { verify: async () => {}, pause: async () => {}, relist: async () => { lists++; return 'new'; }, transport: async () => { reads++; throw expired(); } }), /CONTINUATION_EXPIRED/); assert.equal(reads, 2); assert.equal(lists, 1);
});
test('auth/forbidden/notfound/network/budget/parse errors are terminal with no list or automatic retry', async () => {
  for (const code of ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'READ_TRANSPORT_UNAVAILABLE', 'QUERY_LIMIT', 'BUDGET_EXCEEDED', 'RESOURCE_INVALID'] as const) {
    let reads = 0, lists = 0; await assert.rejects(runResourceWatch(source, signal(), () => {}, { verify: async () => {}, relist: async () => { lists++; return 'new'; }, transport: async () => { reads++; throw new BoundaryError(code); } }), new RegExp(code)); assert.equal(reads, 1); assert.equal(lists, 0);
  }
});
test('an expired or forbidden relist is final and never turns its fallback token into an inconsistent snapshot', async () => {
  for (const code of ['CONTINUATION_EXPIRED', 'FORBIDDEN'] as const) {
    let reads = 0; const events: string[] = []; await assert.rejects(runResourceWatch(source, signal(), e => events.push(e.type), { verify: async () => {}, pause: async () => {}, relist: async () => { throw new BoundaryError(code); }, transport: async () => { reads++; throw expired(); } }), new RegExp(code)); assert.equal(reads, 1); assert.deepEqual(events, ['RELISTING']);
  }
});
test('cancellation during recovery backoff prevents any relist or restart', async () => {
  const controller = new AbortController(); let lists = 0; await assert.rejects(runResourceWatch(source, controller.signal, () => {}, { verify: async () => {}, pause: async () => { controller.abort(); }, relist: async () => { lists++; return 'new'; }, transport: async () => { throw expired(); } }), /QUERY_CANCELLED/); assert.equal(lists, 0);
});
test('late relist after cancellation cannot publish RESYNC or start another watch', async () => {
  const controller = new AbortController(); let reads = 0; const events: string[] = []; await assert.rejects(runResourceWatch(source, controller.signal, e => events.push(e.type), { verify: async () => {}, pause: async () => {}, relist: async () => { controller.abort(); return 'new'; }, transport: async () => { reads++; throw expired(); } }), /QUERY_CANCELLED/); assert.equal(reads, 1); assert.deepEqual(events, ['RELISTING']);
});
test('target change discovered after relist prevents resync publication and a new target watch', async () => {
  let changed = false, reads = 0; const events: string[] = []; await assert.rejects(runResourceWatch(source, signal(), e => events.push(e.type), { verify: async () => { if (changed) throw new BoundaryError('STALE_TARGET'); }, pause: async () => {}, relist: async () => { changed = true; return 'new'; }, transport: async () => { reads++; throw expired(); } }), /STALE_TARGET/); assert.equal(reads, 1); assert.deepEqual(events, ['RELISTING']);
});
test('malformed/zero relist RV cannot become a fresh watch from an unvalidated cursor', async () => {
  for (const rv of ['', '0', 'bad\n']) await assert.rejects(runResourceWatch(source, signal(), () => {}, { verify: async () => {}, pause: async () => {}, relist: async () => rv, transport: async () => { throw expired(); } }), /RESOURCE_INVALID/);
});
test('relist and watch share the eight-MB aggregate instead of receiving fresh per-recovery quotas', async () => {
  let calls = 0; await assert.rejects(runResourceWatch(source, signal(), () => {}, { verify: async () => {}, pause: async () => {}, relist: async (_s, _signal, used) => { assert.ok(used.bytes > 0); used.bytes = 8_000_001; return 'new'; }, transport: async (_s, _r, _signal, emit) => { calls++; await emit(Buffer.from(JSON.stringify({ type: 'BOOKMARK', object: { metadata: { resourceVersion: 'last' } } }) + '\n')); throw expired(); } }), /BUDGET_EXCEEDED/); assert.equal(calls, 1);
});
test('the final watch attempt cannot recover into an eleventh attempt', async () => {
  let calls = 0, lists = 0, now = 0; await assert.rejects(runResourceWatch(source, signal(), () => {}, { verify: async () => {}, clock: () => now, pause: async () => {}, relist: async () => { lists++; return 'new'; }, transport: async () => { if (++calls === 10) throw expired(); now += 5000; } }), /CONTINUATION_EXPIRED/); assert.equal(calls, 10); assert.equal(lists, 0);
});
test('required source policy rejects old/mixed shapes, without silent recovery defaults', () => {
  assert.equal(watchSourceSchema.safeParse({ ...source, recoveryPolicy: undefined }).success, false); assert.equal(watchSourceSchema.safeParse({ ...source, recoveryPolicy: 'infinite' }).success, false);
});
test('resync/relisting markers carry only RV, real object events require name/UID and bookmarks cannot smuggle identities', () => {
  for (const type of ['RELISTING', 'RESYNC', 'BOOKMARK']) { assert.equal(watchEventSchema.safeParse({ sequence: 1, type, resourceVersion: 'r' }).success, true); assert.equal(watchEventSchema.safeParse({ sequence: 1, type, resourceVersion: 'r', name: 'pod', uid: 'u' }).success, false); }
  assert.equal(watchEventSchema.safeParse({ sequence: 1, type: 'ADDED', resourceVersion: 'r' }).success, false);
});
test('client preserves visible recovery status across empty polls and invalidates at both markers without replaying payloads', async () => {
  let emit: ((event: Omit<WatchEvent, 'sequence'>) => void) | undefined; const done = Promise.withResolvers<void>(), states: WatchState[] = [];
  const tasks = createWatchTasks({ generation: 's', run: async (_s, _signal, publish) => { emit = publish; await done.promise; } }); let scheduled: (() => void) | undefined;
  const client = new WatchClient(async request => { const input: unknown = JSON.parse(request.body); if (request.path.endsWith('/release')) { tasks.release(input); return { status: 200, body: '{"protocol":2,"released":true}' }; } return { status: 200, body: JSON.stringify(request.path.endsWith('/open') ? tasks.open(input) : tasks.poll(input)) }; }, state => states.push(state), 'a'.repeat(32), callback => { scheduled = callback; return () => { scheduled = undefined; }; });
  const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  try { await client.start(source); await tick(); assert.ok(emit); emit({ type: 'RELISTING', resourceVersion: 'old' }); scheduled?.(); await tick(); assert.equal(states.at(-1)?.recovery, 'relisting'); assert.equal(states.at(-1)?.changed, true);
    emit({ type: 'RESYNC', resourceVersion: 'new' }); scheduled?.(); await tick(); assert.equal(states.at(-1)?.recovery, 'resynced'); assert.equal(states.at(-1)?.changed, true); scheduled?.(); await tick(); assert.equal(states.at(-1)?.recovery, 'resynced'); assert.equal(states.at(-1)?.changed, false); client.reset(); assert.equal(states.at(-1)?.recovery, undefined);
  } finally { client.dispose(); done.resolve(); tasks.close(); }
});
test('real gateway orchestration connects one resource-list recovery to the same owned read task and strips synthetic secrets', async () => {
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read(source.selection), current = { ...source, target: { ...source.target, configIdentity: snapshot.snapshot.configIdentity } }, done = Promise.withResolvers<void>(); let watches = 0, lists = 0;
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => { assert.equal(request.purpose, 'resource-list'); assert.equal(request.path, '/api/v1/namespaces/default/pods'); lists++; return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(list('new:rv'))); } }, close: async () => {} }; },
    watch: async (_selection, request, _signal, emit) => { if (++watches === 1) throw expired(); assert.equal(request.query.resourceVersion, 'new:rv'); await emit(Buffer.from(JSON.stringify({ type: 'BOOKMARK', object: { metadata: { resourceVersion: 'new:rv' } } }) + '\n')); await done.promise; } });
  try { const page = await gateway.openWatch({ ...current, consumer: { view: 'f'.repeat(32), epoch: 1 } }, signal());
    // One real 250ms read-only backoff is intentionally exercised; no CLI/worker/product filesystem is involved.
    for (let wait = 0; wait < 40 && watches < 2; wait++) await new Promise(resolve => setTimeout(resolve, 50));
    const result = await gateway.pollWatch({ protocol: 2, handle: page.handle, after: 0 }, signal());
    assert.equal(lists, 1); assert.equal(watches, 2); assert.deepEqual(result.events.slice(0, 2).map(event => event.type), ['RELISTING', 'RESYNC']); assert.equal(JSON.stringify(result).includes(secret), false); gateway.releaseWatch({ protocol: 2, handle: page.handle, after: 0 });
  } finally { done.resolve(); gateway.close(); }
});
test('recovery markers consume the original event quota and cannot create a fresh output allowance', async () => {
  const events: string[] = []; let calls = 0;
  const frame = JSON.stringify({ type: 'BOOKMARK', object: { metadata: { resourceVersion: 'r' } } }) + '\n';
  await assert.rejects(runResourceWatch(source, signal(), event => events.push(event.type), { verify: async () => {}, pause: async () => {}, relist: async () => 'new',
    transport: async (_selection, _request, _signal, emit) => { calls++; await emit(Buffer.from(frame.repeat(4095))); throw expired(); } }), /BUDGET_EXCEEDED/);
  assert.equal(calls, 1); assert.equal(events.length, 4096); assert.equal(events.at(-1), 'RELISTING'); assert.equal(events.includes('RESYNC'), false);
});
