import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { jobLogOriginFromParent, podLogRequestSchema } from '../../src/shared/pod-log-protocol.ts';
import { parentFromResource } from '../../src/shared/branch-protocol.ts';
import { PodLogClient } from '../../src/host/pod-log-client.ts';
import type { PodLogState } from '../../src/host/pod-log-client.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { matchesPodSelector } from '../../src/service/queries/selectors.ts';

const signal = () => new AbortController().signal, marker = 'SYNTHETIC_JOB_LOG';
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;
async function fixture(initialText = marker) {
  let jobUid = 'job-u', jobRv = '7', podUid = 'pod-u', podRv = '1', labels: unknown = { batch: 'work' }, selector: unknown = { matchLabels: { batch: 'work' } }, jobsRead = 0, status = 200, text = initialText, empty = false;
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const current = await config.read({ mode: 'default' });
  const target = { serviceGeneration: 's', projectId: 'view', configIdentity: current.snapshot.configIdentity, context: 'active', namespace: 'default' };
  const origin = { resource: 'jobs' as const, namespace: 'default', name: 'work', uid: jobUid, resourceVersion: jobRv };
  const reference = { resource: 'pods' as const, namespace: 'default', name: 'actual', uid: podUid, resourceVersion: podRv };
  const base = { protocol: 2 as const, selection: { mode: 'default' as const }, target, reference, origin };
  const request = { ...base, kind: 'read' as const, container: 'main', options: { timestamps: false, sinceSeconds: null, tailLines: null } };
  const requests: ResourceReadRequest[] = [], states: PodLogState[] = [];
  let onJob: ((count: number) => void) | undefined, wait: ((request: ResourceReadRequest) => Promise<void>) | undefined;
  function job() { return { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'work', namespace: 'default', uid: jobUid, resourceVersion: jobRv },
    spec: { selector, template: { spec: { containers: [{ name: 'template-not-actual' }] } } }, private: marker }; }
  function pod(name = 'actual') { return { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: 'default', uid: name === 'actual' ? podUid : 'second-u', resourceVersion: podRv, labels },
    spec: { initContainers: [{ name: 'setup' }], containers: [{ name: 'main' }] }, status: { containerStatuses: [{ name: 'main', restartCount: 0, containerID: 'synthetic://main' }] }, private: marker }; }
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => {
    kubectlReadArguments(request, '/synthetic/configuration.pipe'); requests.push(request); await wait?.(request);
    let body: string, responseStatus = 200;
    if (request.path.includes('/jobs/')) { onJob?.(++jobsRead); body = JSON.stringify(job()); responseStatus = status; }
    else if (request.purpose === 'pod-logs') body = text;
    else if (request.purpose === 'resource-list') body = JSON.stringify({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: '9', continue: request.query.continue ? '' : 'upstream-page-two' }, items: empty ? [] : [pod(request.query.continue ? 'second' : 'actual')] });
    else body = JSON.stringify(pod(request.path.endsWith('/second') ? 'second' : 'actual'));
    return { status: responseStatus, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(body); } }, close: async () => {} };
  } });
  const transport = async (request: { method: 'POST'; path: string; body: string }) => {
    assert.equal(request.path, '/v2/logs/read');
    try { return { status: 200, body: JSON.stringify(await gateway.readLogs(JSON.parse(request.body) as unknown, signal())) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  };
  const client = new PodLogClient(transport, state => states.push(state));
  return { gateway, client, base, request, requests, states, transport,
    jobIdentity: (uid: string, rv: string) => { jobUid = uid; jobRv = rv; }, podIdentity: (uid: string, rv: string) => { podUid = uid; podRv = rv; },
    selector: (value: unknown) => { selector = value; }, labels: (value: unknown) => { labels = value; }, jobStatus: (value: number) => { status = value; },
    onJob: (callback: (count: number) => void) => { onJob = callback; }, wait: (callback: (request: ResourceReadRequest) => Promise<void>) => { wait = callback; }, text: (value: string) => { text = value; }, empty: () => { empty = true; },
    close: () => { client.dispose(); gateway.close(); } };
}

test('Job candidates reuse the existing selector branch and sealed paging, with explicit actual Pod references', async () => {
  const f = await fixture(), query = { protocol: 2, selection: f.base.selection, target: f.base.target, kind: 'children', parent: f.base.origin };
  const page = await f.gateway.readTree(query, signal()); assert.equal(page.kind, 'children'); assert.ok(page.nextCursor);
  const node = page.nodes[0]; assert.ok(node?.type === 'resource'); const reference = parentFromResource(node); assert.equal(reference?.name, 'actual');
  const origin = page.kind === 'children' ? jobLogOriginFromParent(page.parent) : null; assert.deepEqual(origin, f.base.origin);
  const next = await f.gateway.readTree({ ...query, cursor: page.nextCursor }, signal()); assert.equal(next.nodes[0]?.label, 'second');
  assert.ok(f.requests.filter(value => value.purpose === 'resource-list').every(value => value.query.labelSelector === 'batch=work' && value.path === '/api/v1/namespaces/default/pods'));
  assert.equal(f.requests.some(value => value.purpose === 'pod-logs'), false); assert.equal(JSON.stringify([page, next]).includes(marker), false); f.close();
});

test('opening Job-origin containers brackets actual Pod metadata with fresh Job checks and never autoruns logs', async () => {
  const f = await fixture(); await f.client.open({ ...f.base, kind: 'containers' });
  assert.deepEqual(f.states.at(-1)?.containers, [{ name: 'setup', kind: 'init' }, { name: 'main', kind: 'regular' }]);
  assert.deepEqual(f.requests.map(value => value.path), ['/apis/batch/v1/namespaces/default/jobs/work', '/api/v1/namespaces/default/pods/actual', '/apis/batch/v1/namespaces/default/jobs/work']);
  assert.equal(f.states.at(-1)?.source?.origin?.uid, 'job-u'); assert.equal(f.states.at(-1)?.text, ''); f.close();
});

test('Job logs use five ordered GETs and expose both Job origin and selected actual Pod/container, never template identity', async () => {
  const f = await fixture(); const page = await f.gateway.readLogs(f.request, signal()); assert.ok(page.kind === 'pod-log');
  assert.deepEqual(page.origin, f.base.origin); assert.deepEqual(page.reference, f.base.reference); assert.equal(page.container, 'main'); assert.equal(page.text, marker);
  assert.deepEqual(f.requests.map(value => value.path), ['/apis/batch/v1/namespaces/default/jobs/work', '/api/v1/namespaces/default/pods/actual', '/api/v1/namespaces/default/pods/actual/log', '/api/v1/namespaces/default/pods/actual', '/apis/batch/v1/namespaces/default/jobs/work']);
  assert.equal(JSON.stringify(page).includes('template-not-actual'), false); f.close();
});

test('Job disappearance or changed UID/RV before reading cannot submit a log GET', async () => {
  for (const mode of ['uid', 'rv', 'missing', 'forbidden'] as const) {
    const f = await fixture(); if (mode === 'uid') f.jobIdentity('new', '7'); else if (mode === 'rv') f.jobIdentity('job-u', '8'); else f.jobStatus(mode === 'missing' ? 404 : 403);
    await assert.rejects(f.gateway.readLogs(f.request, signal()), fails(mode === 'missing' ? 'NOT_FOUND' : mode === 'forbidden' ? 'FORBIDDEN' : 'STALE_TARGET'));
    assert.equal(f.requests.some(value => value.purpose === 'pod-logs'), false); f.close();
  }
});

test('Job replacement, same-RV selector mutation or selected Pod label drift after logs discards the complete result', async () => {
  for (const mode of ['uid', 'selector', 'labels'] as const) {
    const f = await fixture();
    if (mode === 'labels') f.wait(async request => { if (request.purpose === 'pod-logs') f.labels({ batch: 'different' }); });
    else f.onJob(count => { if (count === 2) { if (mode === 'uid') f.jobIdentity('new', '7'); else f.selector({ matchLabels: { batch: 'work' }, matchExpressions: [{ key: 'absent', operator: 'DoesNotExist' }] }); } });
    await assert.rejects(f.gateway.readLogs(f.request, signal()), fails('STALE_TARGET')); assert.equal(f.requests.filter(value => value.purpose === 'pod-logs').length, 1); f.close();
  }
});

test('nonmatching or empty Job selectors never become an all-Pods log fallback', async () => {
  const f = await fixture(); f.selector({});
  const page = await f.gateway.readTree({ protocol: 2, selection: f.base.selection, target: f.base.target, kind: 'children', parent: f.base.origin }, signal());
  assert.deepEqual(page.nodes, []); assert.equal(f.requests.some(value => value.purpose === 'resource-list'), false);
  await assert.rejects(f.gateway.readLogs(f.request, signal()), fails('STALE_TARGET')); assert.equal(f.requests.some(value => value.purpose === 'pod-logs'), false);
  f.selector({ matchLabels: { batch: 'other' } }); await assert.rejects(f.gateway.readLogs(f.request, signal()), fails('STALE_TARGET')); f.close();
});

test('selector membership supports In/NotIn/Exists/DoesNotExist and own prototype-like labels without executing anything', () => {
  const selector = { matchLabels: { app: 'x' }, matchExpressions: [{ key: 'tier', operator: 'In', values: ['api'] }, { key: 'bad', operator: 'NotIn', values: ['yes'] }, { key: 'app', operator: 'Exists' }, { key: 'gone', operator: 'DoesNotExist' }] };
  assert.equal(matchesPodSelector(selector, { app: 'x', tier: 'api' }), true);
  for (const labels of [{ app: 'x' }, { app: 'x', tier: 'api', bad: 'yes' }, { app: 'x', tier: 'api', gone: '' }]) assert.equal(matchesPodSelector(selector, labels), false);
  assert.equal(matchesPodSelector({ matchLabels: { toString: 'own' } }, {}), false);
  assert.equal(matchesPodSelector({ matchLabels: { toString: 'own' } }, { toString: 'own' }), true);
  assert.throws(() => matchesPodSelector({ matchExpressions: [{ key: 'a', operator: 'In', values: [] }] }, {}), fails('SELECTOR_INVALID'));
});

test('malformed Job selectors/Pod labels fail fixed rather than leaking original input or matching every Pod', async () => {
  for (const mode of ['selector', 'labels'] as const) {
    const f = await fixture(); if (mode === 'selector') f.selector({ matchExpressions: [{ key: 'a', operator: marker }] }); else f.labels({ batch: { private: marker } });
    await assert.rejects(f.gateway.readLogs(f.request, signal()), fails(mode === 'selector' ? 'SELECTOR_INVALID' : 'RESOURCE_INVALID'));
    assert.equal(f.requests.some(value => value.purpose === 'pod-logs'), false); f.close();
  }
});

test('Job-origin namespace, resource kind, and missing stable identities cannot be promoted into log provenance', async () => {
  const f = await fixture();
  for (const origin of [{ ...f.base.origin, resource: 'deployments' }, { ...f.base.origin, uid: undefined }, { ...f.base.origin, namespace: 'other' }]) {
    assert.equal(podLogRequestSchema.safeParse({ ...f.request, origin }).success, false); assert.equal(jobLogOriginFromParent(origin) !== null, origin.namespace === 'other');
  }
  assert.equal(jobLogOriginFromParent({ ...f.base.origin, resource: 'pods' }), null);
  await assert.rejects(f.gateway.readLogs({ ...f.request, target: { ...f.base.target, namespace: 'other' } }, signal()), fails('STALE_TARGET')); assert.equal(f.requests.length, 0); f.close();
});

test('selector matching is provenance, not an ownerReference claim or implicit first Pod selection', async () => {
  const f = await fixture(); const page = await f.gateway.readLogs(f.request, signal()); assert.ok(page.kind === 'pod-log');
  assert.equal(page.reference.name, 'actual'); assert.equal(page.origin?.name, 'work'); // Fixture deliberately has no ownerReferences.
  f.close();
});

test('Job-origin continued chunks recheck Job/Pod/Job, preserve snapshot text and reject changed selector proof', async () => {
  const f = await fixture('a'.repeat(140_000)), first = await f.gateway.readLogs(f.request, signal()); assert.ok(first.kind === 'pod-log' && first.nextCursor);
  const count = f.requests.length; f.text('new logs');
  const second = await f.gateway.readLogs({ ...f.request, cursor: first.nextCursor }, signal()); assert.ok(second.kind === 'pod-log');
  assert.equal(second.text, 'a'.repeat(65_536)); assert.equal(second.snapshotId, first.snapshotId); assert.equal(f.requests.length - count, 3);
  f.selector({ matchLabels: { batch: 'work' }, matchExpressions: [{ key: 'absent', operator: 'NotIn', values: ['x'] }] });
  await assert.rejects(f.gateway.readLogs({ ...f.request, cursor: second.nextCursor }, signal()), fails('STALE_TARGET')); f.close();
});

test('Job cursor cannot cross origin, omit origin, or cross Pod and never starts another log read', async () => {
  const f = await fixture('a'.repeat(70_000)), page = await f.gateway.readLogs(f.request, signal()); assert.ok(page.kind === 'pod-log' && page.nextCursor); const count = f.requests.length;
  for (const change of [{ origin: undefined }, { origin: { ...f.base.origin, name: 'different' } }, { origin: { ...f.base.origin, uid: 'different' } }, { reference: { ...f.base.reference, name: 'second', uid: 'second-u' } }]) await assert.rejects(f.gateway.readLogs({ ...f.request, ...change, cursor: page.nextCursor }, signal()), fails('STALE_TARGET'));
  assert.equal(f.requests.length, count); f.close();
});

test('client rejects an omitted, wrong, or unsolicited Job origin in both container and log responses', async () => {
  const f = await fixture(), page = await f.gateway.readLogs(f.request, signal()); assert.ok(page.kind === 'pod-log');
  for (const origin of [undefined, { ...f.base.origin, uid: 'wrong' }]) {
    const states: PodLogState[] = [], client = new PodLogClient(async request => JSON.parse(request.body).kind === 'containers' ? f.transport(request) : { status: 200, body: JSON.stringify({ ...page, origin }) }, state => states.push(state));
    await client.open({ ...f.base, kind: 'containers' }); await client.run('main', f.request.options); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.text, ''); client.dispose();
  }
  const states: PodLogState[] = [], client = new PodLogClient(async request => {
    const response = await f.transport(request), value = JSON.parse(response.body); return { status: 200, body: JSON.stringify({ ...value, origin: f.base.origin }) };
  }, state => states.push(state));
  await client.open({ ...f.base, origin: undefined, kind: 'containers' }); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); client.dispose(); f.close();
});

test('a late Job-origin client response after reset cannot resurrect the old view', async () => {
  const f = await fixture(); let release: (() => void) | undefined, start: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { start = resolve; });
  f.wait(async request => { if (request.purpose === 'pod-logs') { start?.(); await gate; } });
  await f.client.open({ ...f.base, kind: 'containers' }); const pending = f.client.run('main', f.request.options); await started; f.client.reset(); release?.(); await pending;
  assert.equal(f.states.some(value => value.text.includes(marker)), false); assert.equal(f.states.at(-1)?.phase, 'idle'); f.close();
});

test('Job-origin and direct-Pod snapshots remain isolated for the same actual Pod', async () => {
  const f = await fixture('a'.repeat(70_000)), a = await f.gateway.readLogs(f.request, signal()); assert.ok(a.kind === 'pod-log');
  const b = await f.gateway.readLogs({ ...f.request, origin: undefined }, signal()); assert.ok(b.kind === 'pod-log');
  assert.notEqual(a.snapshotId, b.snapshotId); assert.deepEqual(a.origin, f.base.origin); assert.equal(b.origin, undefined); f.close();
});

test('Job projection and container reads remain inside the global two-loader pool', async () => {
  const f = await fixture(); let release: (() => void) | undefined, start: (() => void) | undefined, active = 0, maximum = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { start = resolve; });
  f.wait(async () => { active++; maximum = Math.max(maximum, active); if (active === 2) start?.(); await gate; active--; });
  const a = f.gateway.readLogs(f.request, signal()), b = f.gateway.readLogs({ ...f.base, kind: 'containers' }, signal());
  await started; assert.equal(f.requests.length, 2); release?.(); await Promise.all([a, b]); assert.equal(maximum, 2); f.close();
});

test('selected Pod UID or RV changes reject Job logs before the log endpoint even when the selector still matches', async () => {
  for (const mode of ['uid', 'rv'] as const) {
    const f = await fixture(); f.podIdentity(mode === 'uid' ? 'new' : 'pod-u', mode === 'rv' ? '2' : '1');
    await assert.rejects(f.gateway.readLogs(f.request, signal()), fails('STALE_TARGET')); assert.equal(f.requests.some(value => value.purpose === 'pod-logs'), false); f.close();
  }
});

test('cancelled duplicate Job log consumer cannot stop the peer or create a second underlying snapshot', async () => {
  const f = await fixture(); let release: (() => void) | undefined, start: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { start = resolve; });
  f.wait(async request => { if (request.purpose === 'pod-logs') { start?.(); await gate; } }); const abort = new AbortController();
  const a = f.gateway.readLogs(f.request, abort.signal).catch(error => error instanceof BoundaryError ? error.code : 'unexpected');
  await started; const b = f.gateway.readLogs(f.request, signal()); abort.abort(); assert.equal(await a, 'QUERY_CANCELLED'); release?.();
  const page = await b; assert.ok(page.kind === 'pod-log'); assert.deepEqual(page.origin, f.base.origin);
  assert.equal(f.requests.filter(value => value.purpose === 'pod-logs').length, 1); assert.equal(f.requests.length, 5); f.close();
});

test('container responses cannot lose or substitute the requested Job origin and silently open direct Pod logs', async () => {
  const f = await fixture();
  for (const origin of [undefined, { ...f.base.origin, uid: 'substitute' }]) {
    const states: PodLogState[] = [], client = new PodLogClient(async request => {
      const result = await f.transport(request); return { ...result, body: JSON.stringify({ ...JSON.parse(result.body), origin }) };
    }, state => states.push(state));
    await client.open({ ...f.base, kind: 'containers' }); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.deepEqual(states.at(-1)?.containers, []);
    await client.run('main', f.request.options); assert.equal(f.requests.some(value => value.purpose === 'pod-logs'), false); client.dispose();
  }
  f.close();
});
