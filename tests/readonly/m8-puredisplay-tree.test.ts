// Pure-display tree structure comparison against the Design section 3 baseline (synthetic fixtures only).
// This compares ORDER, INDENT LEVEL, labels, prefixes and expandability as structural geometry;
// pixel geometry (row height, twistie/icon positions) remains human-measured (R-05) and is NOT claimed here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TreeController } from '../../src/host/tree-controller.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { projectConfigPage } from '../../src/service/queries/config-page.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import { resourceDescriptors } from '../../src/shared/tree.ts';

const signal = () => new AbortController().signal;

async function displayFixture() {
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active',
    clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c', namespace: 'default' } }] }) }));
  const configRead = await config.read({ mode: 'default' });
  const requests: ResourceReadRequest[] = [];
  function responseOf(value: unknown) {
    const text = JSON.stringify(value);
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(text); } }, close: async () => {} };
  }
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => {
    requests.push(request);
    if (request.purpose === 'resource-object' && request.path.includes('/pods/')) {
      return responseOf({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web', namespace: 'default', uid: 'pod-uid', resourceVersion: '12' },
        status: { phase: 'Running', podIP: '10.0.0.12', containerStatuses: [{ ready: true }] }, spec: {} });
    }
    if (request.purpose === 'resource-object') {
      const descriptor = Object.values(resourceDescriptors).find(type => request.path.endsWith(`/${type.resource}/sample`));
      assert.ok(descriptor);
      const apiVersion = descriptor.group ? `${descriptor.group}/${descriptor.version}` : descriptor.version;
      const metadata = { name: 'sample', uid: 'parent-uid', resourceVersion: '10', ...(descriptor.scope === 'namespace' ? { namespace: 'default' } : {}) };
      return responseOf({ apiVersion, kind: descriptor.kind, metadata, data: { 'app.conf': 'synthetic' } });
    }
    const descriptor = Object.values(resourceDescriptors).find(type => request.path.endsWith(`/${type.resource}`));
    assert.ok(descriptor);
    const kind = descriptor.kind, apiVersion = descriptor.group ? `${descriptor.group}/${descriptor.version}` : descriptor.version;
    if (descriptor.resource === 'namespaces') {
      return responseOf({ apiVersion: 'v1', kind: 'NamespaceList', metadata: { resourceVersion: '20' }, items: [
        { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'default', uid: 'ns-1', resourceVersion: '6' } },
        { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'kube-system', uid: 'ns-2', resourceVersion: '7' } } ] });
    }
    if (descriptor.resource === 'pods') {
      return responseOf({ apiVersion, kind: `${kind}List`, metadata: { resourceVersion: '20' }, items: [
        { apiVersion, kind, metadata: { name: 'web', namespace: 'default', uid: 'pod-uid', resourceVersion: '12' }, status: { phase: 'Running', podIP: '10.0.0.12', containerStatuses: [{ ready: true }] } } ] });
    }
    const metadata = { name: 'sample', uid: 'parent-uid', resourceVersion: '10', ...(descriptor.scope === 'namespace' ? { namespace: 'default' } : {}) };
    return responseOf({ apiVersion, kind: `${kind}List`, metadata: { resourceVersion: '20' }, items: [{ apiVersion, kind, metadata, data: { 'app.conf': 'synthetic' } }] });
  } });
  const transport = async (request: { method: 'POST'; path: string; body: string }) => {
    const parsed = JSON.parse(request.body) as unknown;
    try { return { status: 200, body: JSON.stringify(request.path === '/v2/resources/read' ? await gateway.read(parsed, signal()) : await gateway.readTree(parsed, signal())) }; }
    catch { return { status: 400, body: JSON.stringify({ error: { code: 'STATE_UNAVAILABLE' } }) }; }
  };
  const tree = new TreeController(transport);
  tree.configure(projectConfigPage(configRead, 's', { offset: 0, limit: 100 }), { mode: 'default' }, 'view');
  return { tree, requests, close: () => { tree.dispose(); gateway.close(); } };
}

function label(tree: InstanceType<typeof TreeController>, wanted: string) {
  const found = tree.snapshot.rows.find(row => row.entry.node.label === wanted);
  assert.ok(found, `missing display row: ${wanted}; available: ${JSON.stringify(tree.snapshot.rows.map(row => `${row.level}:${row.entry.node.label}`))}`);
  return found;
}

async function expand(tree: InstanceType<typeof TreeController>, ...path: string[]) {
  let parent: string | undefined;
  for (const step of path) { const found = label(tree, step); await tree.expand(found.id); parent = found.id; }
  return parent;
}

test('the pure-display projection reproduces the Design 3.1 hierarchy with exact order and indent levels', async () => {
  const f = await displayFixture();
  // Expanded pure-display set: context, all categories, category subgroups, Namespaces leaves, Pods leaf and its info leaves, Config Maps key.
  await expand(f.tree, 'active');
  await expand(f.tree, 'Namespaces');
  await expand(f.tree, 'Workloads');
  await expand(f.tree, 'Network');
  await expand(f.tree, 'Storage');
  await expand(f.tree, 'Workloads', 'Pods');
  await expand(f.tree, 'Workloads', 'Pods', 'web');
  await expand(f.tree, 'Configuration', 'Config Maps', 'sample');
  const projection = f.tree.snapshot.rows.map(row => `${'  '.repeat(row.level - 1)}${row.entry.node.label}`);
  const expected = [
    'active',
    '  Namespaces', '    * default', '    kube-system',
    '  Nodes',
    '  Workloads', '    Deployments', '    StatefulSets', '    DaemonSets', '    Jobs', '    CronJobs', '    Pods', '      web', '        Running (1/1)', '        10.0.0.12',
    '  Network', '    Services', '    Endpoints', '    Ingress',
    '  Storage', '    Persistent Volumes', '    Persistent Volume Claims', '    Storage Classes',
    '  Configuration', '    Config Maps', '      sample', '        app.conf', '    Secrets',
    '  Custom Resources',
    '  Helm Releases',
  ];
  assert.deepEqual(projection, expected);
  assert.equal(f.tree.snapshot.rows.some(row => row.entry.node.label === 'Clusters'), false);
  f.close();
});

test('namespace star marker is label text on the current namespace leaf only, per Design 3.1', async () => {
  const f = await displayFixture();
  await expand(f.tree, 'active', 'Namespaces');
  const starred = label(f.tree, '* default'), plain = label(f.tree, 'kube-system');
  assert.equal(starred.entry.node.expandable, false, 'a Namespace is a leaf');
  assert.equal(plain.entry.node.expandable, false);
  assert.equal(starred.entry.node.label.startsWith('* '), true, 'the marker is label text, not a badge or extra column');
  assert.equal(f.tree.snapshot.rows.filter(row => row.entry.node.label.startsWith('* ')).length, 1);
  f.close();
});

test('pod status/readiness and IP are independent single-line information leaves, not a container tree', async () => {
  const f = await displayFixture();
  await expand(f.tree, 'active', 'Workloads', 'Pods', 'web');
  const pod = label(f.tree, 'web');
  const leaves = f.tree.snapshot.rows.filter(row => row.parent === pod.id);
  assert.deepEqual(leaves.map(row => row.entry.node.label), ['Running (1/1)', '10.0.0.12']);
  assert.ok(leaves.every(row => !row.entry.node.expandable));
  assert.equal(f.tree.snapshot.rows.some(row => row.entry.node.label === 'Containers'), false);
  f.close();
});
