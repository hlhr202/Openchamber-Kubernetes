// Pure bootstrap store helpers only (no server, no sockets).
import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectStore, mergeJson, listPage, installFixtures, defaultFixtures, kubeconfig } from '../../src/shared/bootstrap-store.ts';
test('the store assigns uid + strictly monotonic resourceVersions on every mutation', () => {
  const store = new ObjectStore();
  const first = store.insert('pods', { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'a', namespace: 'default', uid: '', resourceVersion: '', creationTimestamp: '' } });
  const second = store.insert('pods', { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'b', namespace: 'default', uid: '', resourceVersion: '', creationTimestamp: '' } });
  assert.ok(first.metadata.uid && second.metadata.uid && first.metadata.uid !== second.metadata.uid);
  assert.ok(Number(second.metadata.resourceVersion) > Number(first.metadata.resourceVersion));
  const patched = store.patch('pods', 'a', { spec: { replicas: 3 } });
  assert.ok(patched && Number(patched.metadata.resourceVersion) > Number(second.metadata.resourceVersion));
  assert.equal((patched?.spec as { replicas: number } | undefined)?.replicas, 3);
  assert.equal(store.remove('pods', 'a'), true);
  assert.equal(store.remove('pods', 'a'), false);
});
test('mergeJson is RFC 7386: null deletes, objects recurse, arrays replace', () => {
  const merged = mergeJson({ a: 1, b: { c: 2, d: 3 }, e: [1] }, { b: { c: 4 }, e: [2, 3], a: null }) as { b: { c: number; d: number }; e: number[]; a?: unknown };
  assert.equal(merged.b.c, 4); assert.equal(merged.b.d, 3); assert.deepEqual(merged.e, [2, 3]); assert.equal('a' in merged, false);
  assert.deepEqual(mergeJson({ x: 1 }, { x: [1, { y: null }] }), { x: [1, { y: null }] }); // arrays replace wholesale (RFC 7386)
});
test('listPage paginates a stable snapshot and reports exhaustion as 0', () => {
  const items = [1, 2, 3, 4, 5];
  assert.deepEqual(listPage(items, 2, 0), { items: [1, 2], continueCount: 2 });
  assert.deepEqual(listPage(items, 2, 4), { items: [5], continueCount: 0 });
  assert.deepEqual(listPage(items, 10, 0), { items, continueCount: 0 });
  assert.deepEqual(listPage([], 5, 0), { items: [], continueCount: 0 });
});
test('fixtures install idempotently and the synthetic kubeconfig carries no credentials', () => {
  const store = new ObjectStore();
  installFixtures(store, defaultFixtures());
  installFixtures(store, defaultFixtures()); // second install keeps one copy per name
  assert.equal(store.list('namespaces').length, 2);
  assert.equal(store.list('pods', 'default').length, 1);
  assert.equal(store.list('deployments', 'default').length, 1);
  const text = kubeconfig('http://127.0.0.1:8443', 'synthetic-token');
  const parsed = JSON.parse(text) as { users: { user: { token: string } }[]; clusters: { cluster: { server: string } }[] };
  assert.equal(parsed.clusters[0]?.cluster.server, 'http://127.0.0.1:8443');
  assert.equal(parsed.users[0]?.user.token, 'synthetic-token');
  assert.ok(!text.includes('certificate-authority')); // plain loopback HTTP: no CA by design
});
