import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { branchReadResponseSchema, parentFromResource } from '../../src/shared/branch-protocol.ts';
import type { BranchReadRequest } from '../../src/shared/branch-protocol.ts';
import { resourceDescriptors } from '../../src/shared/tree.ts';
import { BranchClient } from '../../src/host/branch-client.ts';
import type { BranchState } from '../../src/host/branch-client.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { createResourceReader } from '../../src/service/queries/resource-reader.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import { createResourcePager } from '../../src/service/queries/resource-pagination.ts';
import { createBranchReader } from '../../src/service/queries/branch-reader.ts';
import { kubectlReadArguments, validateResourceReadTransportRequest } from '../../src/service/queries/kubectl-plan.ts';

const signal = () => new AbortController().signal;
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;
const marker = 'SYNTHETIC_BRANCH_SECRET';
const token = 'SYNTHETIC_PRIVATE_CONTINUATION_+/=';
const parent = { resource: 'deployments', name: 'sample', namespace: 'default', uid: 'parent-uid', resourceVersion: '10' } as const;
const definition = { name: 'widgets.sample.test', uid: 'definition-uid', resourceVersion: '11' };
function object(resource: keyof typeof resourceDescriptors, extra: Record<string, unknown> = {}) {
  const type = resourceDescriptors[resource];
  return { apiVersion: type.group ? `${type.group}/${type.version}` : type.version, kind: type.kind,
    metadata: { name: 'sample', ...(type.scope === 'namespace' ? { namespace: 'default' } : {}), uid: 'parent-uid', resourceVersion: '10' }, ...extra };
}
const pod = (namespace = 'default') => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'child', namespace, uid: 'pod-uid', resourceVersion: '12' } });
const podList = (continuation = '', namespace = 'default') => ({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: '20', continue: continuation }, items: [{ metadata: pod(namespace).metadata }] });
function crd() {
  return { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { ...definition, annotations: { private: marker } },
    spec: { group: 'sample.test', scope: 'Namespaced', names: { plural: 'widgets', kind: 'Widget', listKind: 'Inventory' },
      versions: [{ name: 'v1', served: true, storage: true }, { name: 'v2', served: true, storage: false }] }, extra: marker };
}
function customReply(request: ResourceReadRequest): unknown {
  if (request.purpose === 'resource-object') return crd();
  if (request.purpose === 'custom-resource-definitions') return { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinitionList',
    metadata: { resourceVersion: '30', continue: request.query.continue ? '' : token }, items: [{ metadata: crd().metadata, spec: crd().spec }] };
  if (request.purpose === 'api-group') return { name: 'sample.test', versions: ['v1', 'v2'].map(version => ({ version, groupVersion: `sample.test/${version}` })), preferredVersion: { version: 'v2', groupVersion: 'sample.test/v2' } };
  if (request.purpose === 'api-version') return { groupVersion: 'sample.test/v2', resources: [{ name: 'widgets', namespaced: true, kind: 'Widget', verbs: ['get', 'list'] }] };
  return { apiVersion: 'sample.test/v2', kind: 'Inventory', metadata: { resourceVersion: '40', continue: request.query.continue ? '' : token },
    items: [{ metadata: { name: 'one', namespace: 'default', uid: 'widget-uid', resourceVersion: '15' }, data: { private: marker } }] };
}
async function fixture(reply: (request: ResourceReadRequest, signal: AbortSignal) => unknown | Promise<unknown>) {
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active',
    clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const parsed = await config.read({ mode: 'default' });
  const target = { serviceGeneration: 's', projectId: 'p', configIdentity: parsed.snapshot.configIdentity, context: 'active', namespace: 'default' };
  const requests: ResourceReadRequest[] = [];
  const read = async (request: ResourceReadRequest, signal: AbortSignal) => {
    validateResourceReadTransportRequest(request); // Pure route validation, no adapter imported.
    requests.push(request);
    const body = JSON.stringify(await reply(request, signal));
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(body); } }, close: async () => {} };
  };
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: (_selection, request, signal) => read(request, signal) });
  const base = { protocol: 2 as const, selection: { mode: 'default' as const }, target };
  return { gateway, requests, base, read };
}

test('workload children use server selectors between two fresh parent GETs, with immutable whitelisted rows', async () => {
  const f = await fixture(request => request.purpose === 'resource-object' ? object('deployments', { spec: { selector: { matchLabels: { app: 'one' }, matchExpressions: [{ key: 'tier', operator: 'Exists' }] }, template: marker } }) : podList());
  assert.equal(f.requests.length, 0);
  const result = await f.gateway.readTree({ ...f.base, kind: 'children', parent }, signal());
  assert.equal(result.kind, 'children'); assert.equal(result.nodes.length, 1);
  assert.deepEqual(f.requests.map(request => request.purpose), ['resource-object', 'resource-list', 'resource-object']);
  assert.equal(f.requests[1]?.query.labelSelector, 'app=one,tier');
  assert.equal(Object.isFrozen(result.nodes), true); assert.equal(JSON.stringify(result).includes(marker), false);
  f.gateway.close();
});

test('gateway accepts raw Namespace, Node and Deployment lists without item TypeMeta, one bounded GET per page', async () => {
  for (const resource of ['namespaces', 'nodes', 'deployments'] as const) {
    const type = resourceDescriptors[resource], apiVersion = type.group ? `${type.group}/${type.version}` : type.version;
    const f = await fixture(() => ({ apiVersion, kind: `${type.kind}List`, metadata: { resourceVersion: 'list-rv' },
      items: [{ metadata: object(resource).metadata, spec: { private: marker } }] }));
    try {
      const page = await f.gateway.read({ ...f.base, resource }, signal());
      assert.equal(page.nodes.length, 1);
      assert.equal(page.nodes[0]?.resource?.kind, type.kind);
      assert.equal(page.nodes[0]?.resource?.uid, 'parent-uid');
      assert.equal(page.nodes[0]?.resource?.namespace, type.scope === 'namespace' ? 'default' : undefined);
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0]?.purpose, 'resource-list');
      assert.deepEqual(f.requests[0]?.query, { limit: '100' });
      assert.equal(JSON.stringify(page).includes(marker), false);
    } finally { f.gateway.close(); }
  }
});

test('empty Service selectors perform both parent checks but never list every Pod; malformed selectors fail fixed', async () => {
  for (const selector of [{}, { app: 'one' }, { app: 'bad,value' }]) {
    const f = await fixture(request => request.purpose === 'resource-object' ? object('services', { spec: { selector } }) : podList());
    const read = f.gateway.readTree({ ...f.base, kind: 'children', parent: { ...parent, resource: 'services' } }, signal());
    if (selector.app === 'bad,value') await assert.rejects(read, fails('SELECTOR_INVALID'));
    else {
      const result = await read;
      assert.equal(result.nodes.length, selector.app ? 1 : 0);
      assert.equal(f.requests.filter(request => request.purpose === 'resource-list').length, selector.app ? 1 : 0);
      if (!selector.app) { assert.equal(result.resourceVersion, null); assert.equal(result.nextCursor, null); }
    }
    f.gateway.close();
  }
});

test('same-name parent replacement or resourceVersion change after list invalidates the whole page', async () => {
  for (const change of [{ uid: 'recreated' }, { resourceVersion: 'changed' }]) {
    let gets = 0;
    const f = await fixture(request => {
      if (request.purpose !== 'resource-object') return podList();
      const value = object('deployments', { spec: { selector: { matchLabels: { app: 'one' } } } });
      if (++gets === 2) Object.assign(value.metadata, change);
      return value;
    });
    await assert.rejects(f.gateway.readTree({ ...f.base, kind: 'children', parent }, signal()), fails('STALE_TARGET'));
    assert.equal(gets, 2); f.gateway.close();
  }
});

test('Node Pods list across namespaces, and their explicit Pod reference can expand information outside selected namespace', async () => {
  const f = await fixture(request => request.purpose !== 'resource-object' ? podList('', 'other') : request.path.endsWith('/child')
    ? { ...pod('other'), status: { phase: 'Running', podIP: '10.0.0.1', containerStatuses: [{ ready: true }] } } : object('nodes'));
  const page = await f.gateway.readTree({ ...f.base, kind: 'children', parent: { resource: 'nodes', name: 'sample', uid: parent.uid, resourceVersion: parent.resourceVersion } }, signal());
  assert.equal(f.requests[1]?.path, '/api/v1/pods'); assert.equal(f.requests[1]?.query.fieldSelector, 'spec.nodeName=sample');
  const reference = parentFromResource(page.nodes[0]); assert.ok(reference); assert.equal(reference.namespace, 'other');
  const info = await f.gateway.readTree({ ...f.base, kind: 'children', parent: reference }, signal());
  assert.deepEqual(info.nodes.map(node => node.label), ['Running (1/1)', '10.0.0.1']);
  await assert.rejects(f.gateway.readTree({ ...f.base, kind: 'children', parent: { ...parent, namespace: 'other' } }, signal()), fails('STALE_TARGET'));
  f.gateway.close();
});

test('Pod information missing status is explicit, never a fabricated healthy status; no cursor accepted', async () => {
  const f = await fixture(() => object('pods'));
  const request = { ...f.base, kind: 'children', parent: { ...parent, resource: 'pods' } };
  const page = await f.gateway.readTree(request, signal());
  assert.deepEqual(page.nodes.map(node => node.label), ['STATE_UNAVAILABLE']); assert.equal(page.nextCursor, null);
  await assert.rejects(f.gateway.readTree({ ...request, cursor: 'bad' }, signal()), fails('INVALID_INPUT')); f.gateway.close();
});

test('configuration keys page in Object.keys order with opaque offsets and without Secret values or metadata', async () => {
  const data = Object.fromEntries(Array.from({ length: 205 }, (_, index) => [`key-${index}`, Buffer.from(marker).toString('base64')]));
  const f = await fixture(() => object('secrets', { data, stringData: { private: marker }, unknown: marker, type: 'Opaque' }));
  const states: BranchState[] = [];
  const client = new BranchClient(async request => ({ status: 200, body: JSON.stringify(await f.gateway.readTree(JSON.parse(request.body) as unknown, signal())) }), state => states.push(state));
  const binding = { ...f.base, kind: 'children', parent: { ...parent, resource: 'secrets' } };
  await client.read(binding); assert.equal(states.at(-1)?.phase, 'ready'); assert.ok(states.at(-1)?.page?.nextCursor);
  assert.equal(states.at(-1)?.page?.nodes.length, 100); await client.next(); assert.equal(states.at(-1)?.page?.nodes[0]?.label, 'key-100');
  await client.next(); assert.equal(states.at(-1)?.page?.nodes.length, 5); assert.equal(states.at(-1)?.page?.nextCursor, null);
  for (const unsafe of [marker, Buffer.from(marker).toString('base64'), 'stringData', 'unknown']) assert.equal(JSON.stringify(states).includes(unsafe), false);
  assert.equal(f.requests.length, 6); client.dispose(); f.gateway.close();
});

test('key cursors reject same-RV order mutation, changed parent references and forged/cross-service tokens', async () => {
  let keys = Array.from({ length: 101 }, (_, index) => `key-${index}`);
  const f = await fixture(() => object('configmaps', { data: Object.fromEntries(keys.map(key => [key, marker])) }));
  const request = { ...f.base, kind: 'children', parent: { ...parent, resource: 'configmaps' } };
  const first = await f.gateway.readTree(request, signal()); assert.ok(first.nextCursor);
  for (const cursor of ['bad', `${first.nextCursor}x`]) await assert.rejects(f.gateway.readTree({ ...request, cursor }, signal()), fails('STALE_TARGET'));
  await assert.rejects(f.gateway.readTree({ ...request, parent: { ...request.parent, uid: 'new' }, cursor: first.nextCursor }, signal()), fails('STALE_TARGET'));
  keys = keys.toReversed();
  await assert.rejects(f.gateway.readTree({ ...request, cursor: first.nextCursor }, signal()), fails('STALE_TARGET'));
  f.gateway.close();
});

test('parent-bound Pod pagination cannot cross parents, selectors, list RVs or upstream continued token replay', async () => {
  const f = await fixture(request => request.purpose === 'resource-object' ? object('deployments', { spec: { selector: { matchLabels: { app: 'one' } } } }) : podList(request.query.continue ? '' : token));
  const request = { ...f.base, kind: 'children', parent };
  const first = await f.gateway.readTree(request, signal()); assert.ok(first.nextCursor); assert.equal(JSON.stringify(first).includes(token), false);
  await assert.rejects(f.gateway.readTree({ ...request, parent: { ...parent, uid: 'new' }, cursor: first.nextCursor }, signal()), fails('STALE_TARGET'));
  const next = await f.gateway.readTree({ ...request, cursor: first.nextCursor }, signal()); assert.equal(next.nextCursor, null);
  assert.equal(f.requests.filter(request => request.purpose === 'resource-list')[1]?.query.continue, token); f.gateway.close();
});

test('CRD types expose only plural labels and stable references; encrypted definition paging preserves snapshot', async () => {
  const f = await fixture(customReply), request = { ...f.base, kind: 'custom-types' };
  const first = await f.gateway.readTree(request, signal()); assert.equal(first.kind, 'custom-types'); assert.ok(first.nextCursor);
  assert.equal(first.nodes[0]?.label, 'widgets');
  for (const unsafe of [marker, token, 'versions', 'annotations', 'spec']) assert.equal(JSON.stringify(first).includes(unsafe), false);
  const next = await f.gateway.readTree({ ...request, cursor: first.nextCursor }, signal()); assert.equal(next.nextCursor, null);
  assert.equal(f.requests[1]?.query.continue, token); f.gateway.close();
});

test('dynamic CRD instances resolve preferred served discovery GVR/listKind and freshly recheck the definition on every page', async () => {
  const f = await fixture(customReply), states: BranchState[] = [];
  const client = new BranchClient(async request => {
    assert.equal(request.path, '/v2/tree/read');
    return { status: 200, body: JSON.stringify(await f.gateway.readTree(JSON.parse(request.body) as unknown, signal())) };
  }, state => states.push(state));
  await client.read({ ...f.base, kind: 'custom-resources', definition }); assert.equal(states.at(-1)?.phase, 'ready');
  const page = states.at(-1)?.page; assert.ok(page?.kind === 'custom-resources'); assert.equal(page.resourceType.version, 'v2'); assert.equal(page.listKind, 'Inventory');
  assert.equal(f.requests[3]?.path, '/apis/sample.test/v2/namespaces/default/widgets');
  await client.next(); assert.equal(states.at(-1)?.phase, 'ready'); assert.equal(f.requests.length, 10);
  assert.equal(JSON.stringify(states).includes(marker), false); client.dispose(); f.gateway.close();
});

test('oversized CRD definition and instance lists fit with metadata negotiation; exact proof and pagination remain', async () => {
  const partial = (resourceVersion: string, more: boolean, metadata: unknown) => ({ apiVersion: 'meta.k8s.io/v1',
    kind: 'PartialObjectMetadataList', metadata: { resourceVersion, ...(more ? { continue: token } : {}) }, items: [{ metadata }] });
  const f = await fixture(request => {
    const more = !request.query.continue;
    if (request.purpose === 'custom-resource-definitions') {
      assert.equal(request.representation, 'metadata-preferred');
      return partial('30', more, { ...definition, ...(more ? {} : { name: 'other.sample.test', uid: 'other' }), annotations: { private: marker } });
    }
    if (request.purpose === 'resource-list') {
      assert.equal(request.representation, 'metadata-preferred');
      assert.deepEqual(request.customList?.definition, definition);
      assert.equal(request.path, '/apis/sample.test/v2/namespaces/default/widgets');
      return partial('40', more, { name: more ? 'first' : 'second', namespace: 'default', uid: more ? 'u1' : 'u2', resourceVersion: '15' });
    }
    assert.equal(request.representation, undefined);
    return customReply(request);
  });
  try {
    const types = { ...f.base, kind: 'custom-types' };
    const first = await f.gateway.readTree(types, signal());
    assert.ok(first.kind === 'custom-types' && first.nextCursor);
    assert.deepEqual(first.nodes[0]?.definition, definition);
    assert.equal(JSON.stringify(first).includes(marker), false);
    assert.equal(JSON.stringify(first).includes(token), false);
    assert.equal((await f.gateway.readTree({ ...types, cursor: first.nextCursor }, signal())).nodes[0]?.label, 'other');
    const list = { ...f.base, kind: 'custom-resources', definition: first.nodes[0]!.definition };
    const page = await f.gateway.readTree(list, signal());
    assert.ok(page.kind === 'custom-resources' && page.nextCursor);
    assert.equal(page.listKind, 'Inventory');
    assert.equal(page.resourceVersion, '40');
    assert.deepEqual(f.requests.slice(2).map(r => r.purpose), ['resource-object', 'api-group', 'api-version', 'resource-list', 'resource-object']);
    const next = await f.gateway.readTree({ ...list, cursor: page.nextCursor }, signal());
    assert.ok(next.kind === 'custom-resources' && next.nextCursor === null);
    assert.equal(next.nodes[0]?.resource.uid, 'u2');
    assert.equal(next.nodes[0]?.resource.resourceVersion, '15');
    for (const purpose of ['custom-resource-definitions', 'resource-list']) {
      assert.deepEqual(f.requests.filter(r => r.purpose === purpose).map(r => r.query), [{ limit: '100' }, { limit: '100', continue: token }]);
    }
  } finally { f.gateway.close(); }
});

test('full JSON fallback keeps the same byte cap and distinguishes CRD list, a single CRD, and instance list failures', async () => {
  const large = 'x'.repeat(700_000);
  for (const [purpose, code, count] of [
    ['custom-resource-definitions', 'CRD_LIST_BUDGET_EXCEEDED', 1],
    ['resource-object', 'CRD_OBJECT_BUDGET_EXCEEDED', 1],
    ['resource-list', 'CUSTOM_LIST_BUDGET_EXCEEDED', 4],
  ] as const) {
    const f = await fixture(request => {
      const result = customReply(request);
      if (request.purpose !== purpose) return result;
      if (purpose === 'resource-object') return { ...crd(), spec: { ...crd().spec, schema: large.repeat(3) } };
      const page = result as { items: object[] };
      return { ...page, items: Array.from({ length: 3 }, () => ({ ...page.items[0], data: { large } })) };
    });
    try {
      await assert.rejects(f.gateway.readTree({ ...f.base, ...(purpose === 'custom-resource-definitions'
        ? { kind: 'custom-types' } : { kind: 'custom-resources', definition }) }, signal()), fails(code));
      assert.equal(f.requests.at(-1)?.purpose, purpose);
      assert.equal(f.requests.length, count);
      assert.equal(f.requests.at(-1)?.maximumBytes, 2_000_000);
    } finally { f.gateway.close(); }
  }
});

test('CRD deletion/recreation or served-version changes between list and post-check reject a complete instance page', async () => {
  for (const change of ['uid', 'version', 'same-rv-spec'] as const) {
    let reads = 0;
    const f = await fixture(request => {
      if (request.purpose !== 'resource-object') return customReply(request);
      const value = crd();
      if (++reads === 2) {
        if (change === 'uid') value.metadata.uid = 'recreated';
        else if (change === 'version') value.metadata.resourceVersion = 'changed';
        else value.spec.scope = 'Cluster';
      }
      return value;
    });
    await assert.rejects(f.gateway.readTree({ ...f.base, kind: 'custom-resources', definition }, signal()), fails('STALE_TARGET')); assert.equal(reads, 2); f.gateway.close();
  }
});

test('a legitimate long CRD UID and RV do not overflow scheduler key element budgets', async () => {
  const reference = { ...definition, uid: 'u'.repeat(1000), resourceVersion: 'r'.repeat(1000) };
  const f = await fixture(request => request.purpose === 'resource-object' ? { ...crd(), metadata: reference } : customReply(request));
  const page = await f.gateway.readTree({ ...f.base, kind: 'custom-resources', definition: reference }, signal()); assert.equal(page.nodes.length, 1); f.gateway.close();
});

test('branch expiry is fixed across pages, tampering is rejected, and disposed readers never use a transport', async () => {
  const f = await fixture(customReply);
  const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => target, read: f.read });
  let clock = 0;
  const pager = createResourcePager(reader, () => clock), branches = createBranchReader(reader, pager, () => clock);
  const request = { ...f.base, kind: 'custom-types' };
  const first = await branches.read(request, signal()); assert.ok(first.nextCursor);
  clock = 60_000; await assert.rejects(branches.read({ ...request, cursor: first.nextCursor }, signal()), fails('CONTINUATION_EXPIRED'));
  const count = f.requests.length; branches.dispose(); await assert.rejects(branches.read(request, signal()), fails('SERVICE_CLOSED')); assert.equal(f.requests.length, count);
  pager.dispose(); reader.close(); f.gateway.close();
});

test('schema and process whitelist reject arbitrary subresources, query, authentication, URL and unsupported parent input', async () => {
  const f = await fixture(() => ({})), request = { ...f.base, kind: 'children', parent };
  for (const input of [{ ...request, command: marker }, { ...request, parent: { ...parent, resource: 'cronjobs' } }, { ...request, parent: { ...parent, name: 'sample/exec' } }, { ...request, data: marker }]) {
    await assert.rejects(f.gateway.readTree(input, signal()), fails('INVALID_INPUT'));
  }
  assert.equal(f.requests.length, 0);
  const base = { method: 'GET', target: f.base.target, purpose: 'resource-object', maximumBytes: 2_000_000, query: {} } as const;
  for (const path of ['/api/v1/namespaces/default/pods/one/exec', '/apis/evil.test/v1/resources/one', '/api/v1/namespaces/other/secrets/one', '/api/v1/pods/one?watch=true']) {
    assert.throws(() => kubectlReadArguments({ ...base, path }, '/owned/pipe'), fails('INVALID_INPUT'));
  }
  assert.throws(() => kubectlReadArguments({ ...base, path: '/api/v1/namespaces/default/pods/one', query: { watch: 'true' } }, '/owned/pipe'), fails('INVALID_INPUT'));
  f.gateway.close();
});

test('branch client rejects wrong references, node IDs/namespaces, duplicate nodes and sensitive response extensions', async () => {
  const f = await fixture(() => object('secrets', { data: { one: marker } }));
  const binding: BranchReadRequest = { ...f.base, kind: 'children', parent: { ...parent, resource: 'secrets' } };
  const page = await f.gateway.readTree(binding, signal()); assert.equal(page.kind, 'children');
  const mutated = branchReadResponseSchema.parse(page); assert.ok(mutated.kind === 'children'); mutated.parent.uid = 'wrong';
  const wrongNode = branchReadResponseSchema.parse(page); const node = wrongNode.nodes[0]; assert.ok(node?.type === 'config-key'); node.resource.namespace = 'other';
  for (const value of [mutated, wrongNode, { ...page, nodes: [...page.nodes, ...page.nodes] }, { ...page, data: marker }, { ...page, nodes: page.nodes.map(node => ({ ...node, stringData: marker })) }]) {
    const states: BranchState[] = [], client = new BranchClient(async () => ({ status: 200, body: JSON.stringify(value) }), state => states.push(state));
    await client.read(binding); assert.equal(states.at(-1)?.phase, 'error'); assert.equal(states.at(-1)?.page, undefined); assert.equal(JSON.stringify(states).includes(marker), false); client.dispose();
  }
  f.gateway.close();
});

test('branch client resets/cancels/disposes late delivery and never treats raw server diagnostics as visible errors', async () => {
  const f = await fixture(customReply), binding = { ...f.base, kind: 'custom-types' }, page = await f.gateway.readTree(binding, signal());
  for (const operation of ['reset', 'cancel', 'dispose'] as const) {
    let release: (() => void) | undefined;
    const states: BranchState[] = [], client = new BranchClient(async () => { await new Promise<void>(resolve => { release = resolve; }); return { status: 200, body: JSON.stringify(page) }; }, state => states.push(state));
    const pending = client.read(binding); client[operation](); release?.(); await pending;
    assert.equal(states.some(state => state.phase === 'ready'), false); client.dispose();
  }
  const states: BranchState[] = [], client = new BranchClient(async () => ({ status: 500, body: marker }), state => states.push(state));
  await client.read(binding); assert.equal(states.at(-1)?.error, 'STATE_UNAVAILABLE'); assert.equal(JSON.stringify(states).includes(marker), false); client.dispose(); f.gateway.close();
});

test('mixed resource/branch consumers share one global pool of two, and cancelling a duplicate does not cancel its peer', async () => {
  let active = 0, maximum = 0, arrivals = 0, release: (() => void) | undefined, started: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), two = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(async request => {
    active++; maximum = Math.max(maximum, active);
    if (++arrivals === 2) started?.();
    await gate; active--;
    if (request.purpose === 'resource-object') return object('deployments', { spec: { selector: { matchLabels: { app: 'one' } } } });
    return request.path.endsWith('/secrets') ? { apiVersion: 'v1', kind: 'SecretList', metadata: { resourceVersion: '20' }, items: [object('secrets')] } : podList();
  });
  const controller = new AbortController(), request = { ...f.base, kind: 'children', parent };
  const a = f.gateway.read({ ...f.base, resource: 'pods' }, signal()), b = f.gateway.readTree(request, signal());
  const cancelled = assert.rejects(f.gateway.readTree(request, controller.signal), fails('QUERY_CANCELLED'));
  const c = f.gateway.read({ ...f.base, resource: 'secrets' }, signal());
  await two; assert.equal(f.requests.length, 2); controller.abort(); await cancelled;
  release?.(); await Promise.all([a, b, c]);
  assert.equal(maximum, 2); assert.equal(f.requests.length, 5); f.gateway.close();
});

test('every parent check is a fresh GET even when another identical object check is already in flight', async () => {
  const f = await fixture(() => object('pods'));
  const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => target, read: f.read });
  await Promise.all([reader.parent({ target: f.base.target, parent: { ...parent, resource: 'pods' } }), reader.parent({ target: f.base.target, parent: { ...parent, resource: 'pods' } })]);
  assert.equal(f.requests.length, 2); reader.close(); f.gateway.close();
});

test('CRD discovery tries at most eight served versions and reports a budget error rather than a silently empty type', async () => {
  const versions = Array.from({ length: 9 }, (_, index) => `v${index + 1}`);
  const f = await fixture(request => {
    if (request.purpose === 'resource-object') return { ...crd(), spec: { ...crd().spec, versions: versions.map((name, index) => ({ name, served: true, storage: index === 0 })) } };
    if (request.purpose === 'api-group') return { name: 'sample.test', preferredVersion: { version: 'v1', groupVersion: 'sample.test/v1' }, versions: versions.map(version => ({ version, groupVersion: `sample.test/${version}` })) };
    return { groupVersion: request.path.slice('/apis/'.length), resources: [] };
  });
  await assert.rejects(f.gateway.readTree({ ...f.base, kind: 'custom-resources', definition }, signal()), fails('QUERY_LIMIT'));
  assert.equal(f.requests.filter(request => request.purpose === 'api-version').length, 8); f.gateway.close();
});

test('a continued Pod page whose parent post-check crosses the original expiry cannot renew its lifetime', async () => {
  let clock = 0, parents = 0;
  const f = await fixture(request => {
    if (request.purpose !== 'resource-object') return podList(request.query.continue ? '' : token);
    if (++parents === 4) clock = 60_001;
    return object('deployments', { spec: { selector: { matchLabels: { app: 'one' } } } });
  });
  const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => target, read: f.read });
  const pager = createResourcePager(reader, () => clock), branches = createBranchReader(reader, pager, () => clock);
  const request = { ...f.base, kind: 'children', parent };
  const first = await branches.read(request, signal()); assert.ok(first.nextCursor); clock = 59_000;
  await assert.rejects(branches.read({ ...request, cursor: first.nextCursor }, signal()), fails('CONTINUATION_EXPIRED'));
  branches.dispose(); pager.dispose(); reader.close(); f.gateway.close();
});

test('upstream permission, missing parent, expired snapshot and limit errors are not empty success or raw body echoes', async () => {
  for (const [status, code] of [[403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [410, 'CONTINUATION_EXPIRED'], [429, 'QUERY_LIMIT']] as const) {
    const f = await fixture(() => ({})); let iterated = false;
    const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => target,
      read: async () => ({ status, body: { async *[Symbol.asyncIterator]() { iterated = true; yield Buffer.from(marker); } }, close: async () => {} }) });
    const pager = createResourcePager(reader), branches = createBranchReader(reader, pager);
    await assert.rejects(branches.read({ ...f.base, kind: 'children', parent }, signal()), fails(code)); assert.equal(iterated, false);
    branches.dispose(); pager.dispose(); reader.close(); f.gateway.close();
  }
});

test('no stable UID/RV or a custom type mimicking a builtin never manufactures an expandable parent reference', async () => {
  const f = await fixture(() => podList());
  const page = await f.gateway.read({ ...f.base, resource: 'pods' }, signal()); const node = page.nodes[0]; assert.ok(node);
  assert.ok(parentFromResource(node));
  assert.equal(parentFromResource({ ...node, resource: { ...node.resource, uid: undefined } }), null);
  assert.equal(parentFromResource({ ...node, resource: { ...node.resource, resourceVersion: undefined } }), null);
  assert.equal(parentFromResource({ ...node, resource: { ...node.resource, group: 'other.test' } }), null); f.gateway.close();
});

test('branch client preserves stale results after fixed errors and disables further paging until an explicit retry', async () => {
  const f = await fixture(customReply), binding = { ...f.base, kind: 'custom-types' }, page = await f.gateway.readTree(binding, signal());
  let calls = 0; const states: BranchState[] = [];
  const client = new BranchClient(async () => ++calls === 1 ? { status: 200, body: JSON.stringify(page) } : { status: 403, body: JSON.stringify({ error: { code: 'FORBIDDEN' } }) }, state => states.push(state));
  await client.read(binding); await client.next(); assert.equal(states.at(-1)?.stale, true); assert.equal(states.at(-1)?.error, 'FORBIDDEN');
  await client.next(); assert.equal(calls, 2); client.dispose(); f.gateway.close();
});

test('cluster-scoped custom Secrets use complete GVR, omit namespace, and never gain builtin expansion or leak values', async () => {
  const reference = { ...definition, name: 'secrets.sample.test' };
  const f = await fixture(request => {
    if (request.purpose === 'resource-object') return { ...crd(), metadata: reference, spec: { ...crd().spec, scope: 'Cluster', names: { plural: 'secrets', kind: 'Secret', listKind: 'Inventory' } } };
    if (request.purpose === 'api-group') return customReply(request);
    if (request.purpose === 'api-version') return { groupVersion: 'sample.test/v2', resources: [{ name: 'secrets', namespaced: false, kind: 'Secret', verbs: ['list'] }] };
    return { apiVersion: 'sample.test/v2', kind: 'Inventory', metadata: { resourceVersion: '40' }, items: [{ apiVersion: 'sample.test/v2', kind: 'Secret',
      metadata: { name: 'one', uid: 'one-uid', resourceVersion: '45' }, data: { secret: marker }, stringData: { secret: marker } }] };
  });
  const states: BranchState[] = [], client = new BranchClient(async request => ({ status: 200, body: JSON.stringify(await f.gateway.readTree(JSON.parse(request.body) as unknown, signal())) }), state => states.push(state));
  await client.read({ ...f.base, kind: 'custom-resources', definition: reference });
  assert.equal(states.at(-1)?.phase, 'ready'); assert.equal(f.requests[3]?.path, '/apis/sample.test/v2/secrets');
  const node = states.at(-1)?.page?.nodes[0]; assert.ok(node?.type === 'resource'); assert.equal(node.expandable, false); assert.equal(parentFromResource(node), null);
  assert.equal(JSON.stringify(states).includes(marker), false); client.dispose(); f.gateway.close();
});

test('unserved preferred versions are skipped; served versions without LIST-able plural cannot appear as an empty collection', async () => {
  const f = await fixture(request => {
    if (request.purpose === 'resource-object') return { ...crd(), spec: { ...crd().spec, versions: [{ name: 'v1', served: true, storage: true }, { name: 'v2', served: false, storage: false }] } };
    if (request.purpose === 'api-version') return { groupVersion: 'sample.test/v1', resources: [] };
    return customReply(request);
  });
  await assert.rejects(f.gateway.readTree({ ...f.base, kind: 'custom-resources', definition }, signal()), fails('NOT_FOUND'));
  assert.deepEqual(f.requests.filter(request => request.purpose === 'api-version').map(request => request.path), ['/apis/sample.test/v1']);
  assert.equal(f.requests.some(request => request.purpose === 'resource-list'), false); f.gateway.close();
});

test('aborted or closed branch gateways cannot issue a parent read or deliver a new page', async () => {
  const f = await fixture(() => object('pods')), controller = new AbortController(); controller.abort();
  await assert.rejects(f.gateway.readTree({ ...f.base, kind: 'children', parent: { ...parent, resource: 'pods' } }, controller.signal), fails('QUERY_CANCELLED'));
  assert.equal(f.requests.length, 0); f.gateway.close();
  await assert.rejects(f.gateway.readTree({ ...f.base, kind: 'custom-types' }, signal()), fails('SERVICE_CLOSED')); assert.equal(f.requests.length, 0);
});
