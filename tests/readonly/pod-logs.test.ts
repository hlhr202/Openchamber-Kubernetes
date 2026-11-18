import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { logBytes, logChunkCharacters, logDisplayText, podLogRequestSchema } from '../../src/shared/pod-log-protocol.ts';
import { PodLogClient } from '../../src/host/pod-log-client.ts';
import type { PodLogState } from '../../src/host/pod-log-client.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { createResourceReader } from '../../src/service/queries/resource-reader.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import type { ReadResponse } from '../../src/service/queries/bounded-response.ts';
import { createPodLogReader } from '../../src/service/queries/pod-logs.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';

const signal = () => new AbortController().signal, marker = 'SYNTHETIC_LOG_ONLY';
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;
const options = { timestamps: false, sinceSeconds: null, tailLines: null };
async function fixture(initial = marker) {
  let text = initial, uid = 'uid', rv = '1', restarts = 0, objects = 0, changedConfig = false;
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': changedConfig ? 'other' : 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const current = await config.read({ mode: 'default' });
  const target = { serviceGeneration: 's', projectId: 'view', configIdentity: current.snapshot.configIdentity, context: 'active', namespace: 'default' };
  const reference = { resource: 'pods' as const, namespace: 'other', name: 'pod', uid, resourceVersion: rv };
  const base = { protocol: 2 as const, selection: { mode: 'default' as const }, target, reference };
  const requests: ResourceReadRequest[] = [], states: PodLogState[] = [];
  let wait: ((request: ResourceReadRequest) => Promise<void>) | undefined, response: (() => ReadResponse) | undefined, onObject: ((count: number) => void) | undefined;
  function pod() { return { apiVersion: 'v1', kind: 'Pod', metadata: { namespace: 'other', name: 'pod', uid, resourceVersion: rv, annotations: { private: marker } },
    spec: { initContainers: [{ name: 'init' }], containers: [{ name: 'main' }], ephemeralContainers: [{ name: 'not-baseline' }] },
    status: { containerStatuses: [{ name: 'main', restartCount: restarts, containerID: `synthetic://${restarts}`, state: { running: { startedAt: '2026-10-23T01:00:00Z' } } }] } }; }
  const read = async (request: ResourceReadRequest): Promise<ReadResponse> => {
    kubectlReadArguments(request, '/synthetic/owned/configuration.pipe'); requests.push(request); await wait?.(request);
    if (request.purpose === 'pod-logs' && response) return response();
    if (request.purpose === 'resource-object') onObject?.(++objects);
    const body = request.purpose === 'pod-logs' ? text : JSON.stringify(pod());
    return { status: 200, body: { async *[Symbol.asyncIterator]() { const bytes = Buffer.from(body); yield bytes.subarray(0, 1); yield bytes.subarray(1); } }, close: async () => {} };
  };
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: (_selection, request) => read(request) });
  const transport = async (request: { method: 'POST'; path: string; body: string }) => {
    assert.equal(request.path, '/v2/logs/read'); assert.equal(request.body.includes(marker), false);
    try { return { status: 200, body: JSON.stringify(await gateway.readLogs(JSON.parse(request.body) as unknown, signal())) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  };
  const client = new PodLogClient(transport, value => states.push(value));
  const request = { ...base, kind: 'read' as const, container: 'main', options };
  return { base, request, gateway, client, states, requests, read, transport,
    text: (value: string) => { text = value; }, identity: (u: string, r: string) => { uid = u; rv = r; }, restart: () => { restarts++; }, config: () => { changedConfig = true; },
    onObject: (value: (count: number) => void) => { onObject = value; }, wait: (value: (request: ResourceReadRequest) => Promise<void>) => { wait = value; }, response: (value: () => ReadResponse) => { response = value; },
    close: () => { client.dispose(); gateway.close(); } };
}

test('opening Pod logs only reads init/regular container names; no autorun, ephemeral entries or source metadata', async () => {
  const f = await fixture(); assert.equal(f.requests.length, 0);
  await f.client.open({ ...f.base, kind: 'containers' });
  assert.deepEqual(f.states.at(-1)?.containers, [{ name: 'init', kind: 'init' }, { name: 'main', kind: 'regular' }]);
  assert.equal(f.states.at(-1)?.text, ''); assert.equal(f.requests.length, 1); assert.equal(JSON.stringify(f.states).includes(marker), false); f.close();
});

test('explicit finite logs use GET only between two fresh original Pod checks and retain exact UTF-8/BOM/CRLF', async () => {
  const text = '\ufeff中文🎉\r\n' + marker, f = await fixture(text);
  await f.client.open({ ...f.base, kind: 'containers' }); await f.client.run('main', options);
  assert.equal(f.states.at(-1)?.text, text); assert.equal(f.states.at(-1)?.complete, true);
  assert.deepEqual(f.requests.map(value => value.purpose), ['resource-object', 'resource-object', 'pod-logs', 'resource-object']);
  assert.equal(f.requests[2]?.path, '/api/v1/namespaces/other/pods/pod/log'); assert.deepEqual(f.requests[2]?.query, { container: 'main', timestamps: 'false' }); f.close();
});

test('timestamps/since/tail are exact structured parameters; no-filter means omitted, never since=0 or previous/follow', async () => {
  const f = await fixture(); await f.gateway.readLogs({ ...f.request, options: { timestamps: true, sinceSeconds: 3600, tailLines: 20 } }, signal());
  assert.deepEqual(f.requests[1]?.query, { container: 'main', timestamps: 'true', sinceSeconds: '3600', tailLines: '20' });
  for (const value of [{ ...f.request, follow: true }, { ...f.request, previous: true }, { ...f.request, command: 'exec' }, { ...f.request, options: { ...options, sinceSeconds: 0 } }, { ...f.request, options: { ...options, tailLines: -1 } }, { ...f.request, container: 'x;exec' }]) assert.equal(podLogRequestSchema.safeParse(value).success, false);
  f.close();
});

test('log planner rejects arbitrary subresources, query flags, values and versions without a process', async () => {
  const f = await fixture(); await f.gateway.readLogs(f.request, signal()); const request = f.requests.find(value => value.purpose === 'pod-logs'); assert.ok(request);
  for (const value of [{ ...request, path: request.path.replace('/log', '/exec') }, { ...request, path: request.path.replace('/api/v1', '/apis/apps/v1') },
    { ...request, query: { ...request.query, follow: 'true' } }, { ...request, query: { ...request.query, previous: 'true' } },
    { ...request, query: { ...request.query, tailLines: '0' } }, { ...request, query: { ...request.query, sinceSeconds: '1;exec' } }]) assert.throws(() => kubectlReadArguments(value, '/synthetic/configuration.pipe'), fails('INVALID_INPUT'));
  f.close();
});

test('finite chunks recheck Pod/runtime but never reread growing logs or split surrogate pairs', async () => {
  const text = 'a'.repeat(logChunkCharacters - 1) + '🎉' + marker, f = await fixture(text);
  await f.client.open({ ...f.base, kind: 'containers' }); await f.client.run('main', options); assert.equal(f.states.at(-1)?.text.length, logChunkCharacters - 1); assert.equal(f.states.at(-1)?.complete, false);
  f.text('new stream'); await f.client.next(); assert.equal(f.states.at(-1)?.text, text); assert.equal(f.states.at(-1)?.complete, true);
  assert.equal(f.requests.filter(value => value.purpose === 'pod-logs').length, 1); f.close();
});

test('empty logs are a valid complete snapshot, not idle/error', async () => {
  const f = await fixture(''); await f.client.open({ ...f.base, kind: 'containers' }); await f.client.run('main', options);
  assert.equal(f.states.at(-1)?.complete, true); assert.equal(f.states.at(-1)?.page?.totalBytes, 0); f.close();
});

test('recreated Pod, changed RV or same-RV container restart rejects the entire initial read', async () => {
  for (const mode of ['uid', 'rv', 'restart'] as const) {
    const f = await fixture(); f.onObject(count => { if (count === 2) { if (mode === 'restart') f.restart(); else f.identity(mode === 'uid' ? 'new' : 'uid', mode === 'rv' ? '2' : '1'); } });
    await assert.rejects(f.gateway.readLogs(f.request, signal()), fails('STALE_TARGET')); f.close();
  }
});

test('a continued snapshot rejects old Pod identity/runtime rather than mixing container incarnations', async () => {
  const f = await fixture('a'.repeat(70_000)), page = await f.gateway.readLogs(f.request, signal()); assert.ok(page.kind === 'pod-log' && page.nextCursor);
  f.restart(); await assert.rejects(f.gateway.readLogs({ ...f.request, cursor: page.nextCursor }, signal()), fails('STALE_TARGET')); f.close();
});

test('missing container is NOT_FOUND before logs; invalid references/config changes do not issue a log request', async () => {
  const f = await fixture(); await assert.rejects(f.gateway.readLogs({ ...f.request, container: 'absent' }, signal()), fails('NOT_FOUND'));
  assert.equal(f.requests.filter(value => value.purpose === 'pod-logs').length, 0);
  f.config(); await assert.rejects(f.gateway.readLogs(f.request, signal()), fails('STALE_TARGET')); assert.equal(f.requests.length, 1); f.close();
});

test('error bodies are never iterated; status errors and invalid UTF-8 never echo logs', async () => {
  const f = await fixture(); let iterated = 0, closed = 0;
  for (const [status, code] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [410, 'CONTINUATION_EXPIRED'], [429, 'QUERY_LIMIT']] as const) {
    f.response(() => ({ status, body: { async *[Symbol.asyncIterator]() { iterated++; yield Buffer.from(marker); } }, close: async () => { closed++; } }));
    await assert.rejects(f.gateway.readLogs(f.request, signal()), fails(code));
  }
  assert.equal(iterated, 0); assert.equal(closed, 5);
  f.response(() => ({ status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from([255]); } }, close: async () => {} }));
  await assert.rejects(f.gateway.readLogs(f.request, signal()), fails('RESOURCE_INVALID')); f.close();
});

test('per-snapshot 1MiB is supported; exceeding it fails rather than claiming truncation is complete', async () => {
  const f = await fixture('a'.repeat(logBytes)); const page = await f.gateway.readLogs(f.request, signal()); assert.ok(page.kind === 'pod-log'); assert.equal(page.totalBytes, logBytes);
  f.text('a'.repeat(logBytes + 1)); await assert.rejects(f.gateway.readLogs(f.request, signal()), fails('BUDGET_EXCEEDED')); f.close();
});

test('snapshot cache hard-limits total UTF-8 bytes/count and expires fixed deadlines without renewal', async () => {
  const f = await fixture('a'.repeat(logBytes)), reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => target, read: f.read }); let clock = 0;
  const logs = createPodLogReader(reader, () => clock);
  for (let count = 0; count < 4; count++) await logs.read(f.request, signal());
  assert.equal(logs.state.bytes, 4 * logBytes); const count = f.requests.length;
  await assert.rejects(logs.read(f.request, signal()), fails('QUERY_LIMIT')); assert.equal(f.requests.length, count);
  clock = 60_000; assert.deepEqual(logs.state, { snapshots: 0, bytes: 0, pending: 0 }); logs.dispose(); reader.close(); f.close();
});

test('sealed log cursor rejects target/options/parent changes, tampering and cross-reader use before another GET', async () => {
  const f = await fixture('a'.repeat(70_000)), page = await f.gateway.readLogs(f.request, signal()); assert.ok(page.kind === 'pod-log' && page.nextCursor); const count = f.requests.length;
  for (const patch of [{ cursor: `${page.nextCursor}x` }, { cursor: page.nextCursor, container: 'init' }, { cursor: page.nextCursor, options: { ...options, timestamps: true } }, { cursor: page.nextCursor, reference: { ...f.base.reference, uid: 'new' } }]) await assert.rejects(f.gateway.readLogs({ ...f.request, ...patch }, signal()), fails('STALE_TARGET'));
  assert.equal(f.requests.length, count);
  const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => target, read: f.read }), other = createPodLogReader(reader);
  await assert.rejects(other.read({ ...f.request, cursor: page.nextCursor }, signal()), fails('STALE_TARGET')); assert.equal(f.requests.length, count);
  other.dispose(); reader.close(); f.close();
});

test('fixed deadline is checked after a continued Pod check, and dispose rejects new reads', async () => {
  const f = await fixture('a'.repeat(70_000)), reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => target, read: f.read }); let clock = 0;
  const logs = createPodLogReader(reader, () => clock), page = await logs.read(f.request, signal()); assert.ok(page.kind === 'pod-log' && page.nextCursor);
  f.wait(async () => { clock = 60_000; }); await assert.rejects(logs.read({ ...f.request, cursor: page.nextCursor }, signal()), fails('CONTINUATION_EXPIRED'));
  logs.dispose(); await assert.rejects(logs.read(f.request, signal()), fails('SERVICE_CLOSED')); reader.close(); f.close();
});

test('read-only output escapes C0/C1/ANSI controls without interpreting HTML, links or terminal commands', () => {
  assert.equal(logDisplayText('\u001b[31m\0\u009b<script>\t\r\n🎉'), '\\u001b[31m\\u0000\\u009b<script>\t\r\n🎉');
});

test('client refuses wrong source, sensitive DTO extensions, offsets, encoding counts and snapshot replay', async () => {
  const f = await fixture(), original = await f.gateway.readLogs(f.request, signal()); assert.ok(original.kind === 'pod-log');
  for (const value of [{ ...original, container: 'other' }, { ...original, offset: 1 }, { ...original, totalBytes: 0 }, { ...original, target: { ...original.target, projectId: 'other' } }, { ...original, raw: marker }]) {
    const states: PodLogState[] = [], client = new PodLogClient(async request => JSON.parse(request.body).kind === 'containers' ? f.transport(request) : { status: 200, body: JSON.stringify(value) }, state => states.push(state));
    await client.open({ ...f.base, kind: 'containers' }); await client.run('main', options); assert.equal(states.at(-1)?.phase, 'error'); assert.equal(states.at(-1)?.text, ''); client.dispose();
  }
  f.close();
});

test('late cancellation/reset/clear/dispose cannot display logs, while cancelled calls retain admission slots', async () => {
  const f = await fixture(), page = await f.gateway.readLogs(f.request, signal());
  for (const action of ['cancel', 'reset', 'clear', 'dispose'] as const) {
    const states: PodLogState[] = []; let release: (() => void) | undefined;
    const client = new PodLogClient(async request => JSON.parse(request.body).kind === 'containers' ? f.transport(request) : new Promise(resolve => { release = () => resolve({ status: 200, body: JSON.stringify(page) }); }), state => states.push(state));
    await client.open({ ...f.base, kind: 'containers' }); const pending = client.run('main', options); client[action](); release?.(); await pending;
    assert.equal(states.some(value => value.text.includes(marker)), false); client.dispose();
  }
  const releases: (() => void)[] = [], states: PodLogState[] = [];
  const client = new PodLogClient(async () => { await new Promise<void>(resolve => { releases.push(resolve); }); return { status: 500, body: marker }; }, state => states.push(state));
  const reads: Promise<void>[] = []; for (let index = 0; index < 4; index++) { reads.push(client.open({ ...f.base, kind: 'containers' })); client.cancel(); }
  await client.open({ ...f.base, kind: 'containers' }); assert.equal(states.at(-1)?.error, 'QUERY_LIMIT'); assert.equal(releases.length, 4);
  for (const release of releases) release(); await Promise.all(reads); client.dispose(); f.close();
});

test('one cancelled duplicate log request does not cancel its peer or allocate duplicate snapshot reads', async () => {
  const f = await fixture(); let release: (() => void) | undefined, start: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { start = resolve; });
  f.wait(async request => { if (request.purpose === 'pod-logs') { start?.(); await gate; } }); const abort = new AbortController();
  const a = f.gateway.readLogs(f.request, abort.signal).catch(error => error instanceof BoundaryError ? error.code : 'unexpected');
  await started; const b = f.gateway.readLogs(f.request, signal()); abort.abort(); assert.equal(await a, 'QUERY_CANCELLED'); release?.();
  assert.equal((await b).kind, 'pod-log'); assert.equal(f.requests.filter(value => value.purpose === 'pod-logs').length, 1); f.close();
});

test('complete maximum-sized snapshot assembles exactly once and does not silently lose the final chunk', async () => {
  const text = marker + 'x'.repeat(logBytes - marker.length), f = await fixture(text);
  await f.client.open({ ...f.base, kind: 'containers' }); await f.client.run('main', options);
  for (let count = 1; count < 16; count++) { assert.equal(f.states.at(-1)?.phase, 'ready'); assert.equal(f.states.at(-1)?.complete, false); await f.client.next(); }
  assert.equal(f.states.at(-1)?.complete, true); assert.equal(f.states.at(-1)?.text, text); assert.equal(f.requests.filter(value => value.purpose === 'pod-logs').length, 1); f.close();
});

test('eight tiny snapshots fill the count budget, and pending reads reserve bytes before loading', async () => {
  const f = await fixture('x'), reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => target, read: f.read }), logs = createPodLogReader(reader);
  for (let count = 0; count < 8; count++) await logs.read(f.request, signal());
  await assert.rejects(logs.read(f.request, signal()), fails('QUERY_LIMIT')); assert.equal(logs.state.snapshots, 8); logs.dispose(); reader.close();
  const releases: (() => void)[] = [];
  const pendingLogs = createPodLogReader({ logContainers: async () => [{ name: 'main', kind: 'regular' }], logRuntime: async () => 'runtime',
    podLogs: async () => { await new Promise<void>(resolve => { releases.push(resolve); }); return { text: 'x', runtime: 'runtime' }; } });
  const pending = Array.from({ length: 4 }, () => pendingLogs.read(f.request, signal()).catch(error => error instanceof BoundaryError ? error.code : 'unexpected'));
  await assert.rejects(pendingLogs.read(f.request, signal()), fails('QUERY_LIMIT')); assert.equal(pendingLogs.state.pending, 4);
  pendingLogs.dispose(); for (const release of releases) release(); assert.deepEqual(await Promise.all(pending), Array(4).fill('SERVICE_CLOSED')); assert.equal(pendingLogs.state.snapshots, 0); f.close();
});

test('continued client rejects snapshot/offset/cursor replay and retains only explicitly stale validated text', async () => {
  const f = await fixture('a'.repeat(150_000)), first = await f.gateway.readLogs(f.request, signal()); assert.ok(first.kind === 'pod-log' && first.nextCursor);
  const second = await f.gateway.readLogs({ ...f.request, cursor: first.nextCursor }, signal()); assert.ok(second.kind === 'pod-log');
  for (const bad of [{ ...second, snapshotId: '00000000-0000-4000-8000-000000000000' }, { ...second, offset: 0 }, { ...second, nextCursor: first.nextCursor }]) {
    let pages = 0; const states: PodLogState[] = [], client = new PodLogClient(async request => JSON.parse(request.body).kind === 'containers' ? f.transport(request)
      : { status: 200, body: JSON.stringify(++pages === 1 ? first : bad) }, state => states.push(state));
    await client.open({ ...f.base, kind: 'containers' }); await client.run('main', options); await client.next();
    assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.stale, true); assert.equal(states.at(-1)?.text, first.text);
    await client.next(); assert.equal(pages, 2); client.dispose();
  }
  f.close();
});

test('log consumers still share the global two-read pool, including metadata and non-cooperating reads', async () => {
  const f = await fixture(); let release: (() => void) | undefined, start: (() => void) | undefined, active = 0, maximum = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { start = resolve; });
  f.wait(async () => { active++; maximum = Math.max(maximum, active); if (active === 2) start?.(); await gate; active--; });
  const a = f.gateway.readLogs(f.request, signal()), b = f.gateway.readLogs({ ...f.request, options: { ...options, timestamps: true } }, signal());
  const c = f.gateway.readLogs({ ...f.base, kind: 'containers' }, signal()); await started; assert.equal(f.requests.length, 2); release?.(); await Promise.all([a, b, c]); assert.equal(maximum, 2); f.close();
});

test('config changes during a log read and a page completed after its initial deadline cannot publish a snapshot', async () => {
  const f = await fixture(); f.wait(async request => { if (request.purpose === 'pod-logs') f.config(); });
  await assert.rejects(f.gateway.readLogs(f.request, signal()), fails('STALE_TARGET')); f.close();
  const other = await fixture(), reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => target, read: other.read }); let clock = 0;
  const logs = createPodLogReader(reader, () => clock); other.wait(async request => { if (request.purpose === 'pod-logs') clock = 60_000; });
  await assert.rejects(logs.read(other.request, signal()), fails('CONTINUATION_EXPIRED')); assert.equal(logs.state.snapshots, 0); logs.dispose(); reader.close(); other.close();
});

test('invalid/rejected requests and oversized responses never reveal raw errors or issue hidden retries', async () => {
  const f = await fixture(); const abort = new AbortController(); abort.abort();
  await assert.rejects(f.gateway.readLogs(f.request, abort.signal), fails('QUERY_CANCELLED')); assert.equal(f.requests.length, 0);
  const states: PodLogState[] = [], client = new PodLogClient(async () => ({ status: 500, body: marker }), state => states.push(state));
  await client.open({ ...f.base, kind: 'containers' }); assert.equal(states.at(-1)?.error, 'STATE_UNAVAILABLE'); assert.equal(JSON.stringify(states).includes(marker), false); client.dispose();
  const hugeStates: PodLogState[] = [], huge = new PodLogClient(async () => ({ status: 200, body: 'x'.repeat(512_001) }), state => hugeStates.push(state));
  await huge.open({ ...f.base, kind: 'containers' }); assert.equal(hugeStates.at(-1)?.error, 'BUDGET_EXCEEDED'); huge.dispose(); f.close();
});
