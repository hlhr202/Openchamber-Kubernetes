// Independent synthetic metadata/GET/byte-stream responses and pure worker protocols only; no real SDK/CLI/worker/cache or write/session imports.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { customWatchReferenceSchema, watchSourceSchema } from '../../src/shared/watch-protocol.ts';
import type { WatchEvent, WatchSource } from '../../src/shared/watch-protocol.ts';
import { planResourceWatch, projectWatchEvent, createWatchDecoder } from '../../src/service/queries/watch-source.ts';
import { planWatchRelist, projectWatchRelist } from '../../src/service/queries/watch-relist.ts';
import { readCustomWatchProof } from '../../src/service/queries/custom-watch.ts';
import { runResourceWatch } from '../../src/service/queries/watch-runner.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { parseReadWorkerStart } from '../../src/service/queries/read-worker-protocol.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import { createResourceReader } from '../../src/service/queries/resource-reader.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { BranchClient } from '../../src/host/branch-client.ts';
import type { BranchState } from '../../src/host/branch-client.ts';
import { stableNodeId } from '../../src/shared/identity.ts';
import { treeQueryAffectedByWatch } from '../../src/shared/tree-watch.ts';

const signal = () => new AbortController().signal, marker = 'SYNTHETIC_PRIVATE_VALUE';
const target = { serviceGeneration: 's', projectId: 'p', configIdentity: 'cfg', context: 'active', namespace: 'default' };
const type = { group: 'example.com', version: 'v2', resource: 'widgets', kind: 'Widget', scope: 'namespace' as const }, definition = { name: 'widgets.example.com', uid: 'd', resourceVersion: 'd1' };
const custom = { type, definition, listKind: 'WidgetCollection' };
const source: WatchSource = { protocol: 2, target, selection: { mode: 'default' }, recoveryPolicy: 'single-410-relist', resource: 'custom-resource', resourceVersion: 'original-list-rv', custom };
const raw = (rv = 'r2') => ({ type: 'MODIFIED', object: { apiVersion: 'example.com/v2', kind: 'Widget', metadata: { name: 'sample', namespace: 'default', uid: 'u', resourceVersion: rv, annotations: { token: marker } }, spec: { secret: marker }, data: { private: marker } } });
const crd = () => ({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { ...definition }, spec: { group: 'example.com', scope: 'Namespaced', names: { plural: 'widgets', kind: 'Widget', listKind: custom.listKind }, versions: [{ name: 'v1', storage: true, served: true }, { name: 'v2', storage: false, served: true }] } });
const discovery = () => ({ groupVersion: 'example.com/v2', resources: [{ name: 'widgets', kind: 'Widget', namespaced: true, verbs: ['get', 'list', 'watch'] }] });
function fixture() {
  let def = crd(), disc = discovery(), object = raw('r1').object, padding = 0, code = 200, errorIterated = false;
  const reads: ResourceReadRequest[] = []; let before: ((input: ResourceReadRequest) => void) | undefined;
  const read = async (input: ResourceReadRequest) => {
    kubectlReadArguments(input, '/synthetic/config.pipe'); reads.push(input); before?.(input);
    const value = input.purpose === 'api-version' ? disc : input.purpose === 'custom-document' ? object : def;
    return { status: code, body: { async *[Symbol.asyncIterator]() { if (code !== 200) errorIterated = true; yield Buffer.from(JSON.stringify(value).padEnd(padding)); } }, close: async () => {} };
  };
  const verify = async (_target: typeof target, sig: AbortSignal) => { if (sig.aborted) throw new BoundaryError('QUERY_CANCELLED'); };
  return { read, verify, reads, definition: () => def, discovery: () => disc, object: () => object,
    setDefinition(value: typeof def) { def = value; }, setDiscovery(value: typeof disc) { disc = value; }, setObject(value: typeof object) { object = value; }, before(callback: typeof before) { before = callback; }, pad(value: number) { padding = value; }, fail(value: number) { code = value; }, errorIterated: () => errorIterated,
    proof: (input = source, budget = { bytes: 0, reads: 0 }, initial = false, sig = signal()) => readCustomWatchProof(input, sig, read, verify, budget, initial) };
}
test('custom Watch requires explicit strict definition/type/listKind metadata and never follows a bare arbitrary resource', () => { assert.ok(watchSourceSchema.safeParse(source).success); for (const change of [{ custom: undefined }, { custom: { ...custom, definition: { ...definition, name: 'other.example.com' } } }, { custom: { ...custom, body: marker } }, { path: '/arbitrary' }, { resource: 'widgets' }, { resource: 'pods' }]) assert.equal(watchSourceSchema.safeParse({ ...source, ...change }).success, false); assert.equal(customWatchReferenceSchema.safeParse({ ...custom, type: { ...type, group: '', version: 'v1', resource: 'pods', kind: 'Pod' } }).success, false); });
test('exact non-storage served GVR plans a separate watch purpose, metadata name selector and ordinary two-MB private budget', () => { const plan = planResourceWatch({ ...source, object: { name: 'sample', uid: 'u' } }); assert.equal(plan.purpose, 'custom-resource-watch'); assert.equal(plan.path, '/apis/example.com/v2/namespaces/default/widgets'); assert.equal(plan.maximumBytes, 2_000_000); assert.deepEqual(plan.customWatch, custom); assert.equal(plan.query.fieldSelector, 'metadata.name=sample'); assert.ok(kubectlReadArguments(plan, '/synthetic/pipe').includes('--request-timeout=7s')); });
test('cluster-scoped custom Watch uses no namespace path and does not change the browsing target namespace', () => { const plan = planResourceWatch({ ...source, custom: { ...custom, type: { ...type, scope: 'cluster' } } }); assert.equal(plan.path, '/apis/example.com/v2/widgets'); assert.equal(plan.target.namespace, 'default'); });
test('private custom watch/relist purposes reject arbitrary paths/query/oversized budgets and cannot leak their metadata to builtin purposes', () => { const request = planResourceWatch(source), start = { protocol: 1, kind: 'read', request, snapshot: new Uint8Array([1]), path: '/synthetic/bin' }; assert.equal(parseReadWorkerStart(start).request.purpose, 'custom-resource-watch'); for (const change of [{ customWatch: undefined }, { purpose: 'resource-watch' }, { purpose: 'resource-list' }, { path: '/apis/example.com/v1/namespaces/default/widgets' }, { maximumBytes: 8_000_000 }, { query: { ...request.query, timeoutSeconds: '60' } }, { query: { ...request.query, fieldSelector: 'metadata.name=sample,extra=x' } }, { query: { ...request.query, labelSelector: 'anything' } }]) assert.throws(() => parseReadWorkerStart({ ...start, request: { ...request, ...change } }), /INVALID_INPUT/); });
test('custom relist keeps exact GVR and custom listKind with no old watch RV or version fallback', () => { const plan = planWatchRelist(source, 'next'); assert.equal(plan.purpose, 'custom-resource-relist'); assert.deepEqual(plan.query, { limit: '100', continue: 'next' }); kubectlReadArguments(plan, '/synthetic/pipe'); const value = { apiVersion: 'example.com/v2', kind: custom.listKind, metadata: { resourceVersion: 'new-list-rv' }, items: [raw().object] }; assert.equal(projectWatchRelist(value, source).resourceVersion, 'new-list-rv'); assert.throws(() => projectWatchRelist({ ...value, kind: 'WidgetList' }, source), /RESOURCE_INVALID/); });
test('custom raw relist items can omit TypeMeta, but conflicting types and wrong object identities remain invalid', () => {
  const item = { metadata: raw().object.metadata };
  const value = { apiVersion: 'example.com/v2', kind: custom.listKind, metadata: { resourceVersion: 'new-list-rv' }, items: [item] };
  assert.deepEqual(projectWatchRelist(value, source).identities, [{ name: 'sample', uid: 'u' }]);
  assert.throws(() => projectWatchRelist({ ...value, items: [{ ...item, kind: 'Other' }] }, source), /RESOURCE_INVALID/);
  assert.throws(() => projectWatchRelist({ ...value, items: [{ ...item, apiVersion: 'example.com/v1' }] }, source), /RESOURCE_INVALID/);
  assert.throws(() => projectWatchRelist(value, { ...source, object: { name: 'sample', uid: 'replacement' } }), /STALE_TARGET/);
  assert.throws(() => projectWatchEvent({ type: 'MODIFIED', object: item }, source), /RESOURCE_INVALID/);
});
test('custom event metadata strips body/annotations/Secret values, including split UTF-8 frames', () => { const events: unknown[] = [], decoder = createWatchDecoder(source, event => events.push(event)); const bytes = Buffer.from(JSON.stringify(raw('版本2')) + '\n'); for (const byte of bytes) decoder.push(new Uint8Array([byte])); decoder.finish(); assert.equal(events.length, 1); assert.equal(JSON.stringify(events).includes(marker), false); assert.deepEqual(events[0], { type: 'MODIFIED', resourceVersion: '版本2', name: 'sample', uid: 'u' }); });
test('wrong custom GVK/scope or same-name replacement UID never becomes a matching object Watch event', () => { const event = raw(); for (const object of [{ ...event.object, kind: 'Other' }, { ...event.object, apiVersion: 'example.com/v1' }, { ...event.object, metadata: { ...event.object.metadata, namespace: 'other' } }]) assert.throws(() => projectWatchEvent({ ...event, object }, source)); assert.throws(() => projectWatchEvent(event, { ...source, object: { name: 'sample', uid: 'replacement' } }), /STALE_TARGET/); });
test('directory proof reads only original CRD and exact discovery, without fetching any instance body', async () => { const f = fixture(); assert.ok(await f.proof()); assert.deepEqual(f.reads.map(read => read.purpose), ['resource-object', 'api-version']); assert.ok(f.reads.every(read => !read.path.includes('/namespaces/'))); });
test('custom Watch requires both list and watch on the selected discovery resource, never another entry or subresource', async () => {
  for (const verbs of [['get', 'list'], ['get', 'watch'], []]) {
    const f = fixture(), disc = f.discovery(), entry = disc.resources[0]; assert.ok(entry); entry.verbs = verbs;
    disc.resources.push({ ...entry, name: 'widgets/status', verbs: ['get', 'list', 'watch'] }, { ...entry, name: 'others', verbs: ['get', 'list', 'watch'] });
    f.setDiscovery(disc); await assert.rejects(f.proof(), /STALE_TARGET/); assert.equal(f.reads.length, 2);
  }
});
test('losing discovery watch support between proof windows is terminal without resetting the shared proof budget', async () => {
  const f = fixture(), budget = { bytes: 0, reads: 0 }; await f.proof(source, budget);
  const disc = f.discovery(), entry = disc.resources[0]; assert.ok(entry); entry.verbs = ['get', 'list']; f.setDiscovery(disc);
  await assert.rejects(f.proof(source, budget), /STALE_TARGET/); assert.equal(budget.reads, 4);
});
test('initial object proof brackets one exact UID/RV instance GET with matching original definition/discovery proofs', async () => { const f = fixture(); await f.proof({ ...source, object: { name: 'sample', uid: 'u' }, resourceVersion: 'r1' }, { bytes: 0, reads: 0 }, true); assert.deepEqual(f.reads.map(read => read.purpose), ['resource-object', 'api-version', 'custom-document', 'resource-object', 'api-version']); });
test('later object proofs do not demand the original instance RV or fetch changing instance bodies', async () => { const f = fixture(); await f.proof({ ...source, object: { name: 'sample', uid: 'u' }, resourceVersion: 'r1' }, { bytes: 0, reads: 0 }, false); assert.equal(f.reads.length, 2); assert.ok(!f.reads.some(read => read.purpose === 'custom-document')); });
test('wrong definition UID/RV/served version/listKind or discovery scope stops custom proof', async () => { for (const mode of ['uid', 'rv', 'served', 'listKind', 'scope']) { const f = fixture(), def = f.definition(); if (mode === 'uid') def.metadata.uid = 'replacement'; if (mode === 'rv') def.metadata.resourceVersion = 'd2'; if (mode === 'served') { const v = def.spec.versions[1]; assert.ok(v); v.served = false; } if (mode === 'listKind') def.spec.names.listKind = 'Different'; if (mode === 'scope') { const disc = f.discovery(), entry = disc.resources[0]; assert.ok(entry); entry.namespaced = false; f.setDiscovery(disc); } f.setDefinition(def); await assert.rejects(f.proof(), /STALE_TARGET/); } });
test('initial instance same-name UID/RV replacement is rejected rather than silently observing the new object', async () => { for (const field of ['uid', 'resourceVersion'] as const) { const f = fixture(), object = f.object(); object.metadata[field] = 'changed'; f.setObject(object); await assert.rejects(f.proof({ ...source, object: { name: 'sample', uid: 'u' }, resourceVersion: 'r1' }, { bytes: 0, reads: 0 }, true), /STALE_TARGET/); } });
test('definition change during the initial instance read invalidates the complete initial proof', async () => { const f = fixture(); f.before(request => { if (request.purpose === 'custom-document') { const def = f.definition(); def.metadata.resourceVersion = 'changed'; f.setDefinition(def); } }); await assert.rejects(f.proof({ ...source, object: { name: 'sample', uid: 'u' }, resourceVersion: 'r1' }, { bytes: 0, reads: 0 }, true), /STALE_TARGET/); });
test('proof cumulative GET/8MB and per-response 2MB budgets fail whole without starting excess reads', async () => { const f = fixture(); await assert.rejects(f.proof(source, { bytes: 0, reads: 255 }), /BUDGET_EXCEEDED/); assert.equal(f.reads.length, 1); const g = fixture(); await assert.rejects(g.proof(source, { bytes: 7_999_999, reads: 0 }), /BUDGET_EXCEEDED/); const h = fixture(); h.pad(2_000_001); await assert.rejects(h.proof(), /BUDGET_EXCEEDED/); });
test('permission/notfound/throttle proof errors never iterate original error bodies or retry authentication', async () => { for (const [status, error] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [429, 'QUERY_LIMIT']] as const) { const f = fixture(); f.fail(status); await assert.rejects(f.proof(), new RegExp(error)); assert.equal(f.errorIterated(), false); assert.equal(f.reads.length, 1); } });
test('already cancelled proof cannot start metadata transports and carries no business cleanup', async () => { const f = fixture(); await assert.rejects(f.proof(source, { bytes: 0, reads: 0 }, false, AbortSignal.abort()), /QUERY_CANCELLED/); assert.equal(f.reads.length, 0); });
test('custom runner performs one 410 same-GVR relist and resumes the fresh RV without resetting original proof budget', async () => { const f = fixture(), controller = new AbortController(), events: Omit<WatchEvent, 'sequence'>[] = [], proofBudget = { bytes: 0, reads: 0 }; let calls = 0, relists = 0; await assert.rejects(runResourceWatch(source, controller.signal, event => events.push(event), { pause: async () => {}, verify: value => f.proof(value, proofBudget).then(() => {}), relist: async value => { relists++; assert.deepEqual(value.custom, custom); return 'fresh-rv'; }, transport: async (_selection, request, _signal, emit) => { if (++calls === 1) throw new BoundaryError('CONTINUATION_EXPIRED'); assert.equal(request.query.resourceVersion, 'fresh-rv'); await emit(Buffer.from(JSON.stringify(raw('fresh-next')) + '\n')); controller.abort(); } }), /QUERY_CANCELLED/); assert.equal(relists, 1); assert.deepEqual(events.map(event => event.type), ['RELISTING', 'RESYNC', 'MODIFIED']); assert.ok(proofBudget.reads > 4 && proofBudget.bytes > 0); });
test('custom runner second 410 is terminal and does not reselect a definition or recover twice', async () => { let relists = 0; await assert.rejects(runResourceWatch(source, signal(), () => {}, { pause: async () => {}, verify: async () => {}, relist: async () => { relists++; return 'new-rv'; }, transport: async () => { throw new BoundaryError('CONTINUATION_EXPIRED'); } }), /CONTINUATION_EXPIRED/); assert.equal(relists, 1); });
test('definition drift before a chunk prevents all new event publication', async () => { const f = fixture(), events: unknown[] = []; await assert.rejects(runResourceWatch(source, signal(), event => events.push(event), { verify: value => f.proof(value).then(() => {}), transport: async (_selection, _request, _signal, emit) => { const def = f.definition(); def.metadata.resourceVersion = 'changed'; f.setDefinition(def); await emit(Buffer.from(JSON.stringify(raw()) + '\n')); } }), /STALE_TARGET/); assert.deepEqual(events, []); });
test('custom Watch invalidates only same-target same-definition custom list queries, not builtin or another CRD', () => { const query = { kind: 'custom-resources' as const, target, definition }; assert.equal(treeQueryAffectedByWatch(query, source), true); assert.equal(treeQueryAffectedByWatch({ ...query, definition: { ...definition, uid: 'other' } }, source), false); assert.equal(treeQueryAffectedByWatch({ ...query, target: { ...target, namespace: 'other' } }, source), false); assert.equal(treeQueryAffectedByWatch({ kind: 'resources', target, resource: 'pods' }, source), false); });
test('branch Watch staleness rejects late metadata and disables continuation without altering the original definition or body', async () => { const states: BranchState[] = [], request = { protocol: 2, target, selection: { mode: 'default' }, kind: 'custom-resources', definition }, page = { protocol: 2, kind: 'custom-resources', target, definition, resourceType: type, listKind: custom.listKind, resourceVersion: 'rv', nextCursor: 'next', nodes: [{ id: stableNodeId(target, type.group, type.version, type.resource, 'default', 'sample', 'u'), type: 'resource', label: 'sample', children: 'none', expandable: false, resource: { ...type, name: 'sample', namespace: 'default', uid: 'u', resourceVersion: 'r1' } }] }; let calls = 0; const client = new BranchClient(async () => { calls++; return { status: 200, body: JSON.stringify(page) }; }, state => states.push(state)); await client.read(request); assert.equal(states.at(-1)?.phase, 'ready'); client.invalidateCustomWatch({ ...target, namespace: 'other' }, definition); assert.equal(states.at(-1)?.stale, false); client.invalidateCustomWatch(target, definition); assert.equal(states.at(-1)?.stale, true); await client.next(); assert.equal(calls, 1); const last = states.at(-1)?.page; assert.ok(last?.kind === 'custom-resources'); assert.deepEqual(last.definition, definition); client.dispose(); });
test('real gateway synthetic custom Watch takes the original finite metadata pool and emits only pinned source metadata', { timeout: 5000 }, async () => {
  const f = fixture(), sent = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), value = { ...source, target: { ...target, configIdentity: snapshot.snapshot.configIdentity } };
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => f.read(request), watch: async (_selection, request, sig, emit) => {
    try { assert.equal(request.purpose, 'custom-resource-watch'); kubectlReadArguments(request, '/synthetic/pipe'); await emit(Buffer.from(JSON.stringify(raw()) + '\n'));
      const cancelled = new Promise<void>((_resolve, reject) => { if (sig.aborted) reject(new BoundaryError('QUERY_CANCELLED')); else sig.addEventListener('abort', () => reject(new BoundaryError('QUERY_CANCELLED')), { once: true }); }); sent.resolve(); await cancelled;
    } finally { finished.resolve(); }
  } });
  try { const page = await gateway.openWatch({ ...value, consumer: { view: 'a'.repeat(32), epoch: 1 } }, signal()); await sent.promise; const result = await gateway.pollWatch({ protocol: 2, handle: page.handle, after: 0 }, signal()); assert.deepEqual(result.source.custom, custom); assert.equal(result.events[0]?.name, 'sample'); assert.equal(JSON.stringify(result).includes(marker), false); assert.ok(f.reads.length >= 4); gateway.releaseWatch({ protocol: 2, handle: page.handle, after: result.next }); await finished.promise; } finally { gateway.close(); }
});
test('custom relist completes real finite-reader pagination with original listKind and exact object UID, returning only new List RV', async () => {
  const requests: ResourceReadRequest[] = [], budget = { bytes: 0, reads: 1 };
  const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => target, read: async request => {
    requests.push(request); kubectlReadArguments(request, '/synthetic/pipe');
    assert.equal(request.purpose, 'custom-resource-relist'); assert.deepEqual(request.customWatch, custom);
    assert.equal(request.query.fieldSelector, 'metadata.name=sample');
    assert.equal(request.query.resourceVersion, undefined); assert.equal(request.query.watch, undefined);
    const next = request.query.continue;
    assert.equal(next, requests.length === 1 ? undefined : 'next');
    const text = JSON.stringify({ apiVersion: 'example.com/v2', kind: custom.listKind, metadata: { resourceVersion: 'new-list', ...(next ? {} : { continue: 'next' }) }, items: next ? [{ metadata: raw().object.metadata }] : [] });
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(text); } }, close: async () => {} };
  } });
  try { assert.equal(await reader.watchRelist({ ...source, object: { name: 'sample', uid: 'u' } }, signal(), budget), 'new-list'); assert.equal(requests.length, 2); assert.equal(budget.reads, 3); assert.ok(budget.bytes > 0); } finally { reader.close(); }
});
test('finite custom relist rejects empty/replaced object and changed List RV without trying another GVR', async () => {
  for (const mode of ['empty', 'replaced', 'changed-rv']) {
    let calls = 0;
    const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => target, read: async request => {
      calls++; assert.equal(request.path, '/apis/example.com/v2/namespaces/default/widgets');
      const text = JSON.stringify({ apiVersion: 'example.com/v2', kind: custom.listKind, metadata: { resourceVersion: calls === 2 ? 'changed' : 'r', ...(mode === 'changed-rv' && calls === 1 ? { continue: 'next' } : {}) },
        items: mode === 'empty' || mode === 'changed-rv' && calls === 1 ? [] : [{ ...raw().object, metadata: { ...raw().object.metadata, uid: mode === 'replaced' ? 'replacement' : 'u' } }] });
      return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(text); } }, close: async () => {} };
    } });
    try { await assert.rejects(reader.watchRelist({ ...source, object: { name: 'sample', uid: 'u' } }, signal(), { bytes: 0, reads: 1 }), mode === 'empty' ? /NOT_FOUND/ : /STALE_TARGET/); assert.equal(calls, mode === 'changed-rv' ? 2 : 1); } finally { reader.close(); }
  }
});
test('custom proofs and existing definition reads share the same two finite slots, including actual unsettled transports', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), f = fixture(); let calls = 0, active = 0, peak = 0;
  const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => target, read: async request => {
    calls++; active++; peak = Math.max(peak, active); if (calls === 2) entered.resolve();
    try { await release.promise; return await f.read(request); } finally { active--; }
  } });
  const first = reader.verifyCustomWatch(source, signal(), { bytes: 0, reads: 0 }, false), second = reader.verifyCustomWatch(source, signal(), { bytes: 0, reads: 0 }, false);
  const third = reader.definition({ target, definition }, signal());
  try { await entered.promise; assert.equal(calls, 2); assert.equal(active, 2); release.resolve(); await Promise.all([first, second, third]); assert.equal(peak, 2); assert.equal(calls, 5); } finally { release.resolve(); reader.close(); }
});
test('custom invalidation during pending branch continuation rejects its late response and keeps the old page stale', async () => {
  const states: BranchState[] = [], pending = Promise.withResolvers<{ status: number; body: string }>(); let calls = 0;
  const page = { protocol: 2, kind: 'custom-resources', target, definition, resourceType: type, listKind: custom.listKind, resourceVersion: 'rv', nextCursor: 'next', nodes: [] };
  const client = new BranchClient(async () => ++calls === 1 ? { status: 200, body: JSON.stringify(page) } : pending.promise, state => states.push(state));
  await client.read({ protocol: 2, target, selection: { mode: 'default' }, kind: 'custom-resources', definition });
  const next = client.next(); assert.equal(calls, 2); assert.equal(states.at(-1)?.phase, 'loading'); client.invalidateCustomWatch(target, definition);
  const count = states.length; pending.resolve({ status: 200, body: JSON.stringify({ ...page, nextCursor: null }) }); await next;
  assert.equal(states.length, count); assert.equal(states.at(-1)?.stale, true); await client.next(); assert.equal(calls, 2); client.dispose();
});
