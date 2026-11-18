// Synthetic metadata/list/watch and detached read client only. Never SDK/bridge/real worker/CLI or write/session controls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { jobLogSelectionSourceSchema, jobLogSelectionOpenSchema, jobLogSelectionPageSchema, jobLogSelectedSchema } from '../../src/shared/job-log-selection-protocol.ts';
import type { JobLogSelectionSource, JobLogSelected, JobLogSelectionPage } from '../../src/shared/job-log-selection-protocol.ts';
import { projectJobLogCandidate, projectJobLogCandidatePage, compareJobLogCandidates, jobLogSelector, planJobPodWatch } from '../../src/service/queries/job-log-selection-source.ts';
import { runJobLogSelection } from '../../src/service/queries/job-log-selection-runner.ts';
import { createReadTasks, createReadTaskBudget } from '../../src/service/queries/read-tasks.ts';
import { createWatchTasks } from '../../src/service/queries/watch-tasks.ts';
import { JobLogSelectionClient } from '../../src/host/job-log-selection-client.ts';
import type { JobLogSelectionState } from '../../src/host/job-log-selection-client.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { parseReadWorkerStart } from '../../src/service/queries/read-worker-protocol.ts';
const source: JobLogSelectionSource = { protocol: 2, target: { serviceGeneration: 's', projectId: 'p', configIdentity: 'c', context: 'active', namespace: 'default' }, selection: { mode: 'default' }, origin: { resource: 'jobs', namespace: 'default', name: 'job', uid: 'job-u', resourceVersion: 'j1' } };
const job = () => ({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'job', namespace: 'default', uid: 'job-u', resourceVersion: 'j1' }, spec: { selector: { matchLabels: { app: 'synthetic' } } } });
const pod = (name = 'pod') => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: 'default', uid: `${name}-u`, resourceVersion: 'p1', creationTimestamp: '2026-10-23T00:00:00Z', labels: { app: 'synthetic' }, annotations: { synthetic: 'SYNTHETIC_SECRET' } },
  spec: { nodeName: 'node', containers: [{ name: 'main' }], initContainers: [{ name: 'sidecar', restartPolicy: 'Always' }] },
  status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: '2026-10-23T01:00:00Z' }], containerStatuses: [{ name: 'main', restartCount: 0 }], initContainerStatuses: [{ name: 'sidecar', restartCount: 0 }] } });
const rank = (value = pod()) => projectJobLogCandidate(value, job(), source);
const signal = () => new AbortController().signal;
const tick = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
const open = (view = 'a', value = source, epoch = 1) => ({ ...value, consumer: { view: view.repeat(32), epoch } });
const control = (value: JobLogSelectionPage, after = 0) => ({ protocol: 2, handle: value.handle, after });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const page = (candidates = [rank()]) => ({ selector: 'app=synthetic', resourceVersion: 'list-rv', continuation: null as string | null, candidates });
test('Job source is strict, requires real Job UID/RV/current namespace, never arbitrary target kind/path', () => {
  assert.ok(jobLogSelectionOpenSchema.safeParse(open()).success);
  for (const change of [{ origin: { ...source.origin, resource: 'deployments' } }, { origin: { ...source.origin, namespace: 'other' } }, { origin: { ...source.origin, uid: undefined } }, { path: '/arbitrary' }]) assert.equal(jobLogSelectionSourceSchema.safeParse({ ...source, ...change }).success, false);
});
test('selector is original Job namespace/spec.selector, never template labels or an unfiltered fallback', () => {
  assert.equal(jobLogSelector(job(), source), 'app=synthetic'); const empty = { ...job(), spec: { selector: {} } };
  assert.throws(() => jobLogSelector(empty, source), /SELECTOR_INVALID/); const replacement = job(); replacement.metadata.uid = 'new'; assert.throws(() => jobLogSelector(replacement, source), /STALE_TARGET/);
});
test('ByLogging first prefers assigned over unassigned, not alphabetic/default tree order', () => {
  const unassigned = pod('aaa'); unassigned.spec.nodeName = ''; assert.ok(compareJobLogCandidates(rank(pod('zzz')), rank(unassigned)) < 0);
});
test('ByLogging phase map is Running=0 Unknown=1 Pending=2, Failed/Succeeded use Go zero rank', () => {
  const running = rank(); const pending = pod(); pending.status.phase = 'Pending'; const unknown = pod(); unknown.status.phase = 'Unknown'; const failed = pod(); failed.status.phase = 'Failed';
  assert.ok(compareJobLogCandidates(running, rank(unknown)) < 0); assert.ok(compareJobLogCandidates(rank(unknown), rank(pending)) < 0); assert.equal(compareJobLogCandidates(running, rank(failed)), 0);
});
test('ready then earlier ready time then zero/missing time ordering is preserved with nanoseconds', () => {
  const notReady = pod(); notReady.status.conditions[0]!.status = 'False'; assert.ok(compareJobLogCandidates(rank(), rank(notReady)) < 0);
  const later = pod(); later.status.conditions[0]!.lastTransitionTime = '2026-10-23T01:00:00.000000001Z'; assert.ok(compareJobLogCandidates(rank(), rank(later)) < 0);
  later.status.conditions[0]!.lastTransitionTime = '0001-01-01T00:00:00Z'; assert.ok(compareJobLogCandidates(rank(), rank(later)) < 0);
});
test('higher regular restart maximum is preferred before sidecar restarts, ordinary init restarts are not sidecars', () => {
  const high = pod(); high.status.containerStatuses[0]!.restartCount = 5; assert.ok(compareJobLogCandidates(rank(high), rank()) < 0);
  const sidecar = pod(); sidecar.status.initContainerStatuses[0]!.restartCount = 9; assert.ok(compareJobLogCandidates(rank(sidecar), rank()) < 0); assert.ok(compareJobLogCandidates(rank(high), rank(sidecar)) < 0);
  sidecar.spec.initContainers = []; assert.equal(compareJobLogCandidates(rank(sidecar), rank()), 0);
});
test('older creation then missing timestamp is the final key; deletion/name do not invent extra ranking', () => {
  const newer = pod('aaa'); newer.metadata.creationTimestamp = '2026-10-23T00:00:01Z'; assert.ok(compareJobLogCandidates(rank(pod('zzz')), rank(newer)) < 0);
  newer.metadata.creationTimestamp = '0001-01-01T00:00:00Z'; assert.ok(compareJobLogCandidates(rank(), rank(newer)) < 0);
  assert.equal(compareJobLogCandidates(rank(pod('a')), rank(pod('z'))), 0);
});
test('rank projection rejects foreign namespace/GVK, missing metadata and selector mismatches', () => {
  for (const value of [{ ...pod(), kind: 'Secret' }, { ...pod(), apiVersion: 'apps/v1' }, { ...pod(), metadata: { ...pod().metadata, namespace: 'other' } }, { ...pod(), metadata: { ...pod().metadata, labels: { app: 'foreign' } } }]) assert.throws(() => projectJobLogCandidate(value, job(), source));
});
test('strict bounded candidate pages retain only private rank keys and public reference, never template/annotations/messages', () => {
  const result = projectJobLogCandidatePage({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: 'rv' }, items: [pod()] }, job(), source);
  assert.equal(result.candidates.length, 1); assert.equal(Object.keys(result.candidates[0]!).includes('spec'), false); assert.equal(JSON.stringify(result.candidates[0]!.reference).includes('SYNTHETIC_SECRET'), false);
  assert.throws(() => projectJobLogCandidatePage({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: 'rv' }, items: Array.from({ length: 101 }, () => pod()) }, job(), source), /RESOURCE_INVALID/);
});
test('selection compares the entire same-RV paginated snapshot and reports total count, not first visible page', async () => {
  let pages = 0, watches = 0; const low = pod('low'); low.spec.nodeName = ''; const selected: Omit<JobLogSelected, 'sequence'>[] = [];
  await runJobLogSelection(source, signal(), value => selected.push(value), { list: async previous => { pages++; if (pages === 2) assert.deepEqual(previous, { selector: 'app=synthetic', resourceVersion: 'list-rv', continuation: 'next' }); return { ...page([rank(pages === 1 ? low : pod('best'))]), continuation: pages === 1 ? 'next' : null }; }, verify: async (_selector, reference) => reference, transport: async () => { watches++; }, charge: () => {} });
  assert.equal(selected[0]?.reference.name, 'best'); assert.equal(selected[0]?.candidates, 2); assert.equal(selected[0]?.waited, false); assert.equal(watches, 0);
});
test('equal ranks retain original list order without pretending to promise kubectl unstable tie order', async () => {
  let chosen = ''; await runJobLogSelection(source, signal(), value => { chosen = value.reference.name; }, { list: async () => page([rank(pod('z')), rank(pod('a'))]), verify: async (_selector, ref) => ref, charge: () => {} }); assert.equal(chosen, 'z');
});
test('list-RV/selector drift, repeated continuation and duplicate UID/name fail before a choice', async () => {
  for (const mode of ['rv', 'selector', 'cursor', 'duplicate']) { let pages = 0, choices = 0;
    await assert.rejects(runJobLogSelection(source, signal(), () => { choices++; }, { list: async () => { pages++; return { ...page(mode === 'duplicate' ? [rank()] : []), resourceVersion: mode === 'rv' && pages > 1 ? 'changed' : 'rv', selector: mode === 'selector' && pages > 1 ? 'changed=x' : 'app=synthetic', continuation: 'next' }; }, verify: async () => undefined, charge: () => {} })); assert.equal(choices, 0);
  }
});
test('20-page cap never silently selects a partial-snapshot winner', async () => {
  let pages = 0; await assert.rejects(runJobLogSelection(source, signal(), () => assert.fail('No partial winner'), { list: async () => ({ ...page(), candidates: [rank(pod(`pod${++pages}`))], continuation: `c${pages}` }), verify: async () => undefined, charge: () => {} }), /QUERY_LIMIT/); assert.equal(pages, 20);
});
test('zero Pods waits for the first ADDED/MODIFIED at original list RV and stops only its own read before delivery', async () => {
  for (const type of ['ADDED', 'MODIFIED']) { const selected: Omit<JobLogSelected, 'sequence'>[] = []; let aborted = false;
    await runJobLogSelection(source, signal(), value => selected.push(value), { list: async () => page([]), verify: async (_selector, reference, raw) => raw ? rank(raw as ReturnType<typeof pod>).reference : reference,
      transport: async (_selection, request, input, emit) => { assert.equal(request.query.resourceVersion, 'list-rv'); assert.equal(request.query.labelSelector, 'app=synthetic'); await emit(encode({ type, object: pod() })); aborted = input.aborted; throw new BoundaryError('QUERY_CANCELLED'); }, charge: () => {} });
    assert.equal(aborted, true); assert.equal(selected[0]?.waited, true); assert.equal(selected[0]?.candidates, 1);
  }
});
test('DELETED and BOOKMARK do not pick a Pod; opaque RV advances to the next normal watch window', async () => {
  let calls = 0, now = 0; await assert.rejects(runJobLogSelection(source, signal(), () => assert.fail('No candidate'), { list: async () => page([]), verify: async () => undefined, clock: () => now, pause: async () => {}, charge: () => {},
    transport: async (_selection, request, _signal, emit) => { if (calls) assert.equal(request.query.resourceVersion, 'bookmark'); calls++; now += 5000; await emit(encode({ type: 'DELETED', object: pod() })); await emit(encode({ type: 'BOOKMARK', object: { metadata: { resourceVersion: 'bookmark' } } })); } }), /QUERY_TIMEOUT/); assert.equal(calls, 10);
});
test('410/403/fast EOF are fixed failure, no automatic relist/auth retry/Pod creation', async () => {
  for (const mode of [410, 403, 0]) { let calls = 0, lists = 0;
    await assert.rejects(runJobLogSelection(source, signal(), () => {}, { list: async () => { lists++; return page([]); }, verify: async () => undefined, charge: () => {}, transport: async (_selection, _request, _signal, emit) => { calls++; if (mode) await emit(encode({ type: 'ERROR', object: { kind: 'Status', code: mode, message: 'SYNTHETIC_SECRET' } })); } }), mode === 410 ? /CONTINUATION_EXPIRED/ : mode === 403 ? /FORBIDDEN/ : /READ_TRANSPORT_UNAVAILABLE/);
    assert.equal(calls, 1); assert.equal(lists, 1);
  }
});
test('a chosen frame cannot mask later transport failure as intentional cancellation', async () => {
  await assert.rejects(runJobLogSelection(source, signal(), () => assert.fail('Do not publish after failure'), { list: async () => page([]), verify: async (_selector, reference, raw) => raw ? rank().reference : reference, charge: () => {}, transport: async (_selection, _request, _signal, emit) => { await emit(encode({ type: 'ADDED', object: pod() })); throw new BoundaryError('BUDGET_EXCEEDED'); } }), /BUDGET_EXCEEDED/);
});
test('final Job/Pod recheck failure prevents selection even after a valid first watch frame', async () => {
  let rawSeen = false; await assert.rejects(runJobLogSelection(source, signal(), () => assert.fail('No stale selection'), { list: async () => page([]), verify: async (_selector, reference, raw) => { if (raw) { rawSeen = true; return rank().reference; } if (reference && rawSeen) throw new BoundaryError('STALE_TARGET'); return undefined; }, charge: () => {}, transport: async (_selection, _request, _signal, emit) => { await emit(encode({ type: 'ADDED', object: pod() })); } }), /STALE_TARGET/);
});
test('parent cancellation while waiting never turns into a successful default selection', async () => {
  const parent = new AbortController(); await assert.rejects(runJobLogSelection(source, parent.signal, () => assert.fail('No cancelled result'), { list: async () => page([]), verify: async () => undefined, charge: () => {}, transport: async () => { parent.abort(); throw new BoundaryError('QUERY_CANCELLED'); } }), /QUERY_CANCELLED/);
});
test('private watch purpose requires original namespace/pods/nonempty selector/RV/five-second window, rejects widening', () => {
  const request = planJobPodWatch(source, 'app=synthetic', 'rv'), start = { protocol: 1, kind: 'read', request, snapshot: new Uint8Array([1]), path: '/synthetic/bin' };
  assert.equal(parseReadWorkerStart(start).request.purpose, 'job-pod-watch'); assert.ok(kubectlReadArguments(request, '/synthetic/fifo').includes('--request-timeout=7s'));
  for (const change of [{ path: '/api/v1/namespaces/other/pods' }, { path: '/api/v1/namespaces/default/pods/exec' }, { query: { ...request.query, labelSelector: '' } }, { query: { ...request.query, resourceVersion: '0' } }, { maximumBytes: 8_000_000 }]) assert.throws(() => parseReadWorkerStart({ ...start, request: { ...request, ...change } }));
});
function registry(budget?: ReturnType<typeof createReadTaskBudget>) {
  const runs: Array<{ emit: (value: Omit<JobLogSelected, 'sequence'>) => void; signal: AbortSignal; done: ReturnType<typeof Promise.withResolvers<void>> }> = [];
  const tasks = createReadTasks({ generation: 's', kind: 'job-log-selection', sourceSchema: jobLogSelectionSourceSchema, eventSchema: jobLogSelectedSchema, pageSchema: jobLogSelectionPageSchema, ...(budget ? { budget } : {}), run: async (_source, signal, emit) => { const done = Promise.withResolvers<void>(); runs.push({ emit, signal, done }); await done.promise; } });
  return { tasks, runs, close() { tasks.close(); for (const run of runs) run.done.resolve(); } };
}
test('Job selection shares source work and the same two unsettled stream slots with Watch/Follow', async () => {
  const budget = createReadTaskBudget(), f = registry(budget), watches = createWatchTasks({ generation: 's', budget, run: async (_source, input) => new Promise<void>(resolve => input.addEventListener('abort', () => resolve(), { once: true })) });
  try { const a = f.tasks.open(open()), b = f.tasks.open(open('b')); await tick(); assert.equal(f.runs.length, 1); assert.equal(a.handle.task, b.handle.task); f.tasks.release(control(a)); assert.equal(f.runs[0]?.signal.aborted, false);
    watches.open({ protocol: 2, recoveryPolicy: 'single-410-relist', target: source.target, selection: source.selection, resource: 'pods', resourceVersion: 'rv', consumer: { view: 'c'.repeat(32), epoch: 1 } });
    assert.throws(() => f.tasks.open(open('d', { ...source, origin: { ...source.origin, name: 'other', uid: 'other-u' } })), /QUERY_LIMIT/);
  } finally { watches.close(); f.close(); }
});
function clientFixture(transform?: (page: JobLogSelectionPage) => unknown) {
  const f = registry(), states: JobLogSelectionState[] = [], selected: JobLogSelected[] = []; let pending: (() => void) | undefined;
  const client = new JobLogSelectionClient(async request => { const input = JSON.parse(request.body) as unknown; let value: unknown;
    if (request.path.endsWith('/release')) { f.tasks.release(input); value = {}; } else { const page = request.path.endsWith('/open') ? f.tasks.open(input) : f.tasks.poll(input); value = transform ? transform(page) : page; } return { status: 200, body: JSON.stringify(value) };
  }, state => states.push(state), value => selected.push(value), 'a'.repeat(32), callback => { pending = callback; return () => { pending = undefined; }; });
  return { ...f, client, states, selected, async poll() { const callback = pending; pending = undefined; callback?.(); await tick(); }, close() { client.dispose(); f.close(); } };
}
test('client waits for completed selection before opening actual containers, never on early running choice', async () => {
  const f = clientFixture(); try { await f.client.start(source); await tick(); f.runs[0]?.emit({ origin: source.origin, reference: rank().reference, candidates: 3, waited: false }); await f.poll(); assert.equal(f.selected.length, 0);
    f.runs[0]?.done.resolve(); await tick(); await f.poll(); assert.equal(f.selected.length, 1); assert.equal(f.states.at(-1)?.phase, 'completed'); assert.equal(f.selected[0]?.candidates, 3);
  } finally { f.close(); }
});
test('Stop while waiting releases only its consumer and prevents late completion or container handoff', async () => {
  const f = clientFixture(); try { await f.client.start(source); await tick(); f.client.stop(); f.runs[0]?.done.resolve(); await tick(); await f.poll(); assert.equal(f.selected.length, 0); assert.equal(f.runs[0]?.signal.aborted, true); assert.equal(f.states.at(-1)?.error, 'QUERY_CANCELLED'); } finally { f.close(); }
});
test('forged cross-source/foreign namespace/lost/missing choice cannot hand off to log reads', async () => {
  for (const mode of ['source', 'namespace', 'lost', 'missing']) { const f = clientFixture(page => mode === 'source' ? { ...page, source: { ...page.source, origin: { ...page.source.origin, uid: 'other' } } } : mode === 'namespace' ? { ...page, phase: 'completed', next: 1, head: 1, events: [{ sequence: 1, origin: source.origin, reference: { ...rank().reference, namespace: 'other' }, candidates: 1, waited: true }] } : mode === 'lost' ? { ...page, lost: true } : { ...page, phase: 'completed' });
    try { await f.client.start(source); assert.equal(f.selected.length, 0); assert.equal(f.states.at(-1)?.phase, 'error'); } finally { f.close(); }
  }
});
test('late open after reset releases old consumer without resurrecting source or choosing a Pod', async () => {
  const f = registry(), page = f.tasks.open(open()), deferred = Promise.withResolvers<{ status: number; body: string }>(); let releases = 0, selections = 0;
  const client = new JobLogSelectionClient(async request => { if (request.path.endsWith('/release')) { releases++; f.tasks.release(JSON.parse(request.body) as unknown); return { status: 200, body: '{}' }; } return deferred.promise; }, () => {}, () => { selections++; }, 'a'.repeat(32));
  const pending = client.start(source); client.reset(); deferred.resolve({ status: 200, body: JSON.stringify(page) }); await pending; await tick(); assert.equal(releases, 1); assert.equal(selections, 0); client.dispose(); f.close();
});
test('client actual unsettled requests stay charged through rapid resets', async () => {
  const deferred = Promise.withResolvers<{ status: number; body: string }>(); let calls = 0; const states: JobLogSelectionState[] = [];
  const client = new JobLogSelectionClient(async () => { calls++; return deferred.promise; }, state => states.push(state), () => {}, 'a'.repeat(32)); const pending = Array.from({ length: 5 }, () => client.start(source)); await tick(); assert.equal(calls, 4); assert.equal(states.at(-1)?.error, 'QUERY_LIMIT'); deferred.resolve({ status: 400, body: '{"error":{"code":"QUERY_CANCELLED"}}' }); await Promise.all(pending); client.dispose();
});
async function gatewayFixture(empty = false) {
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), value = { ...source, target: { ...source.target, configIdentity: snapshot.snapshot.configIdentity } }; let calls = 0; const currentJob = job(), currentPod = pod();
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => { const data = request.purpose === 'resource-list' ? { apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: 'rv' }, items: empty ? [] : [currentPod] } : request.path.endsWith('/job') ? currentJob : currentPod;
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(data)); } }, close: async () => {} };
  }, watch: async (_selection, request, _signal, emit) => { calls++; assert.equal(request.purpose, 'job-pod-watch'); currentJob.metadata.resourceVersion = 'j2'; await emit(encode({ type: 'ADDED', object: currentPod })); throw new BoundaryError('QUERY_CANCELLED'); } });
  return { gateway, value, currentJob, currentPod, calls: () => calls };
}
test('gateway completes a real bounded candidate GET chain and only metadata DTO crosses public task boundary', async () => {
  const f = await gatewayFixture(); try { const first = await f.gateway.openJobLogSelection(open('a', f.value), signal()); let state = first;
    for (let n = 0; n < 100 && state.phase !== 'completed'; n++) { await tick(); state = await f.gateway.pollJobLogSelection(control(first), signal()); }
    assert.equal(state.phase, 'completed'); assert.equal(state.events[0]?.reference.name, 'pod'); assert.equal(f.calls(), 0); const serialized = JSON.stringify(state); for (const secret of ['SYNTHETIC_SECRET', 'restartCount', 'app=synthetic', 'annotations', 'containers']) assert.equal(serialized.includes(secret), false);
  } finally { f.gateway.close(); }
});
test('gateway zero-Pod path uses real stream and rechecks original Job/Pod before completing', async () => {
  const f = await gatewayFixture(true); try { const first = await f.gateway.openJobLogSelection(open('a', f.value), signal()); let state = first;
    for (let n = 0; n < 150 && state.phase !== 'completed'; n++) { await tick(); state = await f.gateway.pollJobLogSelection(control(first), signal()); }
    assert.equal(state.phase, 'completed'); assert.equal(state.events[0]?.waited, true); assert.equal(state.events[0]?.origin.resourceVersion, 'j2'); assert.equal(f.calls(), 1);
  } finally { f.gateway.close(); }
});
test('gateway Job replacement rejects old source instead of waiting on a replacement selector', async () => {
  const f = await gatewayFixture(); f.currentJob.metadata.uid = 'new-u'; try { const first = await f.gateway.openJobLogSelection(open('a', f.value), signal()); let state = first;
    for (let n = 0; n < 100 && state.phase !== 'error'; n++) { await tick(); state = await f.gateway.pollJobLogSelection(control(first), signal()); }
    assert.equal(state.error, 'STALE_TARGET'); assert.equal(f.calls(), 0);
  } finally { f.gateway.close(); }
});
test('first Job read still requires exact original RV before subsequent same-UID RV progression is admitted', async () => {
  const f = await gatewayFixture(); f.currentJob.metadata.resourceVersion = 'j2'; try { const first = await f.gateway.openJobLogSelection(open('a', f.value), signal()); let state = first;
    for (let n = 0; n < 100 && state.phase !== 'error'; n++) { await tick(); state = await f.gateway.pollJobLogSelection(control(first), signal()); }
    assert.equal(state.error, 'STALE_TARGET'); assert.equal(f.calls(), 0);
  } finally { f.gateway.close(); }
});
test('aggregate Job selection budget charges initial lists and every metadata check, not just watch bytes', async () => {
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), value = { ...source, target: { ...source.target, configIdentity: snapshot.snapshot.configIdentity } }; let reads = 0;
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => { reads++; const data = request.purpose === 'resource-list' ? { apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: 'rv' }, items: [pod()] } : request.path.endsWith('/job') ? job() : pod();
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ ...data, padding: 'x'.repeat(1_900_000) })); } }, close: async () => {} };
  } });
  try { const first = await gateway.openJobLogSelection(open('a', value), signal()); let state = first; for (let n = 0; n < 150 && state.phase !== 'error'; n++) { await tick(); state = await gateway.pollJobLogSelection(control(first), signal()); }
    assert.equal(state.error, 'BUDGET_EXCEEDED'); assert.equal(state.events.length, 0); assert.equal(reads, 5);
  } finally { gateway.close(); }
});
test('Job selector mutation with the same declared UID/RV during initial list cannot publish the old candidate', async () => {
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), value = { ...source, target: { ...source.target, configIdentity: snapshot.snapshot.configIdentity } }; let listed = false;
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => { const current = job(); if (listed) current.spec.selector.matchLabels.app = 'changed';
    const data = request.purpose === 'resource-list' ? { apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: 'rv' }, items: [pod()] } : current; if (request.purpose === 'resource-list') listed = true;
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(data)); } }, close: async () => {} };
  } });
  try { const first = await gateway.openJobLogSelection(open('a', value), signal()); let state = first; for (let n = 0; n < 150 && state.phase !== 'error'; n++) { await tick(); state = await gateway.pollJobLogSelection(control(first), signal()); }
    assert.equal(state.error, 'STALE_TARGET'); assert.equal(state.events.length, 0);
  } finally { gateway.close(); }
});
