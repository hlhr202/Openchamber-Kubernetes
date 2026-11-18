import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { utf8ByteLength } from '../../src/shared/identity.ts';
import { configurationReadTarget } from '../../src/shared/protocol.ts';
import { TreeModel } from '../../src/shared/tree-model.ts';
import type { TreeRow } from '../../src/shared/tree-model.ts';
import { localTreeEntries, readTreeEntry, resourceTreeEntry } from '../../src/shared/tree-entries.ts';
import type { TreeEntry } from '../../src/shared/tree-entries.ts';
import { resourceDescriptors } from '../../src/shared/tree.ts';
import { TreeController } from '../../src/host/tree-controller.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { projectConfigPage } from '../../src/service/queries/config-page.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';

const marker = 'SYNTHETIC_TREE_SECRET';
const target = { serviceGeneration: 's', projectId: 'view', configIdentity: 'c', context: 'active', namespace: 'default' };
const root: TreeEntry = { node: { id: 'active-context', type: 'context', label: 'active', expandable: true, tooltip: 'active\nCluster: c' }, query: { kind: 'context', target } };
const signal = () => new AbortController().signal;
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;
function row(tree: TreeController, label: string, parent?: string): TreeRow {
  const found = tree.snapshot.rows.find(row => row.entry.node.label === label && (parent === undefined || row.parent === parent));
  assert.ok(found, `missing synthetic row: ${label}`); return found;
}
async function open(tree: TreeController, ...labels: string[]) {
  let parent: string | undefined, found: TreeRow | undefined;
  for (const label of labels) { found = row(tree, label, parent); await tree.expand(found.id); parent = found.id; }
  assert.ok(found); return found;
}
async function fixture(reply?: (request: ResourceReadRequest) => unknown | Promise<unknown>, count = 2) {
  let currentNamespace = 'default';
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active',
    clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: Array.from({ length: count }, (_, index) => ({ name: index === count - 1 ? 'active' : `inactive-${index}`, context: { cluster: 'c', ...(index === count - 1 && currentNamespace !== 'default' ? { namespace: currentNamespace } : {}) } })) }) }));
  const configRead = await config.read({ mode: 'default' }), requests: ResourceReadRequest[] = [];
  let uid = 'pod-uid', rv = '12';
  function pod(namespace = 'default') { return { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'child', namespace, uid, resourceVersion: rv }, status: { phase: 'Running', podIP: '10.0.0.2', containerStatuses: [{ ready: true }] } }; }
  function response(request: ResourceReadRequest): unknown {
    if (request.purpose === 'resource-object') {
      if (request.path.includes('/pods/')) return pod(/\/namespaces\/([^/]+)/.exec(request.path)?.[1]);
      const descriptor = Object.values(resourceDescriptors).find(type => request.path.endsWith(`/${type.resource}/sample`)); assert.ok(descriptor);
      return { apiVersion: descriptor.group ? `${descriptor.group}/${descriptor.version}` : descriptor.version, kind: descriptor.kind,
        metadata: { name: 'sample', uid: 'parent-uid', resourceVersion: '10', ...(descriptor.scope === 'namespace' ? { namespace: 'default' } : {}) },
        spec: { selector: { matchLabels: { app: 'one' } } }, data: { one: marker, two: Buffer.from(marker).toString('base64') } };
    }
    const descriptor = Object.values(resourceDescriptors).find(type => request.path.endsWith(`/${type.resource}`)); assert.ok(descriptor);
    return { apiVersion: descriptor.group ? `${descriptor.group}/${descriptor.version}` : descriptor.version, kind: `${descriptor.kind}List`, metadata: { resourceVersion: '20' },
      items: descriptor.resource === 'pods' ? [pod(/\/namespaces\/([^/]+)/.exec(request.path)?.[1])] : [{ apiVersion: descriptor.group ? `${descriptor.group}/${descriptor.version}` : descriptor.version, kind: descriptor.kind,
        metadata: { name: 'sample', uid: 'parent-uid', resourceVersion: '10', ...(descriptor.scope === 'namespace' ? { namespace: 'default' } : {}) }, data: { private: marker } }] };
  }
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => {
    requests.push(request); const body = JSON.stringify(reply ? await reply(request) : response(request));
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(body); } }, close: async () => {} };
  } });
  const transport = async (request: { method: 'POST'; path: string; body: string }) => {
    try { return { status: 200, body: JSON.stringify(await (request.path === '/v2/resources/read' ? gateway.read(JSON.parse(request.body) as unknown, signal()) : gateway.readTree(JSON.parse(request.body) as unknown, signal()))) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  };
  const tree = new TreeController(transport);
  const page = (offset = 0) => projectConfigPage(configRead, 's', { offset, limit: 100 });
  tree.configure(page(), { mode: 'default' }, 'view');
  return { tree, page, requests, transport, gateway, response, pod, change: (nextUid: string, nextRv: string) => { uid = nextUid; rv = nextRv; },
    // Replace only the read fixture's input. No namespace operation or kubeconfig writer is simulated.
    readSnapshot: async (namespace: string) => { currentNamespace = namespace; return projectConfigPage(await config.read({ mode: 'default' }), 's', { offset: 0, limit: 100 }); },
    close: () => { tree.dispose(); gateway.close(); } };
}

test('configuration roots preserve source order, are inert, and only available active context can expand', async () => {
  const f = await fixture(); assert.deepEqual(f.tree.snapshot.rows.map(row => row.entry.node.label), ['inactive-0', 'active']);
  assert.equal(f.requests.length, 0); await f.tree.expand(row(f.tree, 'inactive-0').id); assert.equal(f.tree.snapshot.rows.length, 2);
  await f.tree.expand(row(f.tree, 'active').id); assert.equal(f.requests.length, 0);
  assert.deepEqual(f.tree.snapshot.rows.filter(row => row.level === 2).map(row => row.entry.node.label), ['Namespaces', 'Nodes', 'Workloads', 'Network', 'Storage', 'Configuration', 'Custom Resources', 'Helm Releases']);
  assert.equal(f.tree.snapshot.rows.some(row => row.entry.node.label === 'Clusters'), false); f.close();
});

test('identical first configuration pages preserve complete tree state and generation with zero new reads', async () => {
  const f = await fixture();
  await open(f.tree, 'active', 'Workloads', 'Pods', 'child');
  const selected = row(f.tree, '10.0.0.2');
  f.tree.select(selected.id); f.tree.focus(selected.id);
  const before = f.tree.snapshot, reads = f.requests.length;
  for (let index = 0; index < 100; index++) f.tree.configure(f.page(), { mode: 'default' }, 'view');
  assert.deepEqual(f.tree.snapshot, before);
  assert.equal(f.tree.snapshot.generation, before.generation);
  assert.equal(f.requests.length, reads);
  f.tree.configure({ ...f.page(), serviceGeneration: 'new-service' }, { mode: 'default' }, 'view');
  assert.notEqual(f.tree.snapshot.generation, before.generation);
  assert.equal(f.tree.snapshot.rows.some(row => row.id === selected.id), false);
  f.close();
});

test('an identical configuration snapshot does not abort an in-flight expanded branch read', async () => {
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async () => { await held; return { apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: '20' }, items: [] }; });
  await open(f.tree, 'active', 'Workloads');
  const pods = row(f.tree, 'Pods'), pending = f.tree.expand(pods.id), generation = f.tree.snapshot.generation;
  f.tree.select(pods.id); f.tree.focus(pods.id);
  f.tree.configure(f.page(), { mode: 'default' }, 'view');
  assert.equal(f.tree.snapshot.generation, generation); assert.equal(row(f.tree, 'Pods').expanded, false);
  assert.equal(row(f.tree, 'Pods').opening, true);
  release(); await pending;
  assert.equal(row(f.tree, 'Pods').phase, 'ready'); assert.equal(row(f.tree, 'Pods').selected, true);
  assert.equal(row(f.tree, 'Pods').expanded, true); assert.equal(row(f.tree, 'Pods').opening, undefined);
  assert.equal(f.requests.length, 1); f.close();
});

test('a fresh namespace configuration reopens only previously open lists, and the new Pod expands with its new target', async () => {
  const f = await fixture();
  try {
    await open(f.tree, 'active', 'Workloads', 'Pods', 'child');
    const previous = f.tree.snapshot, oldPod = row(f.tree, 'child');
    const fresh = await f.readSnapshot('payments'), next = configurationReadTarget(fresh, 'view')!;
    assert.notEqual(next.configIdentity, f.page().configIdentity);
    const start = f.requests.length;
    f.tree.suspend(); f.tree.configure(fresh, { mode: 'default' }, 'view');
    await f.tree.reopenNamespaceFolders(previous, next);
    assert.deepEqual(f.requests.slice(start).map(request => request.path), ['/api/v1/namespaces/payments/pods']);
    assert.equal(row(f.tree, 'Deployments').expanded, false);
    const child = row(f.tree, 'child');
    assert.notEqual(child.id, oldPod.id);
    assert.equal(child.entry.node.resource?.namespace, 'payments');
    assert.equal(child.expanded, false);
    await f.tree.expand(oldPod.id); assert.equal(f.requests.length, start + 1);
    await f.tree.expand(child.id);
    assert.equal(row(f.tree, 'child').phase, 'ready');
    assert.equal(row(f.tree, '10.0.0.2', child.id).parent, child.id);
    assert.ok(f.requests.slice(start + 1).length > 0);
    for (const request of f.requests.slice(start)) {
      assert.deepEqual(request.target, next);
      assert.match(request.path, /^\/api\/v1\/namespaces\/payments\/pods(?:\/child)?$/);
    }
    await f.tree.reopenNamespaceFolders(previous, { ...next, configIdentity: 'superseded' });
    assert.equal(row(f.tree, 'child').phase, 'ready');
  } finally { f.close(); }
});

test('a branch expansion deduplicates clicks, stops spinning on error and does not reopen after collapse', async () => {
  for (const collapse of [false, true]) {
    let unblock: () => void = () => {};
    const held = new Promise<void>(resolve => { unblock = resolve; });
    const f = await fixture(async () => { await held; throw new BoundaryError('FORBIDDEN'); });
    try {
      await open(f.tree, 'active', 'Workloads');
      assert.equal(f.requests.length, 0);
      const pods = row(f.tree, 'Pods');
      const first = f.tree.expand(pods.id), repeated = f.tree.expand(pods.id);
      assert.equal(row(f.tree, 'Pods').opening, true); assert.equal(row(f.tree, 'Pods').expanded, false);
      assert.equal(row(f.tree, 'Deployments').opening, undefined);
      if (collapse) f.tree.collapse(pods.id);
      unblock(); await Promise.all([first, repeated]);
      const result = row(f.tree, 'Pods');
      assert.ok(f.requests.length <= 1);
      assert.equal(result.opening, undefined);
      assert.equal(result.expanded, !collapse);
      assert.equal(result.error, collapse ? 'QUERY_CANCELLED' : 'FORBIDDEN');
    } finally { f.close(); }
  }
});

test('all static classifications are exact, icon-free, lazy and never create an extra resource layer', async () => {
  const f = await fixture(); await open(f.tree, 'active');
  const groups = { Workloads: ['Deployments', 'StatefulSets', 'DaemonSets', 'Jobs', 'CronJobs', 'Pods'], Network: ['Services', 'Endpoints', 'Ingress'], Storage: ['Persistent Volumes', 'Persistent Volume Claims', 'Storage Classes'], Configuration: ['Config Maps', 'Secrets'] };
  for (const [label, expected] of Object.entries(groups)) {
    const group = await open(f.tree, label); const children = f.tree.snapshot.rows.filter(row => row.parent === group.id);
    assert.deepEqual(children.map(row => row.entry.node.label), expected); assert.ok(children.every(row => !row.entry.node.icon));
  }
  assert.equal(f.requests.length, 0); f.close();
});

test('selection and focus never toggle expansion, query resources, or execute node business commands', async () => {
  const f = await fixture(); const active = row(f.tree, 'active'); f.tree.select(active.id); f.tree.focus(active.id);
  await f.tree.keyboard('Enter'); await f.tree.keyboard(' ');
  assert.equal(row(f.tree, 'active').expanded, false); assert.equal(row(f.tree, 'active').selected, true); assert.equal(f.requests.length, 0); f.close();
});

test('real read composition loads Pods and independent information leaves through the validated source', async () => {
  const f = await fixture(); await open(f.tree, 'active', 'Workloads', 'Pods', 'child');
  const children = f.tree.snapshot.rows.filter(row => row.parent === rowId(f.tree, 'child'));
  assert.deepEqual(children.map(row => row.entry.node.label), ['Running (1/1)', '10.0.0.2']);
  assert.equal(f.requests.length, 3); assert.equal(f.tree.snapshot.rows.some(row => row.entry.node.label === 'Containers'), false); f.close();
});
function rowId(tree: TreeController, label: string) { return row(tree, label).id; }

test('Secret keys reach the tree as names only; no source values/encodings are retained in snapshots', async () => {
  const f = await fixture(); await open(f.tree, 'active', 'Configuration', 'Secrets', 'sample');
  const keys = f.tree.snapshot.rows.filter(row => row.parent === rowId(f.tree, 'sample'));
  assert.deepEqual(keys.map(row => row.entry.node.label), ['one', 'two']);
  for (const unsafe of [marker, Buffer.from(marker).toString('base64'), 'stringData', 'annotations']) assert.equal(JSON.stringify(f.tree.snapshot).includes(unsafe), false);
  assert.ok(keys.every(row => !row.entry.node.expandable && !row.entry.query)); f.close();
});

test('one resource under multiple branches has occurrence-specific handles and independent expansion/selection state', async () => {
  const f = await fixture(); await open(f.tree, 'active', 'Nodes', 'sample', 'child');
  const nodePod = row(f.tree, 'child'); f.tree.select(nodePod.id);
  await open(f.tree, 'Workloads', 'Pods', 'child'); const pods = f.tree.snapshot.rows.filter(row => row.entry.node.label === 'child');
  assert.equal(pods.length, 2); assert.notEqual(pods[0]?.id, pods[1]?.id); assert.equal(pods[0]?.entry.node.id, pods[1]?.entry.node.id);
  const second = pods.find(row => row.id !== nodePod.id); assert.ok(second); assert.equal(second.expanded, true); assert.equal(second.selected, false);
  f.tree.collapse(nodePod.parent ?? ''); assert.equal(f.tree.snapshot.rows.find(row => row.id === second.id)?.expanded, true); f.close();
});

test('same-UID/RV refresh preserves handles, selection and expanded descendants without automatic replay', async () => {
  const f = await fixture(); await open(f.tree, 'active', 'Workloads', 'Pods', 'child');
  const child = row(f.tree, 'child'); f.tree.select(child.id); f.tree.focus(child.id); const count = f.requests.length;
  await f.tree.refresh(rowId(f.tree, 'Pods'));
  const fresh = row(f.tree, 'child'); assert.equal(fresh.id, child.id); assert.equal(fresh.expanded, true); assert.equal(fresh.selected, true); assert.equal(fresh.focused, true);
  assert.equal(f.requests.length, count + 1); f.close();
});

test('same-UID new-RV refresh invalidates child information and retains occurrence expansion intent and focus', async () => {
  const f = await fixture(); await open(f.tree, 'active', 'Workloads', 'Pods', 'child'); const child = row(f.tree, 'child');
  f.tree.focus(rowId(f.tree, '10.0.0.2')); f.change('pod-uid', '13'); await f.tree.refresh(rowId(f.tree, 'Pods'));
  const fresh = row(f.tree, 'child'); assert.equal(fresh.id, child.id); assert.equal(fresh.expanded, true); assert.equal(fresh.phase, 'idle'); assert.equal(fresh.stale, true);
  assert.equal(row(f.tree, '10.0.0.2').focused, true); assert.equal(row(f.tree, '10.0.0.2').stale, true); f.close();
});

test('resource recreation replaces occurrence and clears its old selection; focus restores to the nearest surviving ancestor', async () => {
  const f = await fixture(); await open(f.tree, 'active', 'Workloads', 'Pods', 'child'); const child = row(f.tree, 'child');
  f.tree.focus(child.id); f.tree.select(child.id); f.change('replacement-uid', '13'); const folder = row(f.tree, 'Pods'); await f.tree.refresh(folder.id);
  assert.notEqual(row(f.tree, 'child').id, child.id); assert.equal(row(f.tree, 'Pods').focused, true); assert.equal(f.tree.snapshot.rows.some(row => row.selected), false); f.close();
});

test('keyboard arrows/Home/End move focus without selection; left collapse restores focus from a descendant', async () => {
  const f = await fixture(); f.tree.focus(rowId(f.tree, 'active')); await f.tree.keyboard('ArrowRight'); await f.tree.keyboard('ArrowRight');
  assert.equal(row(f.tree, 'Namespaces').focused, true); await f.tree.keyboard('ArrowDown'); assert.equal(row(f.tree, 'Nodes').focused, true);
  await f.tree.keyboard('ArrowLeft'); assert.equal(row(f.tree, 'active').focused, true);
  await f.tree.keyboard('Home'); assert.equal(row(f.tree, 'inactive-0').focused, true); await f.tree.keyboard('End'); assert.equal(row(f.tree, 'Helm Releases').focused, true);
  f.tree.select(rowId(f.tree, 'Nodes')); f.tree.collapse(rowId(f.tree, 'active')); assert.equal(row(f.tree, 'active').focused, true);
  assert.equal(f.tree.snapshot.rows.some(row => row.selected), false); await f.tree.expand(rowId(f.tree, 'active')); assert.equal(row(f.tree, 'Nodes').selected, true); f.close();
});

test('typeahead searches visible labels with a bounded time window and never selects or queries', async () => {
  const f = await fixture(); await open(f.tree, 'active'); f.tree.typeahead('N', 1000); assert.equal(row(f.tree, 'Namespaces').focused, true);
  f.tree.typeahead('o', 1100); assert.equal(row(f.tree, 'Nodes').focused, true); f.tree.typeahead('W', 2000); assert.equal(row(f.tree, 'Workloads').focused, true);
  assert.equal(f.tree.snapshot.rows.some(row => row.selected), false); assert.equal(f.requests.length, 0); f.close();
});

test('click selection moves the cursor atomically; arrow navigation and Space work from that row without reads', async () => {
  const f = await fixture();
  try {
    await open(f.tree, 'active');
    const namespaces = row(f.tree, 'Namespaces');
    f.tree.select(namespaces.id);
    assert.deepEqual(f.tree.snapshot.rows.filter(value => value.focused).map(value => value.id), [namespaces.id]);
    assert.equal(row(f.tree, 'Namespaces').selected, true);
    await f.tree.keyboard('ArrowDown');
    assert.equal(row(f.tree, 'Nodes').focused, true);
    assert.equal(row(f.tree, 'Namespaces').selected, true);
    await f.tree.keyboard('Space');
    assert.equal(row(f.tree, 'Nodes').selected, true);
    assert.equal(f.requests.length, 0);
  } finally { f.close(); }
});

test('Helm unmet dependency is explicit error rather than empty success and never runs a Helm/cache operation', async () => {
  const f = await fixture(); await open(f.tree, 'active', 'Helm Releases'); const helm = row(f.tree, 'Helm Releases');
  assert.equal(helm.phase, 'error'); assert.equal(helm.error, 'STATE_UNAVAILABLE'); assert.equal(f.requests.length, 0); f.close();
});

test('context roots append only a matching configuration snapshot page, including an active context not on page one', async () => {
  const f = await fixture(undefined, 101); assert.equal(f.tree.snapshot.rows.length, 100); assert.equal(f.tree.snapshot.roots.nextOffset, 100);
  assert.ok(f.tree.snapshot.rows.every(row => !row.entry.node.expandable && row.setSize === 101));
  f.tree.suspend(); f.tree.configure(f.page(100), { mode: 'default' }, 'view', 100);
  assert.equal(f.tree.snapshot.roots.phase, 'ready'); assert.equal(f.tree.snapshot.rows.length, 101); assert.equal(f.tree.snapshot.roots.nextOffset, null);
  await f.tree.expand(rowId(f.tree, 'active')); assert.equal(f.requests.length, 0); f.close();
});

test('context paging rejects mismatching project/source/offset and marks retained roots stale', async () => {
  const f = await fixture(undefined, 101); f.tree.configure(f.page(100), { mode: 'default' }, 'other-project', 100);
  assert.equal(f.tree.snapshot.roots.error, 'STALE_TARGET'); assert.equal(f.tree.snapshot.rows.length, 100); assert.ok(f.tree.snapshot.rows.every(row => row.stale)); f.close();
});

test('in-flight collapse discards a late resource page and an explicit retry is required', async () => {
  const f = await fixture(); let release: (() => void) | undefined;
  const tree = new TreeController(async request => { await new Promise<void>(resolve => { release = resolve; }); return f.transport(request); });
  tree.configure(f.page(), { mode: 'default' }, 'view'); await open(tree, 'active', 'Workloads'); const folder = row(tree, 'Pods');
  const pending = tree.expand(folder.id); tree.collapse(folder.id); release?.(); await pending;
  assert.equal(row(tree, 'Pods').phase, 'error'); assert.equal(row(tree, 'Pods').error, 'QUERY_CANCELLED'); assert.equal(tree.snapshot.rows.some(row => row.entry.node.type === 'resource'), false);
  tree.dispose(); f.close();
});

test('project/service reconfigure and disposal reject late delivery without claiming SDK proxy cancellation', async () => {
  const f = await fixture();
  for (const action of ['project', 'dispose'] as const) {
    let release: (() => void) | undefined, shows = 0;
    const tree = new TreeController(async request => { await new Promise<void>(resolve => { release = resolve; }); return f.transport(request); }, () => { shows++; });
    tree.configure(f.page(), { mode: 'default' }, 'view'); await open(tree, 'active', 'Workloads'); const pending = tree.expand(rowId(tree, 'Pods'));
    if (action === 'project') tree.configure(f.page(), { mode: 'default' }, 'new-view'); else tree.dispose();
    const before = shows; release?.(); await pending;
    assert.equal(tree.snapshot.rows.some(row => row.entry.node.type === 'resource'), false); if (action === 'dispose') assert.equal(shows, before); tree.dispose();
  }
  f.close();
});

test('tree snapshots and entry resources are deeply immutable and cannot carry secret extension fields', () => {
  const model = new TreeModel(); model.reset([root]); const id = model.visible()[0]?.id; assert.ok(id); model.expand(id); const ticket = model.begin(id); assert.ok(ticket);
  const entries = localTreeEntries(ticket.query); assert.ok(entries); model.apply(ticket, { entries, cursor: null, proof: { resourceVersion: null } });
  assert.equal(Object.isFrozen(model.visible()), true); assert.equal(Object.isFrozen(model.visible()[0]?.entry.query), true);
  assert.throws(() => readTreeEntry({ ...root, node: { ...root.node, data: marker } }), fails('STATE_UNAVAILABLE'));
});

test('whole-page memory/node budget failure does not partially replace or truncate visible children', () => {
  const model = new TreeModel({ nodes: 2, bytes: 100_000 }); model.reset([root]); const id = model.visible()[0]?.id; assert.ok(id); model.expand(id); const ticket = model.begin(id); assert.ok(ticket);
  const entries = localTreeEntries(ticket.query); assert.ok(entries);
  assert.throws(() => model.apply(ticket, { entries, cursor: null, proof: { resourceVersion: null } }), fails('BUDGET_EXCEEDED'));
  model.fail(ticket, 'BUDGET_EXCEEDED'); assert.equal(model.size, 1); assert.equal(model.visible()[0]?.phase, 'error');
});

test('UTF-8 budgeting is portable without DOM/Node encoders, including astral and lone surrogate input', () => {
  for (const value of ['', 'plain', '中文', '🎉', '\ud800', '\udc00', 'a🎉中']) assert.equal(utf8ByteLength(value), Buffer.byteLength(value));
});

test('missing stable references disable resource expansion instead of manufacturing UID/RV', () => {
  const entry = resourceTreeEntry({ id: 'partial', type: 'resource', label: 'partial', expandable: true, children: 'pod-info',
    resource: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace', namespace: 'default', name: 'partial' } }, target);
  assert.equal(entry.query, null); assert.equal(entry.node.expandable, false); assert.ok(readTreeEntry(entry));
});

function listPage(name: string, continuation = '', rv = '20') {
  return { apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: rv, continue: continuation },
    items: name ? [{ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: 'default', uid: `${name}-uid`, resourceVersion: '12' } }] : [] };
}

test('resource pagination appends exact snapshots, permits empty intermediate pages, and exposes no invented total or cursor in rows', async () => {
  const f = await fixture(request => !request.query.continue ? listPage('first', 'next-1') : request.query.continue === 'next-1' ? listPage('', 'next-2') : listPage('last'));
  const folder = await open(f.tree, 'active', 'Workloads', 'Pods');
  assert.equal(row(f.tree, 'Pods').canMore, true); assert.equal(row(f.tree, 'first').setSize, -1); assert.equal(JSON.stringify(f.tree.snapshot).includes('rp1.'), false);
  await f.tree.more(folder.id); assert.equal(row(f.tree, 'Pods').canMore, true); assert.equal(f.tree.snapshot.rows.filter(row => row.parent === folder.id).length, 1);
  await f.tree.more(folder.id); assert.deepEqual(f.tree.snapshot.rows.filter(row => row.parent === folder.id).map(row => row.entry.node.label), ['first', 'last']);
  assert.equal(row(f.tree, 'first').setSize, 2); assert.equal(row(f.tree, 'Pods').canMore, false); f.close();
});

test('duplicates across pages and list-RV changes reject a whole new page, retain stale children and disable more', async () => {
  for (const mode of ['duplicate', 'rv'] as const) {
    const f = await fixture(request => !request.query.continue ? listPage('first', 'next') : listPage(mode === 'duplicate' ? 'first' : 'second', '', mode === 'rv' ? 'changed' : '20'));
    const folder = await open(f.tree, 'active', 'Workloads', 'Pods'); await f.tree.more(folder.id);
    assert.equal(row(f.tree, 'Pods').phase, 'error'); assert.equal(row(f.tree, 'Pods').error, mode === 'rv' ? 'STALE_TARGET' : 'STATE_UNAVAILABLE');
    assert.equal(row(f.tree, 'Pods').canMore, false); assert.equal(row(f.tree, 'first').stale, true); assert.equal(f.tree.snapshot.rows.some(row => row.entry.node.label === 'second'), false);
    const reads = f.requests.length; await f.tree.more(folder.id); assert.equal(f.requests.length, reads); f.close();
  }
});

test('refresh failure retains stale descendants and cannot start their queries until the ancestor is explicitly retried', async () => {
  const f = await fixture(); let fail = false;
  const tree = new TreeController(request => fail ? Promise.resolve({ status: 403, body: JSON.stringify({ error: { code: 'FORBIDDEN' } }) }) : f.transport(request));
  tree.configure(f.page(), { mode: 'default' }, 'view'); await open(tree, 'active', 'Workloads', 'Pods', 'child'); fail = true;
  await tree.refresh(rowId(tree, 'Pods')); assert.equal(row(tree, 'Pods').error, 'FORBIDDEN'); assert.equal(row(tree, 'child').stale, true);
  const count = f.requests.length; await tree.refresh(rowId(tree, 'child')); assert.equal(f.requests.length, count);
  fail = false; await tree.refresh(rowId(tree, 'Pods')); assert.equal(row(tree, 'Pods').phase, 'ready'); tree.dispose(); f.close();
});

test('cancelled non-cooperating SDK reads still consume the eight-request admission budget until actual settle', async () => {
  const f = await fixture(), releases: (() => void)[] = [];
  const tree = new TreeController(async request => { await new Promise<void>(resolve => { releases.push(resolve); }); return f.transport(request); });
  tree.configure(f.page(), { mode: 'default' }, 'view'); await open(tree, 'active', 'Workloads'); const folder = row(tree, 'Pods');
  const pending: Promise<void>[] = [];
  for (let index = 0; index < 8; index++) { pending.push(tree.refresh(folder.id)); tree.cancel(folder.id); }
  await tree.refresh(folder.id); assert.equal(row(tree, 'Pods').error, 'QUERY_LIMIT'); assert.equal(releases.length, 8);
  await tree.expand(rowId(tree, 'Storage')); assert.equal(row(tree, 'Storage').phase, 'ready'); assert.equal(releases.length, 8);
  for (const release of releases) release(); await Promise.all(pending);
  assert.equal(row(tree, 'Pods').error, 'QUERY_LIMIT'); tree.dispose(); f.close();
});

test('hidden rows cannot be loaded by a delayed expansion/refresh action after an ancestor collapses', async () => {
  const f = await fixture(); await open(f.tree, 'active', 'Workloads'); const folder = row(f.tree, 'Pods'); f.tree.collapse(rowId(f.tree, 'Workloads'));
  await f.tree.expand(folder.id); await f.tree.refresh(folder.id); assert.equal(f.requests.length, 0); f.close();
});

test('model generation tickets cannot be replayed after reset or cancel even for the same occurrence origin', () => {
  const model = new TreeModel(); model.reset([root]); const id = model.visible()[0]?.id; assert.ok(id); model.expand(id); const ticket = model.begin(id); assert.ok(ticket);
  model.cancel(id); assert.equal(model.apply(ticket, { entries: [], cursor: null, proof: { resourceVersion: null } }), false);
  const next = model.begin(id); assert.ok(next); model.reset([root]); assert.equal(model.apply(next, { entries: [], cursor: null, proof: { resourceVersion: null } }), false);
});

test('tree Custom Resources inserts plural folders directly, routes instances through discovery and never adds a group layer', async () => {
  const definition = { name: 'widgets.example.test', uid: 'definition-uid', resourceVersion: '10' };
  const crd = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: definition,
    spec: { group: 'example.test', scope: 'Namespaced', names: { plural: 'widgets', kind: 'Widget', listKind: 'Inventory' }, versions: [{ name: 'v1', served: true, storage: true }] } };
  const f = await fixture(request => {
    if (request.purpose === 'custom-resource-definitions') return { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinitionList', metadata: { resourceVersion: '30' }, items: [crd] };
    if (request.purpose === 'resource-object') return crd;
    if (request.purpose === 'api-group') return { name: 'example.test', preferredVersion: { version: 'v1', groupVersion: 'example.test/v1' }, versions: [{ version: 'v1', groupVersion: 'example.test/v1' }] };
    if (request.purpose === 'api-version') return { groupVersion: 'example.test/v1', resources: [{ name: 'widgets', namespaced: true, kind: 'Widget', verbs: ['list'] }] };
    return { apiVersion: 'example.test/v1', kind: 'Inventory', metadata: { resourceVersion: '40' }, items: [{ apiVersion: 'example.test/v1', kind: 'Widget', metadata: { name: 'one', namespace: 'default', uid: 'one-uid', resourceVersion: '42' }, data: { value: marker } }] };
  });
  await open(f.tree, 'active', 'Custom Resources', 'widgets'); const custom = row(f.tree, 'Custom Resources'), type = row(f.tree, 'widgets');
  assert.equal(type.parent, custom.id); assert.equal(row(f.tree, 'one').parent, type.id); assert.equal(row(f.tree, 'one').entry.node.expandable, false);
  assert.equal(f.tree.snapshot.rows.some(row => row.entry.node.label === 'example.test'), false); assert.equal(JSON.stringify(f.tree.snapshot).includes(marker), false); f.close();
});

test('stale occurrence actions after configure are inert rather than issuing queries or throwing into UI events', async () => {
  const f = await fixture(); await open(f.tree, 'active', 'Workloads'); const old = rowId(f.tree, 'Pods'); f.tree.configure(f.page(), { mode: 'default' }, 'new-project');
  await f.tree.expand(old); await f.tree.refresh(old); await f.tree.more(old); f.tree.collapse(old); f.tree.cancel(old); f.tree.select(old); f.tree.focus(old);
  assert.equal(f.requests.length, 0); assert.equal(f.tree.snapshot.rows.some(row => row.selected), false); f.close();
});

test('empty is explicit only after a completed final page, never for idle/loading/error or a continued empty page', async () => {
  const f = await fixture(() => listPage('')); await open(f.tree, 'active', 'Workloads'); assert.equal(row(f.tree, 'Pods').empty, false);
  await f.tree.expand(rowId(f.tree, 'Pods')); assert.equal(row(f.tree, 'Pods').empty, true); assert.equal(row(f.tree, 'Pods').phase, 'ready');
  const count = f.requests.length; await f.tree.expand(rowId(f.tree, 'Pods')); assert.equal(f.requests.length, count); f.close();
});
