import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { readResponseJson } from '../../src/service/queries/bounded-response.ts';
import type { ReadResponse } from '../../src/service/queries/bounded-response.ts';
import { customResourceFolder, projectApiGroup, projectCustomResourceDefinition, projectDefinitionPage, resolveCustomResourceType } from '../../src/service/queries/custom-resources.ts';
import { createResourceReader } from '../../src/service/queries/resource-reader.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import { readTarget } from '../../src/shared/identity.ts';
import { planResourceList } from '../../src/service/queries/resource-query.ts';
import { bindResourceTarget } from '../../src/service/queries/resource-target.ts';
import type { ConfigRead } from '../../src/service/queries/config-page.ts';
import { createResourcePager } from '../../src/service/queries/resource-pagination.ts';
import { resourceDescriptors } from '../../src/shared/tree.ts';

const fails = (expected: string) => (error: unknown) => error instanceof BoundaryError && error.code === expected && error.message === expected;
const target = readTarget({ serviceGeneration: 'service-1', projectId: 'p', configIdentity: 'config-1', context: 'c', namespace: 'default' });
const pods = { group: '', version: 'v1', resource: 'pods', scope: 'namespace', kind: 'Pod' } as const;
const marker = 'SYNTHETIC_PRIVATE_MARKER';
const signal = () => new AbortController().signal;
function response(value: unknown, status = 200, close: () => Promise<void> = async () => {}): ReadResponse {
  return { status, body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(JSON.stringify(value)); } }, close };
}
function podPage() { return { apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: '10' }, items: [
  { metadata: { name: 'one', namespace: 'default', uid: 'uid-1', annotations: { private: marker } } },
] }; }
const definition = () => ({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'widgets.example.com', uid: 'crd-1', resourceVersion: '8', annotations: { secret: marker } },
  spec: { group: 'example.com', scope: 'Namespaced', names: { plural: 'widgets', kind: 'Widget', shortNames: ['pod'], listKind: 'WidgetCollection' },
    versions: [{ name: 'v1', served: true, storage: false, schema: { marker } }, { name: 'v1beta1', served: true, storage: true }] }, status: { secret: marker } });
const group = () => ({ name: 'example.com', preferredVersion: { groupVersion: 'example.com/v1', version: 'v1' },
  versions: [{ groupVersion: 'example.com/v1beta1', version: 'v1beta1' }, { groupVersion: 'example.com/v1', version: 'v1' }] });
const type = { group: 'example.com', version: 'v1', resource: 'widgets', kind: 'Widget', scope: 'namespace' } as const;
function configuration(): ConfigRead { return { status: 'ready', sources: { mode: 'default', selectedCount: 1, loadedCount: 1, missingCount: 0 },
  snapshot: { configIdentity: target.configIdentity, currentContextMissing: false, currentContext: target.context, contexts: [
    { name: target.context, clusterName: 'cluster', namespace: 'default', active: true, available: true,
      authentication: { methods: ['anonymous'], externalExecution: false, referencedFiles: false, mayUpdateCredentials: false, proxyConfigured: false, evaluated: false } },
  ] } }; }

test('resource binding allows only the actual current configuration/context/namespace, without claiming authenticated project ownership', () => {
  assert.deepEqual(bindResourceTarget(target, configuration(), target.serviceGeneration), target);
  const other = { ...target, projectId: 'correlation-only' };
  assert.equal(bindResourceTarget(other, configuration(), target.serviceGeneration).projectId, other.projectId);
  for (const field of ['configIdentity', 'serviceGeneration', 'namespace']) assert.throws(() => bindResourceTarget({ ...target, [field]: 'other' }, configuration(), target.serviceGeneration), fails('STALE_TARGET'));
  const inactive = configuration(); const context = inactive.snapshot.contexts[0]; assert.ok(context); context.active = false;
  assert.throws(() => bindResourceTarget(target, inactive, target.serviceGeneration), fails('STALE_TARGET'));
});

test('missing files or references cannot be promoted into a connected empty resource target', () => {
  const missing = configuration(); missing.status = 'missing';
  assert.throws(() => bindResourceTarget(target, missing, target.serviceGeneration), fails('CONFIG_REFERENCE_MISSING'));
  const absent = configuration(); absent.snapshot.contexts.length = 0;
  assert.throws(() => bindResourceTarget(target, absent, target.serviceGeneration), fails('CONFIG_REFERENCE_MISSING'));
  const dangling = configuration(); dangling.snapshot.currentContextMissing = true;
  assert.throws(() => bindResourceTarget(target, dangling, target.serviceGeneration), fails('CONFIG_REFERENCE_MISSING'));
});

test('bounded response preserves split UTF-8, copies reused chunks and closes exactly its read stream', async () => {
  let closed = 0;
  const bytes = new TextEncoder().encode(JSON.stringify({ text: '中文' }));
  const body = { async *[Symbol.asyncIterator]() { const buffer = new Uint8Array(1); for (const byte of bytes) { buffer[0] = byte; yield buffer; } } };
  assert.deepEqual(await readResponseJson({ status: 200, body, close: async () => { closed++; } }, signal()), { text: '中文' });
  assert.equal(closed, 1);
});

test('byte and chunk budgets reject before buffering the entire source; failure still closes', async () => {
  let yielded = 0, closed = 0;
  const body = { async *[Symbol.asyncIterator]() { while (yielded < 100) { yielded++; yield new Uint8Array(8); } } };
  await assert.rejects(readResponseJson({ status: 200, body, close: async () => { closed++; } }, signal(), 10), fails('BUDGET_EXCEEDED'));
  assert.equal(yielded, 2); assert.equal(closed, 1);
  const empty = { async *[Symbol.asyncIterator]() { for (let count = 0; count < 5000; count++) yield new Uint8Array(); } };
  await assert.rejects(readResponseJson({ status: 200, body: empty, close: async () => {} }, signal()), fails('BUDGET_EXCEEDED'));
});

test('error bodies are never iterated, while HTTP status remains a fixed differentiated error', async () => {
  for (const [status, code] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [410, 'CONTINUATION_EXPIRED'], [429, 'QUERY_LIMIT'], [500, 'STATE_UNAVAILABLE']] as const) {
    let read = false, closed = 0;
    const body = { async *[Symbol.asyncIterator]() { read = true; yield new TextEncoder().encode(marker); } };
    await assert.rejects(readResponseJson({ status, body, close: async () => { closed++; } }, signal()), fails(code));
    assert.equal(read, false); assert.equal(closed, 1);
  }
});

test('malformed JSON/UTF-8, unknown producer failures, cancellation and close failures never expose source text', async () => {
  for (const chunk of [new TextEncoder().encode(marker), Uint8Array.from([0xff])]) {
    await assert.rejects(readResponseJson({ status: 200, body: { async *[Symbol.asyncIterator]() { yield chunk; } }, close: async () => {} }, signal()), fails('RESOURCE_INVALID'));
  }
  await assert.rejects(readResponseJson(response({}, 200, async () => { throw new Error(marker); }), signal()), fails('STATE_UNAVAILABLE'));
  let invalidClosed = 0;
  await assert.rejects(readResponseJson(response({}, 200, async () => { invalidClosed++; }), signal(), 0), fails('INVALID_INPUT'));
  assert.equal(invalidClosed, 1);
  const controller = new AbortController(); controller.abort(marker);
  let closed = false;
  await assert.rejects(readResponseJson(response({}, 200, async () => { closed = true; }), controller.signal), fails('QUERY_CANCELLED'));
  assert.equal(closed, true);
});

test('CRD descriptors keep plural/full group/scope/versions and discard schemas, shortNames, annotations and status', () => {
  const projected = projectCustomResourceDefinition(definition());
  assert.equal(projected.spec.names.plural, 'widgets');
  const encoded = JSON.stringify(projected);
  for (const unsafe of [marker, 'shortNames', 'annotations', 'schema', 'status']) assert.equal(encoded.includes(unsafe), false);
  assert.deepEqual(projectApiGroup(group()).versions, ['v1', 'v1beta1']);
});

test('CRD routing prefers a served discovery version, not storage or shortName, and retains custom listKind', () => {
  const resolved = resolveCustomResourceType(definition(), group(), [type, { ...type, version: 'v1beta1' }]);
  assert.equal(resolved.type.version, 'v1'); assert.equal(resolved.listKind, 'WidgetCollection');
  const node = customResourceFolder(resolved, target);
  assert.equal(node.label, 'widgets'); assert.equal(node.resourceType.group, 'example.com');
  const fallback = definition(); const first = fallback.spec.versions[0]; assert.ok(first); first.served = false;
  assert.equal(resolveCustomResourceType(fallback, group(), [{ ...type, version: 'v1beta1' }]).type.version, 'v1beta1');
  const recreated = definition(); recreated.metadata.uid = 'crd-2';
  assert.notEqual(customResourceFolder(resolveCustomResourceType(recreated, group(), [type]), target).id, node.id);
});

test('invalid CRD versions/storage/group/scope and absent discovery are not silently empty success', () => {
  const duplicate = definition(); const duplicateFirst = duplicate.spec.versions[0]; assert.ok(duplicateFirst); duplicate.spec.versions.push({ ...duplicateFirst });
  assert.throws(() => projectCustomResourceDefinition(duplicate), fails('RESOURCE_INVALID'));
  const storage = definition(); const storageFirst = storage.spec.versions[0]; assert.ok(storageFirst); storageFirst.storage = true;
  assert.throws(() => projectCustomResourceDefinition(storage), fails('RESOURCE_INVALID'));
  assert.throws(() => projectCustomResourceDefinition({ ...definition(), metadata: { name: 'wrong.example.com', uid: 'x', resourceVersion: '1' } }), fails('RESOURCE_INVALID'));
  assert.throws(() => resolveCustomResourceType(definition(), group(), [{ ...type, scope: 'cluster' }]), fails('STALE_TARGET'));
  assert.throws(() => resolveCustomResourceType(definition(), group(), []), fails('NOT_FOUND'));
  assert.throws(() => projectApiGroup({ ...group(), preferredVersion: { groupVersion: 'other.com/v1', version: 'v1' } }), fails('RESOURCE_INVALID'));
});

test('legal non-kube-like DNS1035 version labels route without interpreting them as stability or URL syntax', () => {
  const custom = definition();
  custom.spec.versions = [{ name: 'v1-preview', served: true, storage: true }];
  const customGroup = { name: 'example.com', versions: [{ groupVersion: 'example.com/v1-preview', version: 'v1-preview' }], preferredVersion: { groupVersion: 'example.com/v1-preview', version: 'v1-preview' } };
  const resolved = resolveCustomResourceType(custom, customGroup, [{ ...type, version: 'v1-preview' }]);
  const plan = planResourceList({ target, type: resolved.type, listKind: resolved.listKind });
  assert.ok(plan.kind === 'list'); assert.equal(plan.path, '/apis/example.com/v1-preview/namespaces/default/widgets');
  for (const version of ['1bad', '-v1', 'v1-', 'v1/exec', 'v1?watch=1', 'v1%2Fexec']) assert.throws(() => planResourceList({ target, type: { ...type, version } }), fails('INVALID_INPUT'));
});

test('CRD definition pages are bounded snapshots, preserving continuation but rejecting duplicates and old resourceVersion', () => {
  const page = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinitionList', metadata: { resourceVersion: '10', continue: 'next' }, items: [definition()] };
  assert.equal(projectDefinitionPage(page, { limit: 1, continue: '' }).continue, 'next');
  assert.throws(() => projectDefinitionPage(page, { limit: 1, continue: 'old', resourceVersion: '11' }), fails('STALE_TARGET'));
  assert.throws(() => projectDefinitionPage({ ...page, items: [definition(), definition()] }, { limit: 2, continue: '' }), fails('RESOURCE_INVALID'));
});

test('CRD list items inherit omitted TypeMeta only from a validated definition-list envelope', () => {
  const { metadata, spec } = definition();
  const item = { metadata, spec }, before = JSON.stringify(item);
  const envelope = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinitionList', metadata: { resourceVersion: '10' } };
  const request = { limit: 100, continue: '' };
  for (const typeMeta of [{}, { apiVersion: envelope.apiVersion }, { kind: 'CustomResourceDefinition' }]) {
    const result = projectDefinitionPage({ ...envelope, items: [{ ...item, ...typeMeta }] }, request);
    assert.equal(result.definitions[0]?.kind, 'CustomResourceDefinition');
    assert.equal(result.definitions[0]?.apiVersion, envelope.apiVersion);
    assert.equal(JSON.stringify(result).includes(marker), false);
  }
  assert.equal(JSON.stringify(item), before);
  for (const typeMeta of [{ apiVersion: 'v1' }, { kind: 'Pod' }, { kind: null }, { apiVersion: '' }]) {
    assert.throws(() => projectDefinitionPage({ ...envelope, items: [{ ...item, ...typeMeta }] }, request), fails('RESOURCE_INVALID'));
  }
  for (const change of [{ kind: 'List' }, { apiVersion: 'v1' }]) {
    assert.throws(() => projectDefinitionPage({ ...envelope, ...change, items: [item] }, request), fails('RESOURCE_INVALID'));
  }
  // Standalone GET/proof remains strict; no collection exists there to supply TypeMeta.
  assert.throws(() => projectCustomResourceDefinition(item), fails('RESOURCE_INVALID'));
});

test('reader is inert; validated single-page paths/limits are shared only in-flight and DTOs are immutable', async () => {
  const requests: ResourceReadRequest[] = [];
  let release: (() => void) | undefined;
  const reader = createResourceReader({ serviceGeneration: target.serviceGeneration, currentTarget: async () => target, read: async request => {
    requests.push(request); await new Promise<void>(resolve => { release = resolve; }); return response(podPage());
  } });
  assert.equal(requests.length, 0);
  const first = reader.list({ target, type: pods }), second = reader.list({ target, type: pods });
  for (let count = 0; !release && count < 20; count++) await Promise.resolve();
  assert.equal(requests.length, 1); release?.();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b); assert.equal(JSON.stringify(a).includes(marker), false);
  assert.ok(Object.isFrozen(a));
  if (a.kind === 'resources') assert.ok(Object.isFrozen(a.page.nodes) && Object.isFrozen(a.page.nodes[0]));
  assert.equal(requests[0]?.method, 'GET'); assert.equal(requests[0]?.path, '/api/v1/namespaces/default/pods');
  assert.deepEqual(requests[0]?.query, { limit: '100' });
  reader.close();
});

test('reader verifies the server snapshot both before transport and after response; active target mismatch rejects', async () => {
  let calls = 0, checks = 0;
  const reader = createResourceReader({ serviceGeneration: target.serviceGeneration,
    currentTarget: async () => (++checks === 1 ? target : { ...target, configIdentity: 'changed' }), read: async () => { calls++; return response(podPage()); } });
  await assert.rejects(reader.list({ target, type: pods }), fails('STALE_TARGET')); assert.equal(calls, 1); assert.equal(checks, 2);
  await assert.rejects(reader.list({ target: { ...target, serviceGeneration: 'old' }, type: pods }), fails('STALE_TARGET')); assert.equal(calls, 1);
  reader.close();
});

test('three large ConfigMaps fail as full JSON but their metadata pages remain expandable without fetching objects', async () => {
  const requests: ResourceReadRequest[] = [];
  const { group, version, resource, kind, scope } = resourceDescriptors.configmaps;
  const mapType = { group, version, resource, kind, scope };
  const objects = Array.from({ length: 3 }, (_, index) => ({ metadata: { name: `example-${index}`, namespace: 'default', uid: `uid-${index}`, resourceVersion: '9' } }));
  const body = { kind: 'ConfigMapList', apiVersion: 'v1', metadata: { resourceVersion: '10' },
    items: objects.map(item => ({ ...item, data: { large: 'x'.repeat(700_000) } })) };
  await assert.rejects(readResponseJson(response(body), signal()), fails('BUDGET_EXCEEDED'));
  const reader = createResourceReader({ serviceGeneration: target.serviceGeneration, currentTarget: async () => target, read: async request => {
    requests.push(request);
    const more = !!request.query.continue;
    return response({ kind: 'PartialObjectMetadataList', apiVersion: 'meta.k8s.io/v1',
      metadata: { resourceVersion: '10', ...(more ? {} : { continue: 'server-private' }) }, items: more ? objects.slice(2) : objects.slice(0, 2) });
  } });
  const pager = createResourcePager(reader);
  try {
    const query = { target, type: mapType, limit: 2 };
    const first = await pager.read({ query });
    assert.ok(first.kind === 'resources' && first.nextCursor);
    assert.equal(first.nodes.length, 2);
    assert.ok(first.nodes.every(node => node.children === 'config-keys' && node.resource?.resourceVersion === '9'));
    assert.ok(!first.nextCursor.includes('server-private'));
    const second = await pager.read({ query, cursor: first.nextCursor });
    assert.ok(second.kind === 'resources' && second.nextCursor === null);
    assert.deepEqual(second.nodes.map(node => node.label), ['example-2']);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.representation === 'metadata-preferred' && request.path === '/api/v1/namespaces/default/configmaps' && request.maximumBytes === 2_000_000));
    assert.deepEqual(requests.map(request => request.query), [{ limit: '2' }, { limit: '2', continue: 'server-private' }]);
  } finally { pager.dispose(); reader.close(); }
});

test('composed reader keeps a shared read alive when only one consumer cancels', async () => {
  let release: (() => void) | undefined, closed = 0;
  let shared: AbortSignal | undefined;
  const reader = createResourceReader({ serviceGeneration: target.serviceGeneration, currentTarget: async () => target, read: async (_request, sharedSignal) => {
    shared = sharedSignal;
    await new Promise<void>(resolve => { release = resolve; });
    return response(podPage(), 200, async () => { closed++; });
  } });
  const controller = new AbortController();
  const first = reader.list({ target, type: pods }, controller.signal), second = reader.list({ target, type: pods });
  const rejected = assert.rejects(first, fails('QUERY_CANCELLED'));
  for (let count = 0; !release && count < 20; count++) await Promise.resolve();
  controller.abort(marker); await rejected;
  assert.equal(shared?.aborted, false); assert.equal(closed, 0);
  release?.(); assert.equal((await second).kind, 'resources'); assert.equal(closed, 1);
  reader.close();
});

test('cancelled stream awaiting a chunk still occupies a slot until stream/close actually settle', async () => {
  let release: (() => void) | undefined, closed = 0;
  const reader = createResourceReader({ serviceGeneration: target.serviceGeneration, currentTarget: async () => target, read: async () => ({
    status: 200, body: { async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => { release = resolve; }); yield new TextEncoder().encode('{}'); } },
    close: async () => { closed++; },
  }) });
  const controller = new AbortController();
  const result = reader.list({ target, type: pods }, controller.signal);
  const rejected = assert.rejects(result, fails('QUERY_CANCELLED'));
  for (let count = 0; !release && count < 30; count++) await Promise.resolve();
  assert.ok(release); controller.abort(); await rejected;
  assert.equal(reader.state.running, 1); assert.equal(closed, 0);
  release();
  for (let count = 0; reader.state.running && count < 40; count++) await Promise.resolve();
  assert.equal(closed, 1); assert.equal(reader.state.running, 0);
  reader.close();
});

test('empty selectors verify identity but never invoke transport or fabricate a server resourceVersion', async () => {
  let calls = 0;
  const reader = createResourceReader({ serviceGeneration: target.serviceGeneration, currentTarget: async () => target, read: async () => { calls++; throw new Error(marker); } });
  const result = await reader.list({ target, type: pods, filter: { kind: 'selector', source: 'service', selector: {} } });
  assert.equal(result.kind, 'empty-selector'); assert.equal(calls, 0); assert.equal('resourceVersion' in result, false);
  reader.close();
});

test('discovery requires exact requested group/version even for empty resource lists; root core/group keys differ', async () => {
  let calls = 0;
  const reader = createResourceReader({ serviceGeneration: target.serviceGeneration, currentTarget: async () => target, read: async request => {
    calls++; return response({ groupVersion: request.path === '/api/v1' ? 'v1' : 'core/v1', resources: [] });
  } });
  await Promise.all([reader.discoverVersion({ target, group: '', version: 'v1' }), reader.discoverVersion({ target, group: 'core', version: 'v1' })]);
  assert.equal(calls, 2);
  await assert.rejects(reader.discoverVersion({ target, group: 'wrong', version: 'v1' }), fails('STALE_TARGET'));
  reader.close();
});

test('reader handles API group and CRD pages with safe purposes/paths, and accepts declared custom listKind only', async () => {
  const requests: ResourceReadRequest[] = [];
  const reader = createResourceReader({ serviceGeneration: target.serviceGeneration, currentTarget: async () => target, read: async request => {
    requests.push(request);
    if (request.purpose === 'api-group') return response(group());
    if (request.purpose === 'custom-resource-definitions') return response({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinitionList', metadata: { resourceVersion: '10' }, items: [definition()] });
    return response({ apiVersion: 'example.com/v1', kind: 'WidgetCollection', metadata: { resourceVersion: '10' }, items: [] });
  } });
  assert.equal((await reader.discoverGroup({ target, group: 'example.com' })).group, 'example.com');
  assert.equal((await reader.customDefinitions({ target, limit: 10 })).folders.length, 1);
  assert.equal(requests[1]?.path, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions');
  const input = { target, type, listKind: 'WidgetCollection' };
  assert.equal((await reader.list(input)).kind, 'resources');
  await assert.rejects(reader.list({ target, type }), fails('RESOURCE_INVALID'));
  const a = planResourceList(input), b = planResourceList({ target, type });
  assert.ok(a.kind === 'list' && b.kind === 'list'); assert.notDeepEqual(a.key, b.key);
  reader.close();
});

test('untrusted raw paths/watch/page injection fail before any read and unknown adapter errors are fixed codes', async () => {
  let calls = 0;
  const reader = createResourceReader({ serviceGeneration: target.serviceGeneration, currentTarget: async () => target, read: async () => { calls++; throw new Error(marker); } });
  for (const input of [{ target, type: pods, path: '/exec' }, { target, type: pods, watch: true }, { target, type: pods, continue: 'x' }]) await assert.rejects(reader.list(input), fails('INVALID_INPUT'));
  assert.equal(calls, 0);
  await assert.rejects(reader.list({ target, type: pods }), fails('STATE_UNAVAILABLE')); assert.equal(calls, 1);
  reader.close();
  await assert.rejects(reader.list({ target, type: pods }), fails('SERVICE_CLOSED'));
});
