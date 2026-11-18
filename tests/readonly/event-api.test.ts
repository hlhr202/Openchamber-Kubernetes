// Synthetic reads/protocols only. No real CLI/worker/SDK, cached auth, cluster or operation/session lifecycle.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { eventApiVersionSchema, eventCollectionPath, eventOccurrences, eventLastObserved } from '../../src/shared/event-protocol.ts';
import type { EventApiVersion } from '../../src/shared/event-protocol.ts';
import { eventFollowSourceSchema } from '../../src/shared/event-follow-protocol.ts';
import type { EventFollowSource, EventFollowDelta } from '../../src/shared/event-follow-protocol.ts';
import { projectEventPage, projectEventRow } from '../../src/service/queries/event-source.ts';
import { projectEventFollowDelta, planEventFollow } from '../../src/service/queries/event-follow-source.ts';
import { runEventFollow } from '../../src/service/queries/event-follow-runner.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { parseReadWorkerStart } from '../../src/service/queries/read-worker-protocol.ts';
import { EventClient } from '../../src/host/event-client.ts';
import type { EventState } from '../../src/host/event-client.ts';
const api: EventApiVersion = 'events.k8s.io/v1', signal = () => new AbortController().signal, marker = 'SYNTHETIC_EVENT_SECRET';
const namespace = { name: 'default', uid: 'ns-u', resourceVersion: 'n1' };
const source: EventFollowSource = { protocol: 2, recoveryPolicy: 'single-410-relist', target: { serviceGeneration: 's', projectId: 'p', configIdentity: 'c', context: 'active', namespace: 'default' }, selection: { mode: 'default' }, scope: { kind: 'current' }, namespace, apiVersion: api };
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;
const raw = (change: Record<string, unknown> = {}) => ({ apiVersion: api, kind: 'Event', metadata: { name: 'event', namespace: 'default', uid: 'e-u', resourceVersion: 'e1', creationTimestamp: '2026-10-25T00:00:00Z', annotations: { private: marker } },
  regarding: { apiVersion: 'v1', kind: 'Pod', name: 'pod', namespace: 'default', uid: 'pod-u', fieldPath: marker }, note: 'synthetic note', reason: 'Synthetic', type: 'Warning', action: 'SyntheticAction',
  reportingController: 'synthetic-controller', reportingInstance: 'synthetic-instance', eventTime: '2026-10-25T00:00:01.123456Z', series: { count: 5, lastObservedTime: '2026-10-25T00:00:02.123456Z' },
  deprecatedCount: 2, deprecatedFirstTimestamp: '2026-10-25T00:00:00Z', deprecatedLastTimestamp: '2026-10-25T00:00:01Z', deprecatedSource: { component: 'legacy', host: 'old' }, related: { secret: marker }, private: marker, ...change });
const list = (version: EventApiVersion = api, continuation = '', items: unknown[] = [raw()]) => ({ apiVersion: version, kind: 'EventList', metadata: { resourceVersion: 'list-rv', continue: continuation }, items });
function core(continuation = '') { return list('v1', continuation, [{ apiVersion: 'v1', kind: 'Event', metadata: raw().metadata, involvedObject: raw().regarding, message: 'core message' }]); }
async function fixture() {
  let coreStatus = 404, groupStatus = 200, namespaceStatus = 200, uid = namespace.uid, configSuffix = '', errorIterations = 0, closes = 0;
  let coreBody: unknown = core(), groupBody: unknown = list(api, 'next');
  const requests: ResourceReadRequest[] = [];
  let before: ((request: ResourceReadRequest) => void) | undefined;
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: `https://synthetic${configSuffix}.invalid` } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), base = { protocol: 2 as const, target: { ...source.target, configIdentity: snapshot.snapshot.configIdentity }, selection: source.selection, scope: source.scope };
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => {
    kubectlReadArguments(request, '/synthetic/pipe'); requests.push(request); before?.(request);
    const grouped = request.path.startsWith('/apis/'), event = request.purpose === 'namespace-events', status = event ? grouped ? groupStatus : coreStatus : namespaceStatus;
    const value = status !== 200 ? { message: marker } : event ? grouped ? groupBody : coreBody : { apiVersion: 'v1', kind: 'Namespace', metadata: { name: request.path.split('/').at(-1), uid, resourceVersion: namespace.resourceVersion } };
    return { status, body: { async *[Symbol.asyncIterator]() { if (status !== 200) errorIterations++; yield Buffer.from(JSON.stringify(value)); } }, close: async () => { closes++; } };
  } });
  return { gateway, base, requests, statuses(coreCode: number, groupCode = groupStatus) { coreStatus = coreCode; groupStatus = groupCode; }, bodies(coreValue: unknown, groupValue = groupBody) { coreBody = coreValue; groupBody = groupValue; },
    namespaceStatus(value: number) { namespaceStatus = value; }, namespaceUid(value: string) { uid = value; }, configChange() { configSuffix = '-changed'; }, before(value: typeof before) { before = value; },
    errorIterations: () => errorIterations, closes: () => closes, close() { gateway.close(); } };
}
test('event API/path whitelist has only core v1 and events.k8s.io v1 namespaced collections', () => {
  assert.equal(eventCollectionPath('v1', 'other'), '/api/v1/namespaces/other/events'); assert.equal(eventCollectionPath(api, 'other'), '/apis/events.k8s.io/v1/namespaces/other/events');
  for (const version of ['events.k8s.io/v1beta1', 'events.k8s.io/v2', 'apps/v1', 'v2', marker]) { assert.equal(eventApiVersionSchema.safeParse(version).success, false); assert.throws(() => eventCollectionPath(version as EventApiVersion, 'default'), fails('INVALID_INPUT')); }
  for (const name of ['../other', 'default/events', 'default?watch=true', '']) assert.throws(() => eventCollectionPath(api, name), fails('INVALID_INPUT'));
});
test('events.k8s.io exact mapping projects regarding/note/reporting and preserves real legacy/series time and count', () => {
  const row = projectEventRow(raw(), 'default', api); assert.equal(row.message, 'synthetic note'); assert.equal(row.object.name, 'pod'); assert.equal(row.reporter, 'synthetic-controller / synthetic-instance');
  assert.equal(row.count, 2); assert.equal(eventOccurrences(row), 5); assert.equal(eventLastObserved(row), '2026-10-25T00:00:02.123456Z'); assert.equal(row.first, '2026-10-25T00:00:00Z'); assert.equal(JSON.stringify(row).includes(marker), false);
});
test('grouped Event does not substitute poisoned core fields for version-specific fields', () => {
  const row = projectEventRow(raw({ message: marker, involvedObject: { name: marker }, reportingComponent: marker, count: 999, firstTimestamp: '2026-10-25T02:00:00Z' }), 'default', api);
  assert.equal(row.message, 'synthetic note'); assert.equal(row.object.name, 'pod'); assert.equal(row.count, 2); assert.equal(JSON.stringify(row).includes(marker), false);
});
test('grouped missing regarding and unknown/zero count remain explicit empty/unknown/zero, never fabricated', () => {
  const row = projectEventRow(raw({ regarding: undefined, series: null, deprecatedCount: 0, deprecatedSource: undefined, reportingController: undefined, reportingInstance: undefined }), 'default', api);
  assert.deepEqual(row.object, { apiVersion: '', kind: '', name: '', namespace: null, uid: '' }); assert.equal(eventOccurrences(row), 0); assert.equal(row.reporter, '');
  assert.equal(eventOccurrences(projectEventRow(raw({ series: null, deprecatedCount: undefined }), 'default', api)), null);
});
test('grouped deprecated reporter fallback is version-specific and does not imply modern fields were present', () => {
  assert.equal(projectEventRow(raw({ reportingController: undefined, reportingInstance: undefined }), 'default', api).reporter, 'legacy / old');
});
test('EventList requires the bound API and checks every typed or typeless item against it', () => {
  const row = raw(); assert.equal(projectEventPage(list(), namespace, undefined, api).apiVersion, api); assert.equal(projectEventPage(list(api, '', [{ ...row, apiVersion: undefined, kind: undefined }]), namespace, undefined, api).rows.length, 1);
  assert.throws(() => projectEventPage(list(), namespace), fails('RESOURCE_INVALID'));
  assert.throws(() => projectEventPage(list(api, '', [{ ...row, apiVersion: 'v1' }]), namespace, undefined, api), fails('RESOURCE_INVALID'));
  assert.throws(() => projectEventPage(core(), namespace, undefined, api), fails('RESOURCE_INVALID'));
});
test('grouped event malformed/oversized notes, invalid timestamps/counters and wrong namespace fail whole', () => {
  for (const change of [{ note: '\ud800' }, { note: 'x'.repeat(16_385) }, { deprecatedCount: -1 }, { eventTime: undefined }, { eventTime: '2026-02-30T00:00:00Z' }, { deprecatedLastTimestamp: marker }, { kind: 'Pod' }]) assert.throws(() => projectEventRow(raw(change), 'default', api), fails('RESOURCE_INVALID'));
  assert.throws(() => projectEventRow(raw(), 'other', api), fails('STALE_TARGET'));
});
test('core 404 selects grouped API once, with fresh Namespace brackets and no error-body iteration', async () => {
  const f = await fixture(); try { const page = await f.gateway.readEvents(f.base, signal()); assert.equal(page.apiVersion, api); assert.equal(page.rows[0]?.message, 'synthetic note');
    assert.deepEqual(f.requests.map(request=>request.path), ['/api/v1/namespaces/default', '/api/v1/namespaces/default/events', '/apis/events.k8s.io/v1/namespaces/default/events', '/api/v1/namespaces/default']); assert.equal(f.errorIterations(), 0); assert.equal(f.closes(), 4);
  } finally { f.close(); }
});
test('successful empty core list remains core and does not trigger another API or fabricate missing events', async () => {
  const f = await fixture(); try { f.statuses(200); f.bodies(list('v1', '', [])); const page = await f.gateway.readEvents(f.base, signal()); assert.equal(page.apiVersion, 'v1'); assert.deepEqual(page.rows, []); assert.equal(f.requests.length, 3); } finally { f.close(); }
});
test('core auth/throttle/expired/server failures never fallback to grouped API or retry credentials', async () => {
  for (const [status, code] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [410, 'CONTINUATION_EXPIRED'], [429, 'QUERY_LIMIT'], [500, 'STATE_UNAVAILABLE']] as const) {
    const f = await fixture(); try { f.statuses(status); await assert.rejects(f.gateway.readEvents(f.base, signal()), fails(code)); assert.equal(f.requests.length, 2); assert.equal(f.errorIterations(), 0); } finally { f.close(); }
  }
});
test('core HTTP success with malformed/wrong-version JSON never activates compatibility fallback', async () => {
  const f = await fixture(); try { f.statuses(200); f.bodies(list()); await assert.rejects(f.gateway.readEvents(f.base, signal()), fails('RESOURCE_INVALID')); assert.equal(f.requests.length, 2); } finally { f.close(); }
});
test('both collection 404s fail NotFound without iterating sensitive error bodies', async () => {
  const f = await fixture(); try { f.statuses(404, 404); await assert.rejects(f.gateway.readEvents(f.base, signal()), fails('NOT_FOUND')); assert.equal(f.requests.length, 3); assert.equal(f.errorIterations(), 0); assert.equal(f.closes(), 3); } finally { f.close(); }
});
test('after initial core 404 the alternate API auth/throttle/410/server error is final, not another probe', async () => {
  for (const [status, code] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [410, 'CONTINUATION_EXPIRED'], [429, 'QUERY_LIMIT'], [500, 'STATE_UNAVAILABLE']] as const) {
    const f = await fixture(); try { f.statuses(404, status); await assert.rejects(f.gateway.readEvents(f.base, signal()), fails(code)); assert.equal(f.requests.length, 3); assert.equal(f.errorIterations(), 0); } finally { f.close(); }
  }
});
test('Namespace 404 before the list cannot be confused with an absent event API', async () => {
  const f = await fixture(); try { f.namespaceStatus(404); await assert.rejects(f.gateway.readEvents(f.base, signal()), fails('NOT_FOUND')); assert.equal(f.requests.length, 1); } finally { f.close(); }
});
test('config change or cancellation after core 404 cannot start a grouped read for a stale target', async () => {
  for (const mode of ['config', 'cancel']) { const f = await fixture(), controller = new AbortController(); try {
    f.before(request=> { if (request.path === '/api/v1/namespaces/default/events') { if (mode === 'config') f.configChange(); else controller.abort(); } });
    await assert.rejects(f.gateway.readEvents(f.base, controller.signal), fails(mode === 'config' ? 'STALE_TARGET' : 'QUERY_CANCELLED')); assert.equal(f.requests.length, 2);
  } finally { f.close(); } }
});
test('Namespace replacement after grouped read discards otherwise valid rows', async () => {
  const f = await fixture(); try { f.before(request=> { if (request.path.startsWith('/apis/')) f.namespaceUid('replacement'); }); await assert.rejects(f.gateway.readEvents(f.base, signal()), fails('STALE_TARGET')); } finally { f.close(); }
});
test('sealed cursor resumes the same grouped API without probing core again', async () => {
  const f = await fixture(); try { const first = await f.gateway.readEvents(f.base, signal()); assert.ok(first.nextCursor); f.statuses(200); f.bodies(core(), list(api, '', [raw({ metadata: { ...raw().metadata, name: 'next', uid: 'next-u' } })]));
    const page = await f.gateway.readEvents({ ...f.base, cursor: first.nextCursor }, signal()); assert.equal(page.apiVersion, api); assert.equal(page.page, 2); assert.deepEqual(f.requests.slice(4).map(request=>request.path), ['/api/v1/namespaces/default', '/apis/events.k8s.io/v1/namespaces/default/events', '/api/v1/namespaces/default']); assert.equal(f.requests[5]?.query.continue, 'next');
  } finally { f.close(); }
});
test('continued grouped 404 never falls back to now-available core; explicit refresh can negotiate a new snapshot', async () => {
  const f = await fixture(); try { const first = await f.gateway.readEvents(f.base, signal()); assert.ok(first.nextCursor); f.statuses(200, 404);
    await assert.rejects(f.gateway.readEvents({ ...f.base, cursor: first.nextCursor }, signal()), fails('NOT_FOUND')); assert.equal(f.requests.slice(4).some(request=>request.path === '/api/v1/namespaces/default/events'), false);
    const fresh = await f.gateway.readEvents(f.base, signal()); assert.equal(fresh.apiVersion, 'v1'); assert.equal(fresh.page, 1);
  } finally { f.close(); }
});
test('continued response cannot substitute another EventList API even with the same opaque RV', async () => {
  const f = await fixture(); try { const first = await f.gateway.readEvents(f.base, signal()); f.bodies(core(), core()); await assert.rejects(f.gateway.readEvents({ ...f.base, cursor: first.nextCursor }, signal()), fails('RESOURCE_INVALID')); } finally { f.close(); }
});
test('client rejects cross-version pagination before displaying foreign rows', async () => {
  const f = await fixture(); try { const first = await f.gateway.readEvents(f.base, signal()), states: EventState[] = []; let reads = 0;
    const client = new EventClient(async ()=>({ status: 200, body: JSON.stringify(++reads === 1 ? first : { ...first, page: 2, apiVersion: 'v1', rows: [], nextCursor: null }) }), state=>states.push(state));
    await client.read(f.base); await client.next(); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.page?.apiVersion, api); client.dispose();
  } finally { f.close(); }
});
test('Follow source requires an exact reviewed API and never defaults old missing DTO fields', () => {
  assert.ok(eventFollowSourceSchema.safeParse(source).success); assert.ok(eventFollowSourceSchema.safeParse({ ...source, apiVersion: 'v1' }).success);
  for (const version of [undefined, 'events.k8s.io/v1beta1', 'apps/v1', marker]) assert.equal(eventFollowSourceSchema.safeParse({ ...source, apiVersion: version }).success, false);
});
test('grouped list and watch purposes share narrow namespaced event path validation in worker/argv', () => {
  const watch = planEventFollow(source, 'opaque-rv'), read = { ...watch, purpose: 'namespace-events' as const, query: { limit: '100' } };
  for (const request of [watch, read]) { const input = { protocol: 1, kind: 'read', request, snapshot: new Uint8Array([1]), path: '/synthetic/bin' }; assert.equal(parseReadWorkerStart(input).request.path, eventCollectionPath(api, 'default')); assert.ok(kubectlReadArguments(request, '/synthetic/pipe').includes('--request-timeout=7s'));
    for (const path of ['/apis/events.k8s.io/v1/events', '/apis/apps/v1/namespaces/default/events', '/apis/events.k8s.io/v1beta1/namespaces/default/events', '/apis/events.k8s.io/v1/namespaces/default/events/x', '/apis/events.k8s.io/v1/namespaces/default/pods']) assert.throws(()=>parseReadWorkerStart({ ...input, request: { ...request, path } }));
  }
});
test('grouped watch Add/Modify/Delete uses exact version-specific mapping, wrong GVK fails closed', () => {
  for (const type of ['ADDED', 'MODIFIED', 'DELETED']) assert.equal(projectEventFollowDelta({ type, object: raw() }, 'default', api).row?.message, 'synthetic note');
  assert.throws(()=>projectEventFollowDelta({ type: 'ADDED', object: raw() }, 'default', 'v1'), fails('RESOURCE_INVALID'));
  assert.throws(()=>projectEventFollowDelta({ type: 'ADDED', object: { ...raw(), apiVersion: 'v1' } }, 'default', api), fails('RESOURCE_INVALID'));
});
test('bookmarks cannot introduce an explicitly foreign Event API and Status errors never echo bodies', () => {
  assert.deepEqual(projectEventFollowDelta({ type: 'BOOKMARK', object: { apiVersion: api, kind: 'Event', metadata: { resourceVersion: 'next' }, private: marker } }, 'default', api), { type: 'BOOKMARK', resourceVersion: 'next' });
  assert.throws(()=>projectEventFollowDelta({ type: 'BOOKMARK', object: { apiVersion: 'v1', metadata: { resourceVersion: 'next' } } }, 'default', api), fails('RESOURCE_INVALID'));
  assert.throws(()=>projectEventFollowDelta({ type: 'ERROR', object: { kind: 'Status', code: 410, message: marker } }, 'default', api), fails('CONTINUATION_EXPIRED'));
});
test('Follow rejects initial list API substitution before any seed or stream is published', async () => {
  let streams = 0, events = 0;
  await assert.rejects(runEventFollow(source, signal(), ()=>{ events++; }, { verify: async()=>{}, charge: ()=>{}, list: async()=>projectEventPage(core(), namespace), transport: async()=>{ streams++; } }), fails('STALE_TARGET'));
  assert.equal(streams, 0); assert.equal(events, 0);
});
test('Follow keeps the selected grouped API across initial list and subsequent watch windows', async () => {
  const events: Array<Omit<EventFollowDelta, 'sequence'>> = []; let now = 0, streams = 0;
  await runEventFollow(source, signal(), value=>events.push(value), { verify: async()=>{}, charge: ()=>{}, clock:()=>now, pause:async()=>{}, list:async()=>projectEventPage(list(api, ''), namespace, undefined, api),
    transport:async(_selection, request, _signal, emit)=>{ assert.equal(request.path, eventCollectionPath(api, 'default')); streams++; now += 5000; await emit(Buffer.from(JSON.stringify({ type: 'MODIFIED', object: raw({ metadata: { ...raw().metadata, resourceVersion: `w${streams}` } }) })+'\n')); } });
  assert.equal(streams, 10); assert.equal(events[0]?.type, 'SEED'); assert.equal(events[1]?.type, 'RESYNC'); assert.equal(events[2]?.row?.message, 'synthetic note');
});
test('a selected grouped Follow API disappearing cannot restart or fallback to an available core Event list', async () => {
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), value = { ...source, target: { ...source.target, configIdentity: snapshot.snapshot.configIdentity } }, paths: string[] = []; let streams = 0;
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => {
    paths.push(request.path); const events = request.purpose === 'namespace-events';
    return { status: events ? 404 : 200, body: { async *[Symbol.asyncIterator]() { if (events) assert.fail('Do not iterate error body'); yield Buffer.from(JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: namespace })); } }, close: async () => {} };
  }, watch: async () => { streams++; } });
  try {
    let page = await gateway.openEventFollow({ ...value, consumer: { view: 'a'.repeat(32), epoch: 1 } }, signal());
    for (let n = 0; n < 100 && page.phase !== 'error'; n++) { for (let m = 0; m < 16; m++) await Promise.resolve(); page = await gateway.pollEventFollow({ protocol: 2, handle: page.handle, after: 0 }, signal()); }
    assert.equal(page.error, 'NOT_FOUND'); assert.equal(streams, 0); assert.equal(paths.filter(path => path.endsWith('/events')).length, 1); assert.ok(paths.includes(eventCollectionPath(api, 'default'))); assert.equal(paths.includes(eventCollectionPath('v1', 'default')), false);
  } finally { gateway.close(); }
});
test('grouped Follow list/watch gateway is bound to the original API and read-task source', async () => {
  let started = false; const stop = Promise.withResolvers<void>();
  const config = createConfigReader('/synthetic', async path=>({ sourcePath:path,content:JSON.stringify({'current-context':'active',clusters:[{name:'c',cluster:{server:'https://synthetic.invalid'}}],contexts:[{name:'active',context:{cluster:'c'}}]}) }));
  const snapshot = await config.read({ mode:'default' }), value = { ...source, target:{...source.target,configIdentity:snapshot.snapshot.configIdentity} };
  const gateway = createResourceGateway({ config,serviceGeneration:'s',outbound:{tokensPerSecond:1000,burst:16},read:async(_selection,request)=>{
    if (request.purpose === 'namespace-events') assert.equal(request.path,eventCollectionPath(api,'default'));
    const body = request.purpose === 'namespace-events' ? list(api,'') : {apiVersion:'v1',kind:'Namespace',metadata:namespace};
    return {status:200,body:{async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(body));}},close:async()=>{}};
  },watch:async(_selection,request,input,emit)=>{ assert.equal(request.path,eventCollectionPath(api,'default')); await emit(Buffer.from(JSON.stringify({type:'MODIFIED',object:raw({metadata:{...raw().metadata,resourceVersion:'new'}})})+'\n'));started=true; await Promise.race([stop.promise,new Promise<void>(resolve=>input.addEventListener('abort',()=>resolve(),{once:true}))]); }});
  try { const page = await gateway.openEventFollow({ ...value,consumer:{view:'a'.repeat(32),epoch:1} },signal()); for(let n=0;n<100&&!started;n++)for(let m=0;m<16;m++)await Promise.resolve();assert.equal(started,true);
    const current = await gateway.pollEventFollow({protocol:2,handle:page.handle,after:0},signal());assert.equal(current.source.apiVersion,api);assert.deepEqual(current.events.map(event=>event.type),['SEED','RESYNC','MODIFIED']);
  } finally {stop.resolve();gateway.close();}
});
