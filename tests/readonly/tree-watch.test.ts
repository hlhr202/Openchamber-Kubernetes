// Synthetic projected read DTOs and detached tree state only; no DOM/SDK/CLI/auth/cache or operations/sessions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TreeController } from '../../src/host/tree-controller.ts';
import { TreeRefreshQueue } from '../../src/host/tree-refresh-queue.ts';
import type { TreeRefreshResult, TreeRefreshSchedule } from '../../src/host/tree-refresh-queue.ts';
import { treeQueryAffectedByWatch, sameTreeQueryIdentity } from '../../src/shared/tree-watch.ts';
import type { TreeQuery } from '../../src/shared/tree-entries.ts';
import type { WatchPage, WatchSource } from '../../src/shared/watch-protocol.ts';
import { resourceDescriptors } from '../../src/shared/tree.ts';
import { resourceReadRequestSchema } from '../../src/shared/resource-protocol.ts';
import { branchReadRequestSchema } from '../../src/shared/branch-protocol.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { projectConfigPage } from '../../src/service/queries/config-page.ts';
import { projectResource, projectPodInformation } from '../../src/service/queries/tree-projection.ts';
const target = { serviceGeneration: 's', projectId: 'view', configIdentity: 'c', context: 'active', namespace: 'default' };
const source: WatchSource = { protocol: 2, recoveryPolicy: 'single-410-relist', target, selection: { mode: 'default' }, resource: 'pods', resourceVersion: 'list-rv' };
const ready: TreeRefreshResult = { phase: 'ready', children: [] };
const settle = async () => { for (let i = 0; i < 500; i++) await Promise.resolve(); };
function scheduling() {
  const callbacks = new Map<number, () => void>(); let serial = 0, scheduled = 0;
  const schedule: TreeRefreshSchedule = callback => { const id = ++serial; scheduled++; callbacks.set(id, callback); return () => { callbacks.delete(id); }; };
  return { schedule, get count() { return callbacks.size; }, get scheduled() { return scheduled; }, flush() { const batch = [...callbacks.values()]; callbacks.clear(); for (const callback of batch) callback(); } };
}
function watch(input: WatchSource = source, lost = false, type: 'MODIFIED' | 'BOOKMARK' | 'RELISTING' | 'RESYNC' = 'MODIFIED'): WatchPage {
  return { protocol: 2, kind: 'resource-watch', source: input, handle: { generation: input.target.serviceGeneration, task: '00000000-0000-4000-8000-000000000001', consumer: '00000000-0000-4000-8000-000000000002', token: 'a'.repeat(64), epoch: 1 },
    phase: 'running', expiresAt: 60_000, leaseUntil: 15_000, first: lost ? 5 : 1, next: lost ? 5 : 1, head: lost ? 5 : 1, lost,
    events: [{ sequence: lost ? 5 : 1, type, resourceVersion: 'next-rv', ...(type === 'MODIFIED' ? { name: 'child', uid: 'pod-u' } : {}) }] };
}
async function fixture() {
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const read = await config.read({ mode: 'default' }), page = projectConfigPage(read, 's', { offset: 0, limit: 100 }), timers = scheduling();
  const actualTarget = { ...target, configIdentity: page.configIdentity }, requests: Array<{ resource?: string; kind?: string; parent?: { resource: string; resourceVersion: string }; cursor?: string | undefined }> = [];
  let uid = 'pod-u', rv = 'p1', ip = '10.0.0.1', failed = false, cursor: string | null = null, hold: (() => Promise<void>) | undefined;
  const pod = () => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'child', namespace: 'default', uid, resourceVersion: rv }, status: { phase: 'Running', podIP: ip } });
  const tree = new TreeController(async request => {
    const input: unknown = JSON.parse(request.body), binding = request.path === '/v2/resources/read' ? resourceReadRequestSchema.parse(input) : branchReadRequestSchema.parse(input);
    requests.push(binding);
    const paused = hold; await paused?.();
    if (failed) return { status: 403, body: JSON.stringify({ error: { code: 'FORBIDDEN' } }) };
    if ('resource' in binding) {
      const descriptor = Object.entries(resourceDescriptors).find(([key]) => key === binding.resource)?.[1]; assert.ok(descriptor);
      const node = binding.resource === 'pods' ? projectResource(pod(), descriptor, actualTarget) : projectResource({ metadata: { name: 'sample', uid: 'parent-u', resourceVersion: 'parent-rv', ...(descriptor.scope === 'namespace' ? { namespace: 'default' } : {}) } }, descriptor, actualTarget);
      return { status: 200, body: JSON.stringify({ protocol: 2, target: binding.target, resource: binding.resource, nodes: [node], resourceVersion: 'list-rv', nextCursor: cursor }) };
    }
    assert.equal(binding.kind, 'children'); if (binding.kind !== 'children') assert.fail('Only synthetic child query');
    const parent = binding.parent, descriptor = resourceDescriptors[parent.resource];
    const parentNode = projectResource(parent.resource === 'pods' ? pod() : { metadata: { ...parent } }, descriptor, actualTarget);
    const nodes = parent.resource === 'pods' ? projectPodInformation(pod(), parentNode) : [projectResource(pod(), resourceDescriptors.pods, actualTarget)];
    return { status: 200, body: JSON.stringify({ protocol: 2, target: actualTarget, kind: 'children', parent, nodes, resourceVersion: parent.resource === 'pods' ? parent.resourceVersion : 'list-rv', nextCursor: null }) };
  }, () => {}, timers.schedule);
  tree.configure(page, { mode: 'default' }, 'view');
  const row = (label: string, parent?: string) => { const value = tree.snapshot.rows.find(row => row.entry.node.label === label && (parent === undefined || row.parent === parent)); assert.ok(value, label); return value; };
  const open = async (...labels: string[]) => { let parent: string | undefined; for (const label of labels) { parent = row(label, parent).id; await tree.expand(parent); } };
  const observe = (change: Partial<WatchSource> = {}, lost = false, type: 'MODIFIED' | 'BOOKMARK' | 'RELISTING' | 'RESYNC' = 'MODIFIED') => tree.observeWatch(watch({ ...source, target: actualTarget, ...change }, lost, type));
  const flush = async () => { timers.flush(); await settle(); };
  return { tree, page, timers, requests, row, open, observe, flush, target: actualTarget,
    change(nextRv: string, nextUid = uid, nextIp = ip) { rv = nextRv; uid = nextUid; ip = nextIp; }, fail(value: boolean) { failed = value; },
    hold(value: typeof hold) { hold = value; }, cursor(value: string | null) { cursor = value; }, close() { tree.dispose(); } };
}
test('watch matching uses full target plus fixed resource, never context/kind/name shortcuts', () => {
  const query: TreeQuery = { kind: 'resources', target, resource: 'pods' }; assert.equal(treeQueryAffectedByWatch(query, source), true);
  for (const key of ['serviceGeneration', 'projectId', 'configIdentity', 'context', 'namespace'] as const) assert.equal(treeQueryAffectedByWatch(query, { ...source, target: { ...target, [key]: 'other' } }), false);
  assert.equal(treeQueryAffectedByWatch({ ...query, resource: 'secrets' }, source), false);
  assert.equal(treeQueryAffectedByWatch({ kind: 'custom-types', target }, source), false);
});
test('relisting and resync markers coalesce the matching loaded tree list without fabricated object events', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods'); const before = f.requests.length;
    f.observe({}, false, 'RELISTING'); f.observe({}, false, 'RESYNC'); assert.equal(f.timers.count, 1); await f.flush(); assert.equal(f.requests.length, before + 1);
  } finally { f.close(); }
});
test('Pod watch conservatively invalidates selector and cross-namespace Node Pod lists, not Pod info with an old parent RV', () => {
  for (const resource of ['nodes', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'services'] as const) assert.equal(treeQueryAffectedByWatch({ kind: 'children', target, parent: { resource, name: 'sample', uid: 'u', resourceVersion: 'r' } }, source), true);
  for (const resource of ['pods', 'secrets', 'configmaps'] as const) assert.equal(treeQueryAffectedByWatch({ kind: 'children', target, parent: { resource, name: 'sample', uid: 'u', resourceVersion: 'r' } }, source), false);
});
test('query identity ignores only opaque parent/definition RV, not UID/namespace/target/type', () => {
  const query: TreeQuery = { kind: 'children', target, parent: { resource: 'pods', name: 'child', namespace: 'default', uid: 'u', resourceVersion: 'r1' } };
  assert.equal(sameTreeQueryIdentity(query, { ...query, parent: { ...query.parent, resourceVersion: 'r2' } }), true);
  for (const change of [{ uid: 'new' }, { namespace: 'other' }, { resource: 'secrets' as const }]) assert.equal(sameTreeQueryIdentity(query, { ...query, parent: { ...query.parent, ...change } }), false);
  assert.equal(sameTreeQueryIdentity(query, { ...query, target: { ...target, projectId: 'other' } }), false);
  const custom: TreeQuery = { kind: 'custom-resources', target, definition: { name: 'widgets.example.test', uid: 'u', resourceVersion: 'r1' } };
  assert.equal(sameTreeQueryIdentity(custom, { ...custom, definition: { ...custom.definition, resourceVersion: 'r2' } }), true);
});
test('refresh queue coalesces duplicate notices from the first fixed window without sliding or resetting its timer', async () => {
  const timers = scheduling(), reads: string[] = [], queue = new TreeRefreshQueue(async id => { reads.push(id); return ready; }, () => assert.fail(), timers.schedule);
  for (let n = 0; n < 1000; n++) queue.add(['a', 'b', 'a']); assert.equal(timers.scheduled, 1); assert.equal(reads.length, 0);
  timers.flush(); await settle(); assert.deepEqual(reads, ['a', 'b']); queue.dispose();
});
test('refresh queue has at most two unsettled reads and makes progress when a real read settles', async () => {
  const timers = scheduling(), reads: string[] = [], waits: Array<ReturnType<typeof Promise.withResolvers<TreeRefreshResult>>> = [];
  const queue = new TreeRefreshQueue(id => { reads.push(id); const value = Promise.withResolvers<TreeRefreshResult>(); waits.push(value); return value.promise; }, () => assert.fail(), timers.schedule);
  queue.add(['a', 'b', 'c']); timers.flush(); assert.deepEqual(reads, ['a', 'b']); waits[0]?.resolve(ready); await settle(); assert.deepEqual(reads, ['a', 'b', 'c']);
  queue.dispose(); for (const wait of waits) wait.resolve(ready); await settle();
});
test('queue reset rejects old restoration but does not release actual unsettled admission slots', async () => {
  const timers = scheduling(), reads: string[] = [], waits: Array<ReturnType<typeof Promise.withResolvers<TreeRefreshResult>>> = [];
  const queue = new TreeRefreshQueue(id => { reads.push(id); const value = Promise.withResolvers<TreeRefreshResult>(); waits.push(value); return value.promise; }, () => assert.fail(), timers.schedule);
  queue.add(['old-a', 'old-b']); timers.flush(); queue.reset(); queue.add(['new']); timers.flush(); assert.equal(reads.length, 2);
  waits[0]?.resolve({ phase: 'ready', children: ['late-child'] }); await settle(); assert.deepEqual(reads, ['old-a', 'old-b', 'new']);
  queue.dispose(); for (const wait of waits) wait.resolve(ready); await settle(); assert.equal(timers.count, 0);
});
test('automatic branch failure is not retried by later metadata notifications without explicit retry', async () => {
  const timers = scheduling(); let reads = 0; const queue = new TreeRefreshQueue(async () => { reads++; return { phase: 'error' }; }, () => assert.fail(), timers.schedule);
  queue.add(['a']); timers.flush(); await settle(); queue.add(['a']); timers.flush(); await settle(); assert.equal(reads, 1);
  queue.retry(['a']); queue.add(['a']); timers.flush(); await settle(); assert.equal(reads, 2); queue.dispose();
});
test('automatic refresh has a hard 64-attempt budget and reports remaining branches without silent truncation', async () => {
  const timers = scheduling(), rejected: string[] = []; let reads = 0;
  const queue = new TreeRefreshQueue(async () => { reads++; return ready; }, id => rejected.push(id), timers.schedule);
  queue.add(Array.from({ length: 70 }, (_, n) => `b${n}`)); timers.flush(); await settle(); assert.equal(reads, 64); assert.equal(rejected.length, 6);
  queue.add(['b64']); timers.flush(); await settle(); assert.equal(reads, 64); queue.dispose();
});
test('repeated invalidations during an unsettled read schedule only one follow-up, never a concurrent duplicate', async () => {
  const timers = scheduling(), wait = Promise.withResolvers<TreeRefreshResult>(); let reads = 0;
  const queue = new TreeRefreshQueue(async () => { if (++reads === 1) return wait.promise; return ready; }, () => assert.fail(), timers.schedule);
  queue.add(['a']); timers.flush(); for (let n = 0; n < 100; n++) queue.add(['a']); timers.flush(); assert.equal(reads, 1);
  wait.resolve({ phase: 'obsolete' }); await settle(); assert.equal(reads, 2); queue.dispose();
});
test('tree invalidates only matched loaded branches once and refreshes first pages after a coalesced window', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods'); const count = f.requests.length;
    for (let n = 0; n < 100; n++) f.observe(); assert.equal(f.requests.length, count); assert.equal(f.row('Pods').stale, true); assert.equal(f.timers.scheduled, 1);
    await f.flush(); assert.equal(f.requests.length, count + 1); assert.equal(f.row('Pods').stale, false); assert.equal(f.requests.at(-1)?.cursor, undefined);
  } finally { f.close(); }
});
test('tree never eagerly loads unopened resource directories due to an unrelated Watch', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads'); f.observe(); await f.flush(); assert.equal(f.requests.length, 0); assert.equal(f.row('Pods').phase, 'idle'); } finally { f.close(); }
});
test('bookmark-only pages are inert, lost metadata invalidates even without non-bookmark events', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods'); f.observe({}, false, 'BOOKMARK'); assert.equal(f.row('Pods').stale, false); assert.equal(f.timers.count, 0);
    f.observe({}, true, 'BOOKMARK'); assert.equal(f.row('Pods').stale, true); await f.flush(); assert.equal(f.row('Pods').stale, false);
  } finally { f.close(); }
});
test('foreign selection/target/generation and malformed pages cannot invalidate the current tree', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods');
    f.observe({ target: { ...f.target, projectId: 'other' } }); f.observe({ selection: { mode: 'file', path: '/synthetic/other' } });
    f.tree.observeWatch({ ...watch({ ...source, target: f.target }), raw: 'SYNTHETIC_SECRET' });
    const value = watch({ ...source, target: f.target }); f.tree.observeWatch({ ...value, handle: { ...value.handle, generation: 'old' } });
    assert.equal(f.row('Pods').stale, false); assert.equal(f.timers.count, 0);
  } finally { f.close(); }
});
test('collapsed cached lists are marked stale without reading, and expand performs one explicit fresh read', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods'); f.tree.collapse(f.row('Pods').id); const count = f.requests.length; f.observe(); await f.flush(); assert.equal(f.requests.length, count);
    assert.equal(f.row('Pods').stale, true); await f.tree.expand(f.row('Pods').id); assert.equal(f.requests.length, count + 1); assert.equal(f.row('Pods').stale, false);
  } finally { f.close(); }
});
test('hidden cached lists remain stale across ancestor collapse until visible expansion, without scanning other contexts', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods'); f.tree.collapse(f.row('Workloads').id); const count = f.requests.length; f.observe(); await f.flush(); assert.equal(f.requests.length, count);
    await f.tree.expand(f.row('Workloads').id); assert.equal(f.row('Pods').stale, true); assert.equal(f.requests.length, count); await f.tree.expand(f.row('Pods').id); assert.equal(f.row('Pods').stale, false);
  } finally { f.close(); }
});
test('same-UID new-RV refresh preserves expansion, selection and leaf focus while re-reading exact new child metadata', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods', 'child'); const child = f.row('child'); f.tree.select(child.id); f.tree.focus(f.row('Running (unknown)').id);
    f.change('p2', 'pod-u', '10.0.0.2'); f.observe(); await f.flush(); assert.equal(f.row('child').id, child.id); assert.equal(f.row('child').expanded, true); assert.equal(f.row('child').stale, true);
    await f.flush(); assert.equal(f.row('child').stale, false); assert.equal(f.row('child').selected, true); assert.equal(f.row('Running (unknown)').focused, true);
    assert.ok(f.tree.snapshot.rows.some(row => row.entry.node.label === '10.0.0.2')); assert.equal(f.requests.at(-1)?.parent?.resourceVersion, 'p2');
  } finally { f.close(); }
});
test('same-name replacement UID is never auto-expanded or selected as the old object', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods', 'child'); const child = f.row('child'); f.tree.select(child.id); f.tree.focus(child.id);
    f.change('p2', 'replacement'); f.observe(); await f.flush(); assert.notEqual(f.row('child').id, child.id); assert.equal(f.row('child').expanded, false); assert.equal(f.row('Pods').focused, true); assert.equal(f.tree.snapshot.rows.some(row => row.selected), false); assert.equal(f.timers.count, 0);
  } finally { f.close(); }
});
test('Pod change refreshes expanded selector lists even when metadata cannot tell whether the new Pod matches', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Deployments', 'sample'); const count = f.requests.length; f.observe(); await f.flush(); assert.equal(f.requests.length, count + 1); assert.equal(f.requests.at(-1)?.parent?.resource, 'deployments'); } finally { f.close(); }
});
test('Pod under Node and Workloads refreshes both independent occurrences while preserving unrelated expansion', async () => {
  const f = await fixture(); try { await f.open('active', 'Nodes', 'sample'); await f.open('Workloads', 'Pods'); const count = f.requests.length;
    f.observe(); await f.flush(); assert.equal(f.requests.length, count + 2); assert.equal(f.row('Nodes').expanded, true); assert.equal(f.row('Workloads').expanded, true); assert.equal(f.row('Pods').stale, false);
  } finally { f.close(); }
});
test('stop/collapse/dispose cancel queued refresh without querying or replaying a Watch', async () => {
  for (const action of ['stop', 'collapse', 'dispose'] as const) { const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods'); const count = f.requests.length; f.observe();
    if (action === 'stop') f.tree.stopWatchUpdates(); else if (action === 'collapse') f.tree.collapse(f.row('Pods').id); else f.tree.dispose();
    await f.flush(); assert.equal(f.requests.length, count);
  } finally { f.close(); } }
});
test('stopping an automatic read rejects its late page without pretending SDK proxy abort settled it', async () => {
  const f = await fixture(); const wait = Promise.withResolvers<void>(); try { await f.open('active', 'Workloads', 'Pods'); f.hold(() => wait.promise); f.observe(); f.timers.flush(); await settle(); f.tree.stopWatchUpdates(); wait.resolve(); await settle(); assert.equal(f.row('Pods').stale, true); assert.equal(f.row('Pods').phase, 'error'); } finally { wait.resolve(); f.close(); }
});
test('new configuration generation clears queued updates and does not restore old expanded resources', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods'); const count = f.requests.length; f.observe(); f.tree.configure(f.page, { mode: 'default' }, 'new-project'); await f.flush(); assert.equal(f.requests.length, count); assert.equal(f.tree.snapshot.rows.length, 1); assert.equal(f.tree.snapshot.rows[0]?.expanded, false); } finally { f.close(); }
});
test('refresh error stays explicitly stale and later notifications cannot create an automatic auth retry loop', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods'); f.fail(true); f.observe(); await f.flush(); const count = f.requests.length; assert.equal(f.row('Pods').error, 'FORBIDDEN');
    f.observe(); await f.flush(); assert.equal(f.requests.length, count); assert.equal(f.row('Pods').stale, true); f.fail(false); await f.tree.refresh(f.row('Pods').id); assert.equal(f.row('Pods').stale, false);
  } finally { f.close(); }
});
test('watch invalidation discards continuation rather than appending a new list into the old snapshot', async () => {
  const f = await fixture(); try { f.cursor('synthetic-next'); await f.open('active', 'Workloads', 'Pods'); assert.equal(f.row('Pods').canMore, true); f.observe(); assert.equal(f.row('Pods').canMore, false); f.cursor(null); await f.flush(); assert.equal(f.requests.at(-1)?.cursor, undefined); assert.equal(f.row('Pods').canMore, false); } finally { f.close(); }
});
test('manual same-UID refresh also restores expanded children once without requiring a Watch or altering saved write references', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods', 'child'); const original = f.row('child').entry.node.resource;
    f.change('p2'); await f.tree.refresh(f.row('Pods').id); assert.equal(f.row('child').expanded, true); await f.flush(); assert.equal(f.row('child').stale, false);
    assert.equal(original?.resourceVersion, 'p1'); assert.equal(f.row('child').entry.node.resource?.resourceVersion, 'p2'); assert.equal(f.requests.at(-1)?.parent?.resourceVersion, 'p2');
  } finally { f.close(); }
});
test('a second notification invalidates an unsettled refresh ticket; only its coalesced successor can clear stale', async () => {
  const f = await fixture(), wait = Promise.withResolvers<void>(); try { await f.open('active', 'Workloads', 'Pods'); f.hold(() => wait.promise); f.observe(); f.timers.flush(); await settle();
    f.observe(); f.timers.flush(); await settle(); assert.equal(f.requests.length, 2); f.hold(undefined); wait.resolve(); await settle(); assert.equal(f.requests.length, 3); assert.equal(f.row('Pods').stale, false);
  } finally { wait.resolve(); f.close(); }
});
test('collapse after a successful parent refresh prevents queued child restoration from reopening its descendants', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods', 'child'); f.change('p2'); f.observe(); await f.flush(); const count = f.requests.length;
    f.tree.collapse(f.row('child').id); await f.flush(); assert.equal(f.requests.length, count); assert.equal(f.row('child').expanded, false); assert.equal(f.row('child').stale, true);
  } finally { f.close(); }
});
test('reopening a stale collapsed list restores its previously expanded same-UID child with the new RV', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods', 'child'); f.tree.collapse(f.row('Pods').id); f.change('p2'); f.observe(); await f.flush();
    await f.tree.expand(f.row('Pods').id); assert.equal(f.row('child').stale, true); await f.flush(); assert.equal(f.row('child').expanded, true); assert.equal(f.row('child').stale, false);
  } finally { f.close(); }
});
test('a malformed reconfiguration cancels queued automatic work and leaves old roots explicitly unavailable', async () => {
  const f = await fixture(); try { await f.open('active', 'Workloads', 'Pods'); const count = f.requests.length; f.observe(); f.tree.configure({}, { mode: 'default' }, 'view');
    await f.flush(); assert.equal(f.requests.length, count); assert.equal(f.tree.snapshot.roots.phase, 'error'); assert.ok(f.tree.snapshot.rows.every(row => row.stale));
  } finally { f.close(); }
});
