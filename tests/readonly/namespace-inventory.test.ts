// Only independent GET queries on synthetic responses. No namespace-delete client/handler/writer import.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { namespaceInventorySchema } from '../../src/shared/namespace-inventory.ts';
import { collectNamespaceInventory } from '../../src/service/queries/namespace-inventory.ts';
import { createResourceReader } from '../../src/service/queries/resource-reader.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';

const target = { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'current' };
const reference = { type: { group: '', version: 'v1', resource: 'namespaces', kind: 'Namespace', scope: 'cluster' as const }, name: 'other', uid: 'ns-u', resourceVersion: 'ns-rv' };
const key = Buffer.alloc(32, 7), marker = 'SYNTHETIC_INVENTORY_SECRET', signal = () => new AbortController().signal;
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;
const root = { kind: 'APIGroupList', groups: [{ name: 'example.test', preferredVersion: { groupVersion: 'example.test/v1', version: 'v1' }, versions: [{ groupVersion: 'example.test/v1', version: 'v1' }] }] };
const discovery = (groupVersion = 'v1') => ({ groupVersion, resources: [{ name: groupVersion === 'v1' ? 'secrets' : 'widgets', kind: groupVersion === 'v1' ? 'Secret' : 'Widget', namespaced: true, verbs: ['list', 'get'] },
  { name: 'status/exec', kind: 'Status', namespaced: true, verbs: ['list'] }, { name: 'clusterthings', kind: 'ClusterThing', namespaced: false, verbs: ['list'] }] });
const item = (index = 0) => ({ metadata: { namespace: 'other', name: `item-${index}`, uid: `u-${index}`, resourceVersion: `rv-${index}`, annotations: { marker } }, data: { secret: marker } });
const page = (items: unknown[] = [item()], apiVersion = 'v1', continuation = '') => ({ apiVersion, kind: 'CustomCollection', metadata: { resourceVersion: 'list-rv', continue: continuation }, items });
const namespace = () => ({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: reference.name, uid: reference.uid, resourceVersion: reference.resourceVersion } });
async function get(path: string): Promise<unknown> { if (path === '/apis') return root; if (path === '/api/v1') return discovery(); if (path === '/apis/example.test/v1') return discovery('example.test/v1'); return page([item()], path.startsWith('/apis/') ? 'example.test/v1' : 'v1'); }
function readerFixture(transform: (request: ResourceReadRequest, value: unknown) => unknown = (_request, value) => value, status = 200) {
  const requests: ResourceReadRequest[] = []; let namespaceChecks = 0, iterated = false;
  const reader = createResourceReader({ serviceGeneration: target.serviceGeneration, currentTarget: async () => target, read: async request => {
    kubectlReadArguments(request, '/synthetic/configuration.pipe'); requests.push(request);
    const essential = request.purpose === 'resource-object'; if (essential) namespaceChecks++;
    const code = essential ? 200 : status, value = transform(request, essential ? namespace() : await get(request.path));
    return { status: code, body: { async *[Symbol.asyncIterator]() { if (code !== 200) iterated = true; yield Buffer.from(JSON.stringify(value)); } }, close: async () => {} };
  } });
  return { reader, requests, namespaceChecks: () => namespaceChecks, iterated: () => iterated };
}

test('preferred namespaced discovery counts core/custom entries, excluding cluster resources and subresources, without returning content', async () => {
  const calls: string[] = [], value = await collectNamespaceInventory(reference, key, async path => { calls.push(path); return get(path); });
  assert.equal(value.count, 2); assert.equal(value.types, 2); assert.match(value.digest, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(value).includes(marker)); assert.ok(!calls.some(path => path.includes('clusterthings') || path.includes('exec')));
});
test('resources served only outside a group preferred version are still checked, without counting a resource twice across versions', async () => {
  const calls: string[] = [];
  const value = await collectNamespaceInventory(reference, key, async path => {
    calls.push(path);
    if (path === '/apis') return { ...root, groups: [{ ...root.groups[0], preferredVersion: { groupVersion: 'example.test/v2', version: 'v2' }, versions: [{ groupVersion: 'example.test/v1', version: 'v1' }, { groupVersion: 'example.test/v2', version: 'v2' }] }] };
    if (path === '/apis/example.test/v2') return { groupVersion: 'example.test/v2', resources: [] };
    return get(path);
  });
  assert.equal(value.count, 2); assert.equal(value.types, 2); assert.ok(calls.includes('/apis/example.test/v1/namespaces/other/widgets'));
});
test('valid empty preferred inventories are complete zero, not an unknown status or implicit absence of discovery', async () => {
  const value = await collectNamespaceInventory(reference, key, async path => path.includes('/namespaces/') ? page([], path.startsWith('/apis/') ? 'example.test/v1' : 'v1') : get(path));
  assert.equal(value.count, 0); assert.equal(value.types, 2);
  await assert.rejects(collectNamespaceInventory(reference, key, async path => path === '/apis' ? { kind: 'APIGroupList', groups: [] } : { groupVersion: 'v1', resources: [] }), fails('RESOURCE_INVALID'));
});
test('inventory pages preserve per-type list RV, reject repeated cursors/UIDs, and do not trust a partial count', async () => {
  let pages = 0;
  const value = await collectNamespaceInventory(reference, key, async path => {
    if (!path.includes('/namespaces/')) return get(path); pages++;
    return page([item(pages)], path.startsWith('/apis/') ? 'example.test/v1' : 'v1', pages === 1 ? 'next' : '');
  }); assert.equal(value.count, 3);
  await assert.rejects(collectNamespaceInventory(reference, key, async path => path.includes('/namespaces/') ? page([item()], path.startsWith('/apis/') ? 'example.test/v1' : 'v1', 'cycle') : get(path)), fails('STALE_TARGET'));
});
test('changed namespace, GVR/item kind, malformed discovery and list RV changes are fixed failures without source text', async () => {
  await assert.rejects(collectNamespaceInventory(reference, key, async path => path.includes('/namespaces/') ? page([{ ...item(), metadata: { ...item().metadata, namespace: 'wrong' } }]) : get(path)), fails('STALE_TARGET'));
  await assert.rejects(collectNamespaceInventory(reference, key, async path => path === '/api/v1' ? discovery('wrong/v1') : get(path)), fails('RESOURCE_INVALID'));
  await assert.rejects(collectNamespaceInventory(reference, key, async path => path.includes('/namespaces/') ? page([{ ...item(), kind: 'Wrong' }], path.startsWith('/apis/') ? 'example.test/v1' : 'v1') : get(path)), fails('RESOURCE_INVALID'));
});
test('reader brackets inventory with fresh Namespace identity checks and preserves original current namespace without switching it', async () => {
  const f = readerFixture(), value = await f.reader.namespaceInventory(target, reference, signal());
  assert.equal(value.status, 'complete'); assert.equal(value.count, 2); assert.equal(f.namespaceChecks(), 2); assert.ok(namespaceInventorySchema.safeParse(value).success);
  assert.equal(f.requests.every(request => request.method === 'GET' && request.target.namespace === 'current'), true);
  assert.equal(f.requests.at(0)?.path, '/api/v1/namespaces/other'); assert.equal(f.requests.at(-1)?.path, '/api/v1/namespaces/other'); f.reader.close();
});
test('list permission failure yields unknown/null with a fixed code, never empty zero or iteration of sensitive error bodies', async () => {
  const f = readerFixture(undefined, 403), value = await f.reader.namespaceInventory(target, reference, signal());
  assert.equal(value.status, 'unknown'); assert.equal(value.count, null); assert.equal(value.code, 'FORBIDDEN'); assert.equal(f.namespaceChecks(), 2); assert.equal(f.iterated(), false); f.reader.close();
});
test('Namespace replacement after enumeration rejects the complete summary, rather than becoming an overridable content failure', async () => {
  let checks = 0;
  const f = readerFixture((request, value) => request.purpose === 'resource-object' && ++checks === 2 ? { ...namespace(), metadata: { ...namespace().metadata, uid: 'replacement' } } : value);
  await assert.rejects(f.reader.namespaceInventory(target, reference, signal()), fails('STALE_TARGET')); f.reader.close();
});
test('inventory proof is stable for the same reader/reference/facts but changes with membership and does not expose any source fields', async () => {
  const f = readerFixture(), a = await f.reader.namespaceInventory(target, reference, signal()), b = await f.reader.namespaceInventory(target, reference, signal());
  assert.equal(a.digest, b.digest); assert.ok(!JSON.stringify(a).includes(marker)); f.reader.close();
  const changed = await collectNamespaceInventory(reference, key, async path => path.includes('/namespaces/') ? page([item(2)], path.startsWith('/apis/') ? 'example.test/v1' : 'v1') : get(path));
  const before = await collectNamespaceInventory(reference, key, get); assert.notEqual(before.digest, changed.digest);
});
test('private GET purpose permits only /apis discovery and named namespace collections with bounded continuation, never watch/exec/arbitrary URLs', () => {
  const request: ResourceReadRequest = { method: 'GET', purpose: 'namespace-inventory', target, path: '/api/v1/namespaces/other/pods', maximumBytes: 2_000_000, query: { limit: '100' } };
  assert.ok(kubectlReadArguments(request, '/synthetic/fifo').at(-1)?.includes('namespaces/other/pods?limit=100'));
  for (const path of ['/api/v1/namespaces/other/pods/p/exec', 'https://bad.invalid', '/api/v1/pods']) assert.throws(() => kubectlReadArguments({ ...request, path }, '/synthetic/fifo'), fails('INVALID_INPUT'));
  for (const query of [{ limit: '100', watch: 'true' }, { limit: '101' }]) assert.throws(() => kubectlReadArguments({ ...request, query }, '/synthetic/fifo'), fails('INVALID_INPUT'));
  assert.throws(() => kubectlReadArguments({ ...request, purpose: 'api-root', path: '/api/v1', query: {} }, '/synthetic/fifo'), fails('INVALID_INPUT'));
});
test('already cancelled and closed readers issue no inventory GET or late result', async () => {
  const f = readerFixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.reader.namespaceInventory(target, reference, controller.signal), fails('QUERY_CANCELLED')); assert.equal(f.requests.length, 0);
  f.reader.close(); await assert.rejects(f.reader.namespaceInventory(target, reference, signal()), fails('SERVICE_CLOSED'));
});
