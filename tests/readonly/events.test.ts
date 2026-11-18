import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { eventLastObserved, eventMaximumPages, eventOccurrences, eventReadRequestSchema, eventReadResponseSchema, eventScopeFromNode } from '../../src/shared/event-protocol.ts';
import { logDisplayText } from '../../src/shared/pod-log-protocol.ts';
import type { EventReadResponse } from '../../src/shared/event-protocol.ts';
import { EventClient } from '../../src/host/event-client.ts';
import type { EventState } from '../../src/host/event-client.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import { kubectlReadArguments, validateResourceReadTransportRequest } from '../../src/service/queries/kubectl-plan.ts';
import { parseReadWorkerStart } from '../../src/service/queries/read-worker-protocol.ts';
import { createEventReader } from '../../src/service/queries/events.ts';
import { projectEventPage } from '../../src/service/queries/event-source.ts';

const signal = () => new AbortController().signal, marker = 'SYNTHETIC_EVENT_PRIVATE';
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;
const namespace = { name: 'default', uid: 'ns-u', resourceVersion: 'ns-rv' };
function event(index = 0, overrides: Record<string, unknown> = {}) {
  return { metadata: { name: `event-${index}`, namespace: 'default', uid: `e-${index}`, resourceVersion: `rv-${index}`, creationTimestamp: '2026-10-23T01:00:00Z', annotations: { private: marker } },
    involvedObject: { apiVersion: 'v1', kind: 'Pod', name: 'actual', uid: 'pod-u', namespace: 'default', fieldPath: marker },
    type: 'Warning', reason: 'Synthetic', message: 'synthetic event message', firstTimestamp: '2026-10-23T01:00:01Z', lastTimestamp: '2026-10-23T01:00:02Z', count: 3,
    source: { component: 'synthetic-controller', host: 'synthetic-node', private: marker }, private: marker, ...overrides };
}
function list(items: unknown[] = [event()], continuation = '') { return { apiVersion: 'v1', kind: 'EventList', metadata: { resourceVersion: 'list-rv', continue: continuation, private: marker }, items, private: marker }; }
async function fixture() {
  let contentSuffix = '', uid = namespace.uid, rv = namespace.resourceVersion, namespaceStatus = 200, listStatus = 200, input: unknown = list([event()], 'upstream-token'), iteratedError = false;
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: `https://synthetic${contentSuffix}.invalid` } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const configRead = await config.read({ mode: 'default' });
  const target = { serviceGeneration: 's', projectId: 'view', configIdentity: configRead.snapshot.configIdentity, context: 'active', namespace: 'default' };
  const base = { protocol: 2 as const, selection: { mode: 'default' as const }, target, scope: { kind: 'current' as const } };
  const requests: ResourceReadRequest[] = [], states: EventState[] = [];
  let wait: ((request: ResourceReadRequest, signal: AbortSignal) => Promise<void>) | undefined;
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request, signal) => {
    validateResourceReadTransportRequest(request); requests.push(request); await wait?.(request, signal);
    const isEvent = request.purpose === 'namespace-events', status = isEvent ? listStatus : namespaceStatus;
    const value = isEvent ? input : request.purpose === 'resource-list' ? { apiVersion: 'v1', kind: 'NamespaceList', metadata: { resourceVersion: 'namespaces-rv' }, items: [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'default', uid, resourceVersion: rv } }] }
      : { apiVersion: 'v1', kind: 'Namespace', metadata: { name: request.path.split('/').at(-1), uid, resourceVersion: rv, annotations: { private: marker } }, private: marker };
    const bytes = Buffer.from(JSON.stringify(value));
    return { status, body: { async *[Symbol.asyncIterator]() { if (status !== 200) iteratedError = true; yield bytes; } }, close: async () => {} };
  } });
  const transport = async (request: { method: 'POST'; path: string; body: string }) => {
    assert.equal(request.path, '/v2/events/read');
    try { return { status: 200, body: JSON.stringify(await gateway.readEvents(JSON.parse(request.body) as unknown, signal())) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  };
  const client = new EventClient(transport, state => states.push(state));
  return { base, gateway, requests, client, states, transport, input: (value: unknown) => { input = value; },
    namespace: (nextUid = uid, nextRv = rv) => { uid = nextUid; rv = nextRv; }, namespaceStatus: (value: number) => { namespaceStatus = value; }, status: (value: number) => { listStatus = value; },
    configChange: () => { contentSuffix = '-changed'; }, wait: (value: typeof wait) => { wait = value; }, iteratedError: () => iteratedError,
    close() { client.dispose(); gateway.close(); } };
}

test('Show Events brackets a single core/v1 namespace LIST with fresh Namespace GETs, and exposes only audited fields', async () => {
  const f = await fixture(), page = await f.gateway.readEvents(f.base, signal());
  assert.equal(page.kind, 'events'); assert.equal(page.apiVersion, 'v1'); assert.deepEqual(page.namespace, namespace);
  assert.equal(page.rows[0]?.message, 'synthetic event message'); assert.equal(page.rows[0]?.reporter, 'synthetic-controller / synthetic-node');
  assert.equal(JSON.stringify(page).includes(marker), false); assert.equal(JSON.stringify(page).includes('upstream-token'), false); assert.ok(page.nextCursor);
  assert.deepEqual(f.requests.map(request => request.path), ['/api/v1/namespaces/default', '/api/v1/namespaces/default/events', '/api/v1/namespaces/default']);
  assert.deepEqual(f.requests[1]?.query, { limit: '100' }); assert.equal(f.requests.every(request => request.method === 'GET'), true); assert.ok(Object.isFrozen(page.rows)); f.close();
});

test('Namespace leaf scope may differ from current namespace without mutating it or accepting another kind as a namespace', async () => {
  const f = await fixture(); f.input(list([{ ...event(), metadata: { ...event().metadata, namespace: 'other' } }]));
  const scope = { kind: 'namespace' as const, ...namespace, name: 'other' }, page = await f.gateway.readEvents({ ...f.base, scope }, signal());
  assert.equal(page.namespace.name, 'other'); assert.equal(page.target.namespace, 'default'); assert.deepEqual(page.scope, scope);
  assert.equal(f.requests[1]?.path, '/api/v1/namespaces/other/events');
  const node = { id: 'synthetic', type: 'resource', label: '* other', expandable: false, children: 'none', resource: { group: '', version: 'v1', resource: 'namespaces', scope: 'cluster', kind: 'Namespace', ...namespace, name: 'other' } };
  assert.deepEqual(eventScopeFromNode(node), scope);
  for (const resource of [{ ...node.resource, kind: 'Pod' }, { ...node.resource, group: 'custom.example' }, { ...node.resource, uid: undefined }, { ...node.resource, namespace: 'default' }]) assert.equal(eventScopeFromNode({ ...node, resource }), null);
  f.close();
});

test('series timestamps/counters override legacy fields without summing, and absent/zero values remain distinct', () => {
  const first = event(0, { eventTime: '2026-10-23T01:00:01.123456Z', series: { count: 8, lastObservedTime: '2026-10-23T01:00:03.123456Z' } });
  const page = projectEventPage(list([first, event(1, { count: 0 }), event(2, { count: undefined, firstTimestamp: null, lastTimestamp: null, eventTime: null })]), namespace);
  const [series, zero, missing] = page.rows; assert.ok(series && zero && missing);
  assert.equal(eventOccurrences(series), 8); assert.equal(eventLastObserved(series), '2026-10-23T01:00:03.123456Z');
  assert.equal(eventOccurrences(zero), 0); assert.equal(eventOccurrences(missing), null); assert.equal(eventLastObserved(missing), '2026-10-23T01:00:00Z');
  assert.equal(page.rows[2]?.first, null); assert.equal(page.rows[0]?.last, '2026-10-23T01:00:02Z');
});

test('server API order and separate Event UIDs are preserved, not re-sorted or collapsed by message/reason/object', () => {
  const page = projectEventPage(list([event(2, { lastTimestamp: '2026-10-23T04:00:00Z' }), event(1), event(0)]), namespace);
  assert.deepEqual(page.rows.map(row => row.uid), ['e-2', 'e-1', 'e-0']); assert.deepEqual(page.rows.map(row => row.count), [3, 3, 3]);
});

test('in-list Events may omit TypeMeta, but wrong group/version/kind, duplicate UID/name or another namespace reject the whole page', () => {
  assert.equal(projectEventPage(list([event()]), namespace).rows.length, 1);
  for (const items of [[event(0, { apiVersion: 'events.k8s.io/v1' })], [event(0, { kind: 'Pod' })], [event(), event()], [event(), event(1, { metadata: { ...event(1).metadata, uid: 'e-0' } })], [event(0, { metadata: { ...event().metadata, namespace: 'other' } })]]) {
    assert.throws(() => projectEventPage(list(items), namespace), error => error instanceof BoundaryError);
  }
  assert.throws(() => projectEventPage({ ...list(), apiVersion: 'events.k8s.io/v1' }, namespace), fails('RESOURCE_INVALID'));
});

test('invalid timestamps, counters, malformed Unicode and oversized messages fail fixed without reflecting original values', () => {
  for (const change of [{ eventTime: marker }, { eventTime: '2026-02-30T01:00:00Z' }, { eventTime: '2026-10-23T24:00:00Z' }, { series: { count: -1, lastObservedTime: '2026-10-23T01:00:00Z' } }, { count: 2.5 }, { count: 2_147_483_648 }, { message: '\uD800' }, { message: 'a'.repeat(16_385) }, { involvedObject: null }]) assert.throws(() => projectEventPage(list([event(0, change)]), namespace), fails('RESOURCE_INVALID'));
});

test('finite event pagination binds original Namespace/list RV, opaque continuation and full source, without claiming a total', async () => {
  const f = await fixture(), first = await f.gateway.readEvents(f.base, signal()); assert.ok(first.nextCursor);
  f.input(list([event(1)], ''));
  const second = await f.gateway.readEvents({ ...f.base, cursor: first.nextCursor }, signal());
  assert.equal(second.page, 2); assert.equal(second.nextCursor, null); assert.equal(second.resourceVersion, first.resourceVersion);
  assert.deepEqual(f.requests[4]?.query, { limit: '100', continue: 'upstream-token' }); assert.equal('total' in second, false); f.close();
});

test('a continued empty page is not complete until its continuation ends', async () => {
  const f = await fixture(); f.input(list([], 'next-empty')); await f.client.read(f.base);
  assert.equal(f.states.at(-1)?.page?.rows.length, 0); assert.ok(f.states.at(-1)?.page?.nextCursor);
  f.input(list([], '')); await f.client.next(); assert.equal(f.states.at(-1)?.page?.page, 2); assert.equal(f.states.at(-1)?.page?.nextCursor, null); f.close();
});

test('event cursor cannot cross target/config selection/scope or another reader instance, and tampering fails before transport', async () => {
  const f = await fixture(), first = await f.gateway.readEvents(f.base, signal()); assert.ok(first.nextCursor); const count = f.requests.length;
  for (const change of [{ scope: { kind: 'namespace', ...namespace } }, { selection: { mode: 'file', path: '/synthetic/explicit-config' } }, { target: { ...f.base.target, projectId: 'other' } }, { target: { ...f.base.target, namespace: 'other' } }, { cursor: `${first.nextCursor.slice(0, -2)}xx` }]) await assert.rejects(f.gateway.readEvents({ ...f.base, cursor: first.nextCursor, ...change }, signal()), fails('STALE_TARGET'));
  assert.equal(f.requests.length, count);
  const other = await fixture(); await assert.rejects(other.gateway.readEvents({ ...other.base, cursor: first.nextCursor }, signal()), fails('STALE_TARGET')); assert.equal(other.requests.length, 0); other.close(); f.close();
});

test('Namespace disappearance/recreation/RV change invalidates initial or continued events, and post-check discards a successful list', async () => {
  for (const when of ['before', 'after', 'continued', 'rv', 'missing'] as const) {
    const f = await fixture(); let cursor: string | undefined;
    if (when === 'continued') cursor = (await f.gateway.readEvents({ ...f.base, scope: { kind: 'namespace', ...namespace } }, signal())).nextCursor ?? undefined;
    if (when === 'after') f.wait(async request => { if (request.purpose === 'namespace-events') f.namespace('new'); });
    else if (when === 'missing') f.namespaceStatus(404); else f.namespace(when === 'rv' ? namespace.uid : 'new', when === 'rv' ? 'new-rv' : namespace.resourceVersion);
    await assert.rejects(f.gateway.readEvents({ ...f.base, scope: { kind: 'namespace', ...namespace }, ...(cursor ? { cursor } : {}) }, signal()), fails(when === 'missing' ? 'NOT_FOUND' : 'STALE_TARGET'));
    f.close();
  }
});

test('list snapshot changes and replayed upstream continuation are failures, not a fresh combined result', async () => {
  const f = await fixture(), first = await f.gateway.readEvents(f.base, signal()); assert.ok(first.nextCursor);
  f.input({ ...list([event(1)]), metadata: { resourceVersion: 'changed' } });
  await assert.rejects(f.gateway.readEvents({ ...f.base, cursor: first.nextCursor }, signal()), fails('STALE_TARGET'));
  f.input(list([event(1)], 'upstream-token')); await assert.rejects(f.gateway.readEvents({ ...f.base, cursor: first.nextCursor }, signal()), fails('RESOURCE_INVALID')); f.close();
});

test('401/403/404/410/429 are distinct fixed failures and sensitive error bodies are never iterated', async () => {
  const f = await fixture();
  for (const [status, code] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [410, 'CONTINUATION_EXPIRED'], [429, 'QUERY_LIMIT']] as const) {
    f.status(status); await assert.rejects(f.gateway.readEvents(f.base, signal()), fails(code));
  }
  assert.equal(f.iteratedError(), false); f.close();
});

test('per-page item/output budgets fail whole, never silently truncate Event JSON or messages', async () => {
  const f = await fixture(); f.input(list(Array.from({ length: 101 }, (_, index) => event(index))));
  await assert.rejects(f.gateway.readEvents(f.base, signal()), fails('RESOURCE_INVALID'));
  f.input(list(Array.from({ length: 40 }, (_, index) => event(index, { message: 'a'.repeat(16_384) }))));
  await assert.rejects(f.gateway.readEvents(f.base, signal()), fails('BUDGET_EXCEEDED')); f.close();
});

test('configuration changes, closed gateways, invalid scopes and pre-cancellation never publish event pages', async () => {
  const f = await fixture(); f.wait(async request => { if (request.purpose === 'namespace-events') f.configChange(); });
  await assert.rejects(f.gateway.readEvents(f.base, signal()), fails('STALE_TARGET'));
  const other = await fixture(); const abort = new AbortController(); abort.abort();
  await assert.rejects(other.gateway.readEvents(other.base, abort.signal), fails('QUERY_CANCELLED')); assert.equal(other.requests.length, 0);
  for (const change of [{ scope: { kind: 'pods', name: 'default' } }, { scope: { kind: 'namespace', name: 'default' } }, { command: marker }, { watch: true }]) await assert.rejects(other.gateway.readEvents({ ...other.base, ...change }, signal()), fails('INVALID_INPUT'));
  other.close(); await assert.rejects(other.gateway.readEvents(other.base, signal()), fails('SERVICE_CLOSED')); f.close();
});

test('event worker/argv accepts only the fixed core namespace events list and cannot acquire Watch or arbitrary query powers', async () => {
  const f = await fixture(); await f.gateway.readEvents(f.base, signal()); const request = f.requests[1]; assert.ok(request);
  const packet = { protocol: 1, kind: 'read', request, snapshot: Buffer.from('{}'), path: '/synthetic/path' };
  assert.equal(parseReadWorkerStart(packet).request.purpose, 'namespace-events');
  for (const change of [{ path: '/api/v1/events' }, { path: '/apis/events.k8s.io/v1beta1/namespaces/default/events' }, { path: '/api/v1/namespaces/default/pods' }, { query: { limit: '101' } }, { query: { limit: '100', watch: 'true' } }, { query: { limit: '100', fieldSelector: 'involvedObject.name=x' } }, { query: { limit: '100', continue: '\n' } }, { method: 'POST' }]) assert.throws(() => parseReadWorkerStart({ ...packet, request: { ...request, ...change } }), fails('INVALID_INPUT'));
  const args = kubectlReadArguments(request, '/synthetic/fifo'); assert.equal(args.at(-1), '--raw=/api/v1/namespaces/default/events?limit=100'); f.close();
});

test('event cursor lifetime and page-count budget are fixed; expiry is rechecked after reads with no automatic retry', async () => {
  const f = await fixture(); let time = 1000, loads = 0;
  const reader = createEventReader({ events: async () => { loads++; return projectEventPage(list([event(loads)], `p-${loads}`), namespace); } }, () => time);
  let page = await reader.read(f.base, signal()); time += 59_000;
  page = await reader.read({ ...f.base, cursor: page.nextCursor }, signal()); time = 61_000;
  await assert.rejects(reader.read({ ...f.base, cursor: page.nextCursor }, signal()), fails('CONTINUATION_EXPIRED')); assert.equal(loads, 2); reader.dispose();
  time = 0; const bounded = createEventReader({ events: async () => projectEventPage(list([], `next-${++loads}`), namespace) }, () => time);
  page = await bounded.read(f.base, signal());
  for (let index = 1; index < eventMaximumPages; index++) page = await bounded.read({ ...f.base, cursor: page.nextCursor }, signal());
  assert.equal(page.page, 20); await assert.rejects(bounded.read({ ...f.base, cursor: page.nextCursor }, signal()), fails('QUERY_LIMIT')); bounded.dispose();
  const slow = createEventReader({ events: async () => { time += 60_000; return projectEventPage(list(), namespace); } }, () => time);
  await assert.rejects(slow.read(f.base, signal()), fails('CONTINUATION_EXPIRED')); slow.dispose(); f.close();
});

test('client replaces its one page, preserves source through pagination, and refresh starts a new snapshot', async () => {
  const f = await fixture(); await f.client.read(f.base); assert.equal(f.states.at(-1)?.page?.page, 1);
  f.input(list([event(1)], '')); await f.client.next(); assert.equal(f.states.at(-1)?.page?.page, 2); assert.equal(f.states.at(-1)?.page?.rows.length, 1);
  f.input({ ...list([event(2)]), metadata: { resourceVersion: 'new-snapshot' } }); await f.client.reload();
  assert.equal(f.states.at(-1)?.page?.page, 1); assert.equal(f.states.at(-1)?.page?.resourceVersion, 'new-snapshot'); assert.ok(Object.isFrozen(f.states.at(-1)?.page?.rows)); f.close();
});

test('client rejects duplicate cross-page Events and cursor/namespace/list-RV/source/target/page replay before showing them', async () => {
  const f = await fixture(), first = await f.gateway.readEvents(f.base, signal()); assert.ok(first.nextCursor);
  for (const change of [{}, { page: 1, rows: [] }, { resourceVersion: 'other', rows: [] }, { namespace: { ...namespace, uid: 'wrong' }, rows: [] }, { scope: { kind: 'namespace', ...namespace }, rows: [] }, { target: { ...f.base.target, projectId: 'wrong' }, rows: [] }, { nextCursor: first.nextCursor, rows: [] }]) {
    let calls = 0; const states: EventState[] = [], client = new EventClient(async () => ({ status: 200, body: JSON.stringify(++calls === 1 ? first : { ...first, page: 2, ...change }) }), state => states.push(state));
    await client.read(f.base); await client.next(); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.page?.page, 1); client.dispose();
  }
  f.close();
});

test('late cancel/reset/dispose event responses cannot resurrect old output; failed refresh preserves a stale page and disables next', async () => {
  const f = await fixture(); await f.client.read(f.base); f.status(403); await f.client.reload();
  assert.equal(f.states.at(-1)?.error, 'FORBIDDEN'); assert.equal(f.states.at(-1)?.stale, true); const count = f.requests.length; await f.client.next(); assert.equal(f.requests.length, count);
  for (const action of ['cancel', 'reset', 'dispose'] as const) {
    let release: ((value: { status: number; body: string }) => void) | undefined; const states: EventState[] = [];
    const client = new EventClient(() => new Promise(resolve => { release = resolve; }), state => states.push(state));
    const pending = client.read(f.base); client[action](); release?.({ status: 200, body: JSON.stringify(f.states[2]?.page) }); await pending;
    assert.equal(states.some(state => state.phase === 'ready'), false); client.dispose();
  }
  f.close();
});

test('event SDK admission retains four non-settled calls after Stop waiting; unknown errors never echo raw diagnostics', async () => {
  const f = await fixture(), states: EventState[] = [], releases: (() => void)[] = [];
  const client = new EventClient(() => new Promise((_resolve, reject) => { releases.push(() => reject(Error(marker))); }), state => states.push(state));
  const pending: Promise<void>[] = [];
  for (let index = 0; index < 4; index++) { pending.push(client.read(f.base)); client.cancel(); }
  await client.reload(); assert.equal(states.at(-1)?.error, 'QUERY_LIMIT'); assert.equal(releases.length, 4);
  releases.forEach(release => release()); await Promise.all(pending); assert.equal(JSON.stringify(states).includes(marker), false); client.dispose(); f.close();
});

test('oversized/malformed/untrusted event responses or sensitive extensions never become visible pages', async () => {
  const f = await fixture(), page = await f.gateway.readEvents(f.base, signal());
  for (const response of [{ status: 200, body: marker }, { status: 200, body: ' '.repeat(512_001) }, { status: 500, body: JSON.stringify({ error: { code: marker, private: marker } }) }, { status: 200, body: JSON.stringify({ ...page, private: marker }) }, { status: 200, body: JSON.stringify({ ...page, rows: [{ ...page.rows[0], private: marker }] }) }]) {
    const states: EventState[] = [], client = new EventClient(async () => response, state => states.push(state)); await client.read(f.base);
    assert.equal(states.at(-1)?.phase, 'error'); assert.equal(states.some(state => state.page), false); assert.equal(JSON.stringify(states).includes(marker), false); client.dispose();
  }
  f.close();
});

test('event messages/control characters remain inert text, distinct from private fields and without destructive normalization', () => {
  const message = '<script>synthetic()</script>\r\n\u001b[31m\u0000';
  const page = projectEventPage(list([event(0, { message })]), namespace); assert.equal(page.rows[0]?.message, message);
  assert.equal(logDisplayText(message), '<script>synthetic()</script>\r\n\\u001b[31m\\u0000');
});

test('event pages and existing resource reads share the global two-reader pool, without creating an events-only CLI pool', async () => {
  const f = await fixture(); let release: (() => void) | undefined, start: (() => void) | undefined, active = 0, maximum = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { start = resolve; });
  f.wait(async () => { active++; maximum = Math.max(maximum, active); if (active === 2) start?.(); await gate; active--; });
  const a = f.gateway.readEvents(f.base, signal()), b = f.gateway.read({ protocol: 2, selection: f.base.selection, target: f.base.target, resource: 'namespaces' }, signal());
  await started; assert.equal(f.requests.length, 2); release?.(); await Promise.all([a, b]); assert.equal(maximum, 2); f.close();
});

test('one cancelled duplicate Event consumer cannot cancel its peer or cause an extra underlying LIST', async () => {
  const f = await fixture(); let release: (() => void) | undefined, start: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { start = resolve; });
  f.wait(async request => { if (request.purpose === 'namespace-events') { start?.(); await gate; } }); const abort = new AbortController();
  const a = f.gateway.readEvents(f.base, abort.signal).catch(error => error instanceof BoundaryError ? error.code : 'unexpected');
  await started; const b = f.gateway.readEvents(f.base, signal()); abort.abort(); assert.equal(await a, 'QUERY_CANCELLED'); release?.(); await b;
  assert.equal(f.requests.filter(request => request.purpose === 'namespace-events').length, 1); assert.equal(f.requests.length, 3); f.close();
});

test('event public DTO and read schema reject arbitrary URLs/credentials and never treat Follow as a finite read', async () => {
  const f = await fixture();
  for (const change of [{ protocol: 1 }, { scope: { kind: 'current', name: marker } }, { url: 'https://synthetic.invalid' }, { credential: marker }, { command: ['get', 'events', '-w'] }]) assert.equal(eventReadRequestSchema.safeParse({ ...f.base, ...change }).success, false);
  const page: EventReadResponse = await f.gateway.readEvents(f.base, signal()); assert.equal(eventReadResponseSchema.safeParse(page).success, true); f.close();
});

test('optional EventSeries fields stay unknown rather than fabricating a zero counter or observed time', () => {
  const page = projectEventPage(list([event(0, { series: {}, count: undefined, lastTimestamp: null, eventTime: null }), event(1, { series: { count: 0 } })]), namespace);
  const [empty, zero] = page.rows; assert.ok(empty && zero);
  assert.deepEqual(empty.series, { count: null, lastObservedTime: null }); assert.equal(eventOccurrences(empty), null);
  assert.equal(eventLastObserved(empty), empty.created); assert.equal(eventOccurrences(zero), 0);
});

test('last Event consumer cancellation aborts its read but cannot release the global slots before transport settles', async () => {
  const f = await fixture(); let release: (() => void) | undefined, start: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { start = resolve; });
  let count = 0; const signals: AbortSignal[] = [];
  f.wait(async (_request, signal) => { signals.push(signal); if (++count === 2) start?.(); await gate; });
  const aController = new AbortController(), bController = new AbortController();
  const a = f.gateway.readEvents(f.base, aController.signal).catch(error => error instanceof BoundaryError ? error.code : 'unexpected');
  const b = f.gateway.readEvents({ ...f.base, target: { ...f.base.target, projectId: 'b' } }, bController.signal).catch(error => error instanceof BoundaryError ? error.code : 'unexpected');
  await started; aController.abort(); bController.abort(); assert.equal(await a, 'QUERY_CANCELLED'); assert.equal(await b, 'QUERY_CANCELLED');
  assert.equal(signals.every(signal => signal.aborted), true);
  const c = f.gateway.readEvents({ ...f.base, target: { ...f.base.target, projectId: 'c' } }, signal());
  await Promise.resolve(); assert.equal(count, 2); release?.(); await c; assert.equal(f.requests.filter(request => request.purpose === 'namespace-events').length, 1); f.close();
});
