import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { readTarget, resourceTypeSchema } from '../../src/shared/identity.ts';
import { parseConfigPageQuery, projectConfigPage } from '../../src/service/queries/config-page.ts';
import { apiDiscoveryPath, planResourceList, projectDiscovery, projectResourcePage } from '../../src/service/queries/resource-query.ts';
import { resourceDescriptors } from '../../src/shared/tree.ts';
import { metadataListAccept, validateMetadataListRead } from '../../src/service/queries/resource-list-representation.ts';

const code = (expected: string) => (error: unknown) => error instanceof BoundaryError && error.code === expected && error.message === expected;
const target = readTarget({ serviceGeneration: 'service-1', projectId: 'project-1', configIdentity: 'config-1', context: 'context-1', namespace: 'default' });
const pods = { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' };
const secretType = { ...pods, resource: 'secrets', kind: 'Secret' };
const custom = { group: 'one.example.com', version: 'v1beta1', resource: 'widgets', kind: 'Widget', scope: 'cluster' };
const marker = 'SYNTHETIC_SENSITIVE_VALUE';
const encoded = Buffer.from(marker).toString('base64');
const metadataType = ({ group, version, resource, kind, scope }: (typeof resourceDescriptors)[keyof typeof resourceDescriptors]) => ({ group, version, resource, kind, scope });

function plan(type: unknown = pods, extras: Record<string, unknown> = {}) {
  const result = planResourceList({ target, type, ...extras });
  assert.equal(result.kind, 'list');
  if (result.kind !== 'list') throw new Error('Expected list plan');
  return result;
}

function page(kind = 'Pod', version = 'v1', namespace: string | null = 'default', extras = {}) {
  return JSON.stringify({ apiVersion: version, kind: `${kind}List`, metadata: { resourceVersion: '10', continue: '' }, items: [
    { metadata: { name: 'sample', uid: 'uid-1', resourceVersion: '8', ...(namespace ? { namespace } : {}), annotations: { private: marker } }, ...extras },
  ] });
}

test('discovery distinguishes core/group paths and projects complete GVR/scope, not shortNames', () => {
  assert.equal(apiDiscoveryPath('', 'v1'), '/api/v1');
  assert.equal(apiDiscoveryPath('apps', 'v1'), '/apis/apps/v1');
  const types = projectDiscovery({ groupVersion: 'example.com/v1beta1', unsafe: marker, resources: [
    { name: 'widgets', kind: 'Widget', namespaced: false, verbs: ['get', 'list'], shortNames: ['w'], extension: marker },
    { name: 'widgets/status', kind: 'Widget', namespaced: false, verbs: ['get', 'update'] },
    { name: 'widgets/exec', kind: 'Widget', namespaced: false, verbs: ['create'] },
    { name: 'readonce', kind: 'ReadOnce', namespaced: true, verbs: ['get'] },
  ] });
  assert.deepEqual(types, [{ group: 'example.com', version: 'v1beta1', resource: 'widgets', kind: 'Widget', scope: 'cluster' }]);
  assert.equal(JSON.stringify(types).includes(marker), false);
  assert.ok(Object.isFrozen(types) && Object.isFrozen(types[0]));
});

test('discovery rejects invalid/duplicate resource identities; invalid group segments cannot become URLs', () => {
  for (const group of ['..', 'a..com', '-bad.example', 'a/b', 'https://example.com', 'a%2fb']) {
    assert.throws(() => apiDiscoveryPath(group, 'v1'), code('INVALID_INPUT'));
    assert.equal(resourceTypeSchema.safeParse({ ...custom, group }).success, false);
  }
  for (const resource of ['..', 'widgets/status', 'pods?watch=true', '-pods']) assert.throws(() => plan({ ...pods, resource }), code('INVALID_INPUT'));
  const entry = { name: 'widgets', kind: 'Widget', namespaced: true, verbs: ['list'] };
  assert.throws(() => projectDiscovery({ groupVersion: 'example.com/v1', resources: [entry, entry] }), code('RESOURCE_INVALID'));
  assert.throws(() => projectDiscovery({ groupVersion: '/v1', resources: [] }), code('RESOURCE_INVALID'));
});

test('resource plans bind selected namespace and cluster scope; same plural in other group has a different key/path', () => {
  assert.equal(plan().path, '/api/v1/namespaces/default/pods');
  assert.deepEqual(plan().query, { limit: '100' });
  assert.equal(plan(custom).path, '/apis/one.example.com/v1beta1/widgets');
  const second = plan({ ...custom, group: 'two.example.com' });
  assert.notDeepEqual(plan(custom).key, second.key);
  assert.equal(second.path, '/apis/two.example.com/v1beta1/widgets');
  for (const field of ['serviceGeneration', 'projectId', 'configIdentity', 'context', 'namespace']) {
    const next = plan(pods, { target: { ...target, [field]: 'other' } });
    assert.notDeepEqual(next.key, plan().key);
  }
  assert.notDeepEqual(plan().key, plan(pods, { limit: 50 }).key);
});

test('only Node Pods can use all namespaces; node/selector filters never route to arbitrary resources', () => {
  const node = plan(pods, { namespaces: 'all', filter: { kind: 'node', name: 'node-a' } });
  assert.equal(node.path, '/api/v1/pods');
  assert.deepEqual(node.query, { limit: '100', fieldSelector: 'spec.nodeName=node-a' });
  for (const input of [
    { namespaces: 'all' }, { namespaces: 'all', filter: { kind: 'selector', source: 'service', selector: { app: 'demo' } } },
    { type: custom, filter: { kind: 'node', name: 'node-a' } }, { filter: { kind: 'node', name: 'node,a' } },
  ]) assert.throws(() => plan(pods, input), code('INVALID_INPUT'));
});

test('selector plan supports workload expressions and an empty selector never yields an unfiltered list', () => {
  const empty = planResourceList({ target, type: pods, filter: { kind: 'selector', source: 'service', selector: {} } });
  assert.equal(empty.kind, 'empty');
  assert.equal('path' in empty, false);
  const selected = plan(pods, { filter: { kind: 'selector', source: 'workload', selector: { matchExpressions: [{ key: 'app', operator: 'In', values: ['demo'] }] } } });
  assert.equal(selected.query.labelSelector, 'app in (demo)');
  assert.throws(() => plan(pods, { filter: { kind: 'selector', source: 'service', selector: { app: 'bad,selector' } } }), code('SELECTOR_INVALID'));
});

test('continuation is bounded and paired with resourceVersion; no watch or arbitrary query input is accepted', () => {
  assert.throws(() => plan(pods, { continue: 'next' }), code('INVALID_INPUT'));
  for (const extras of [{ limit: 101 }, { limit: 0 }, { watch: true }, { continue: 'x'.repeat(8193), resourceVersion: '10' }, { continue: 'bad\n', resourceVersion: '10' }]) {
    assert.throws(() => plan(pods, extras), code('INVALID_INPUT'));
  }
  assert.deepEqual(plan(pods, { limit: 10, continue: 'opaque+/token=', resourceVersion: '10' }).query, { limit: '10', continue: 'opaque+/token=' });
});

test('page projection applies builtin expandability, correct identity and Secret white list before serialization', () => {
  const pod = projectResourcePage(200, page(), plan());
  assert.equal(pod.nodes[0]?.children, 'pod-info');
  assert.equal(pod.nodes[0]?.expandable, true);
  const secrets = projectResourcePage(200, page('Secret', 'v1', 'default', { data: { key: encoded }, stringData: { value: marker }, unknown: marker }), plan(secretType));
  const wire = JSON.stringify(secrets);
  for (const unsafe of [marker, encoded, 'annotations', 'stringData', 'unknown']) assert.equal(wire.includes(unsafe), false);
  assert.equal(secrets.nodes[0]?.children, 'config-keys');
  assert.equal(secrets.nodes[0]?.resource?.uid, 'uid-1');
});

test('all builtin typed lists accept omitted, partial or complete item TypeMeta', () => {
  for (const descriptor of Object.values(resourceDescriptors)) {
    const { group, version, resource, kind, scope } = descriptor;
    const apiVersion = group ? `${group}/${version}` : version;
    const type = { group, version, resource, kind, scope };
    for (const typeMeta of [{}, { apiVersion }, { kind }, { apiVersion, kind }]) {
      const input = page(kind, apiVersion, scope === 'namespace' ? 'default' : null, typeMeta);
      const result = projectResourcePage(200, input, plan(type));
      assert.equal(result.nodes.length, 1, resource);
      assert.deepEqual(result.nodes[0]?.resource, { ...type, name: 'sample', uid: 'uid-1', resourceVersion: '8', ...(scope === 'namespace' ? { namespace: 'default' } : {}) });
      assert.equal(JSON.stringify(result).includes(marker), false);
    }
  }
});

test('typed list item inheritance still rejects explicit GVK conflicts and malformed item shapes', () => {
  for (const extras of [{ apiVersion: 'apps/v1' }, { kind: 'Secret' }, { apiVersion: null }, { kind: null },
    { apiVersion: '' }, { kind: '' }, { kind: 123 }, { apiVersion: [] }]) {
    assert.throws(() => projectResourcePage(200, page('Pod', 'v1', 'default', extras), plan()), code('RESOURCE_INVALID'));
  }
  for (const item of [null, [], 'Pod', 12, {}]) {
    const input = JSON.stringify({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: '10' }, items: [item] });
    assert.throws(() => projectResourcePage(200, input, plan()), code('RESOURCE_INVALID'));
  }
});

test('omitted item TypeMeta never bypasses list envelope, namespace, identity or custom listKind checks', () => {
  const raw = JSON.parse(page()) as { apiVersion?: string; kind?: string; metadata?: unknown; items: unknown[] };
  for (const change of [{ apiVersion: undefined }, { kind: undefined }, { kind: 'List' }, { apiVersion: 'apps/v1' }, { metadata: {} }]) {
    assert.throws(() => projectResourcePage(200, JSON.stringify({ ...raw, ...change }), plan()), code('RESOURCE_INVALID'));
  }
  assert.throws(() => projectResourcePage(200, page('Pod', 'v1', null), plan()), code('RESOURCE_INVALID'));
  assert.throws(() => projectResourcePage(200, page('Pod', 'v1', 'default', { metadata: { namespace: 'default' } }), plan()), code('RESOURCE_INVALID'));
  const namespaced = { ...custom, scope: 'namespace' };
  const customPage = JSON.stringify({ apiVersion: 'one.example.com/v1beta1', kind: 'Inventory', metadata: { resourceVersion: '10' },
    items: [{ metadata: { name: 'sample', namespace: 'default', uid: 'custom-uid' } }] });
  assert.equal(projectResourcePage(200, customPage, plan(namespaced, { listKind: 'Inventory' })).nodes[0]?.resource?.kind, 'Widget');
  assert.throws(() => projectResourcePage(200, customPage, plan(namespaced)), code('RESOURCE_INVALID'));
});

test('same plural as a builtin in another group never acquires builtin state icons/namespace markers', () => {
  const customPods = { ...pods, group: 'example.com', kind: 'CustomPod' };
  const result = projectResourcePage(200, page('CustomPod', 'example.com/v1', 'default', { status: { phase: 'Running', containerStatuses: [{ ready: true }] } }), plan(customPods));
  assert.equal(result.nodes[0]?.icon, undefined);
  assert.equal(result.nodes[0]?.expandable, false);
});

test('namespace/group/kind/scope mismatches reject the complete page instead of silently dropping rows', () => {
  assert.throws(() => projectResourcePage(200, page('Pod', 'v1', 'other'), plan()), code('STALE_TARGET'));
  assert.throws(() => projectResourcePage(200, page('Widget', 'one.example.com/v1beta1', 'default'), plan(custom)), code('RESOURCE_INVALID'));
  assert.throws(() => projectResourcePage(200, page('Pod', 'wrong.example/v1'), plan()), code('RESOURCE_INVALID'));
  assert.throws(() => projectResourcePage(200, page('Secret'), plan()), code('RESOURCE_INVALID'));
  const all = plan(pods, { namespaces: 'all', filter: { kind: 'node', name: 'node-a' } });
  assert.equal(projectResourcePage(200, page('Pod', 'v1', 'other'), all).nodes[0]?.resource?.namespace, 'other');
});

test('server continuation preserves list snapshot, rejects stale/repeated tokens and permits empty intermediate pages', () => {
  const nextPlan = plan(pods, { continue: 'next', resourceVersion: '10' });
  const response = { apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: '10', continue: 'next-2' }, items: [] };
  assert.equal(projectResourcePage(200, JSON.stringify(response), nextPlan).continue, 'next-2');
  assert.throws(() => projectResourcePage(200, JSON.stringify({ ...response, metadata: { resourceVersion: '11', continue: 'next-2' } }), nextPlan), code('STALE_TARGET'));
  assert.throws(() => projectResourcePage(200, JSON.stringify({ ...response, metadata: { resourceVersion: '10', continue: 'next' } }), nextPlan), code('RESOURCE_INVALID'));
});

test('403/404/410/429 and invalid upstream bodies remain distinct fixed errors, never zero resources', () => {
  for (const [status, error] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [410, 'CONTINUATION_EXPIRED'], [429, 'QUERY_LIMIT'], [500, 'STATE_UNAVAILABLE']] as const) {
    assert.throws(() => projectResourcePage(status, marker, plan()), code(error));
  }
  assert.throws(() => projectResourcePage(200, `{"raw":"${marker}"`, plan()), code('RESOURCE_INVALID'));
  assert.throws(() => projectResourcePage(200, marker.repeat(100_000), plan()), code('BUDGET_EXCEEDED'));
});

test('resource pages reject oversized/duplicate item sets, not truncate to the requested limit', () => {
  const item = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'sample', namespace: 'default', uid: 'uid-1' } };
  const response = { apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: '10' }, items: [item, item] };
  assert.throws(() => projectResourcePage(200, JSON.stringify(response), plan()), code('RESOURCE_INVALID'));
  assert.throws(() => projectResourcePage(200, JSON.stringify(response), plan(pods, { limit: 1 })), code('RESOURCE_INVALID'));
});

test('only built-in collections that do not need spec/status use the bounded metadata representation', () => {
  assert.deepEqual(Object.entries(resourceDescriptors).filter(([, descriptor]) => !plan(metadataType(descriptor)).metadata).map(([key]) => key), ['deployments', 'pods', 'services']);
  assert.equal(plan(custom).metadata, false);
  assert.equal(plan(metadataType(resourceDescriptors.configmaps), { listKind: 'OtherList' }).metadata, false);
  assert.match(metadataListAccept, /^application\/json;as=PartialObjectMetadataList;g=meta\.k8s\.io;v=v1,/);
  const request = { method: 'GET', purpose: 'resource-list', representation: 'metadata-preferred', target, maximumBytes: 2_000_000,
    path: plan(metadataType(resourceDescriptors.configmaps)).path, query: { limit: '100', continue: 'next' } } as const;
  validateMetadataListRead(request);
  for (const change of [{ path: `${request.path}/sample` }, { path: request.path.replace('default', 'other') },
    { path: '/api/v1/namespaces/default/pods' }, { path: `/${request.path}` }, { query: { limit: '100', watch: 'true' } }, { query: { limit: '101' } }, { purpose: 'resource-object' as const }]) {
    assert.throws(() => validateMetadataListRead({ ...request, ...change }), code('INVALID_INPUT'));
  }
});

test('metadata list keeps exact versions and key-expansion identity without retaining annotations or admitting wrong scope', () => {
  const map = metadataType(resourceDescriptors.configmaps), first = plan(map);
  const identity = { name: 'sample', namespace: 'default', uid: 'uid-1', resourceVersion: '8' };
  const input = { kind: 'PartialObjectMetadataList', apiVersion: 'meta.k8s.io/v1', metadata: { resourceVersion: '10', continue: 'next' }, items: [
    { kind: 'PartialObjectMetadata', apiVersion: 'meta.k8s.io/v1', metadata: { ...identity, annotations: { original: marker } } },
  ] };
  const projected = projectResourcePage(200, JSON.stringify(input), first);
  assert.equal(projected.continue, 'next');
  assert.equal(projected.resourceVersion, '10');
  assert.deepEqual(projected.nodes[0]?.resource, { ...identity, group: '', version: 'v1', scope: 'namespace', kind: 'ConfigMap', resource: 'configmaps' });
  assert.equal(projected.nodes[0]?.children, 'config-keys');
  assert.equal(JSON.stringify(projected).includes(marker), false);
  assert.deepEqual(projectResourcePage(200, page('ConfigMap', 'v1', 'default', { data: { key: marker } }), first).nodes, projected.nodes);
  const changeItem = (item: unknown) => JSON.stringify({ ...input, items: [item] });
  for (const item of [{ metadata: { ...identity, uid: undefined } }, { metadata: { ...identity, resourceVersion: undefined } }, { kind: 'ConfigMap', metadata: identity }, { metadata: identity, data: {} }]) {
    assert.throws(() => projectResourcePage(200, changeItem(item), first), code('RESOURCE_INVALID'));
  }
  assert.throws(() => projectResourcePage(200, changeItem({ metadata: { ...identity, namespace: 'other' } }), first), code('STALE_TARGET'));
  assert.throws(() => projectResourcePage(200, JSON.stringify(input), plan()), code('RESOURCE_INVALID'));
  assert.throws(() => projectResourcePage(200, JSON.stringify({ ...input, metadata: { resourceVersion: '11' } }),
    plan(map, { continue: 'next', resourceVersion: '10' })), code('STALE_TARGET'));
});

test('metadata custom collection is limited to the exact CRD-resolved path and scope', () => {
  const request = { method: 'GET', purpose: 'resource-list', representation: 'metadata-preferred', target, maximumBytes: 2_000_000,
    path: '/apis/sample.test/v2/namespaces/default/widgets', query: { limit: '100' },
    customList: { definition: { name: 'widgets.sample.test', uid: 'u', resourceVersion: '1' },
      type: { group: 'sample.test', version: 'v2', resource: 'widgets', kind: 'Widget', scope: 'namespace' } } } as const;
  validateMetadataListRead(request);
  for (const path of [request.path + '/name', request.path + '/status', request.path.replace('/v2/', '/v1/'),
    request.path.replace('/namespaces/default', ''), request.path.replace('/default/', '/other/'), '/api/v1/namespaces/default/pods']) {
    assert.throws(() => validateMetadataListRead({ ...request, path }), code('INVALID_INPUT'));
  }
  assert.throws(() => validateMetadataListRead({ ...request, customList: { ...request.customList,
    definition: { ...request.customList.definition, name: 'other.sample.test' } } }), code('INVALID_INPUT'));
  validateMetadataListRead({ method: 'GET', purpose: 'custom-resource-definitions', representation: 'metadata-preferred',
    maximumBytes: 2_000_000, target, path: '/apis/apiextensions.k8s.io/v1/customresourcedefinitions', query: { limit: '100' } });
});

const config = {
  status: 'ready' as const,
  sources: { mode: 'default' as const, selectedCount: 1, loadedCount: 1, missingCount: 0 },
  snapshot: { configIdentity: 'config-1', currentContextMissing: false, currentContext: 'context-0', contexts: Array.from({ length: 101 }, (_, index) => ({ name: `context-${index}`, clusterName: 'c', namespace: 'default', active: index === 0, available: true,
    authentication: { methods: ['anonymous' as const], externalExecution: false, referencedFiles: false, mayUpdateCredentials: false, proxyConfigured: false, evaluated: false as const } })) },
};

test('configuration first/follow-up pages have complete bounds and coherent source identities', () => {
  const first = projectConfigPage(config, 'service-1', parseConfigPageQuery(new URLSearchParams()));
  assert.equal(first.contexts.length, 100);
  assert.equal(first.nextOffset, 100);
  const second = parseConfigPageQuery(new URLSearchParams({ offset: '100', configIdentity: 'config-1' }));
  assert.equal(projectConfigPage(config, 'service-1', second).contexts.length, 1);
  assert.equal(projectConfigPage(config, 'service-1', second).nextOffset, null);
  assert.throws(() => projectConfigPage({ ...config, snapshot: { ...config.snapshot, configIdentity: 'changed' } }, 'service-1', second), code('STALE_TARGET'));
});

test('configuration paging rejects duplicate/unknown query fields, missing identity, invalid limit/offset', () => {
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'offset=5001', 'offset=100', 'offset=1&configIdentity=', 'limit=1&limit=2', 'token=ignored']) {
    assert.throws(() => parseConfigPageQuery(new URLSearchParams(query)), code('INVALID_INPUT'));
  }
  assert.throws(() => projectConfigPage(config, 'service-1', parseConfigPageQuery(new URLSearchParams('offset=102&configIdentity=config-1'))), code('INVALID_INPUT'));
});
