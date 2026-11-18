// Public synthetic DTOs only. No deletion/source planner, controller, client, hook, worker or writer execution.
import assert from 'node:assert/strict';
import test from 'node:test';
import { namespaceDeleteOutcomeSchema } from '../../src/shared/namespace-delete-protocol.ts';

const generation = '00000000-0000-4000-8000-000000000001';
const reference = { type: { group: '', version: 'v1', resource: 'namespaces', kind: 'Namespace', scope: 'cluster' }, name: 'old', uid: 'synthetic-uid', resourceVersion: 'synthetic-rv' };
const snapshot = () => ({ id: generation, serviceGeneration: generation, target: { serviceGeneration: generation, projectId: 'synthetic-view', configIdentity: 'synthetic-config', context: 'active', namespace: 'old' },
  reference, inventory: { reference, status: 'complete', count: 0, types: 1, digest: 'a'.repeat(64) }, path: '/synthetic/origin', contextOrigin: '/synthetic/origin', version: 'v-origin',
  sources: [{ path: '/synthetic/first', status: 'present', version: 'v-first', currentContext: 'active', definesContext: false },
    { path: '/synthetic/origin', status: 'present', version: 'v-origin', currentContext: 'other', definesContext: true },
    { path: '/synthetic/missing', status: 'missing', version: null, currentContext: '', definesContext: false },
    { path: '/synthetic/shadow', status: 'present', version: 'v-shadow', currentContext: '', definesContext: true }],
  switchDefault: { id: 'switch-default', dependencies: [], phase: 'planned', cleanup: 'none' },
  deleteNamespace: { id: 'delete-namespace', dependencies: ['switch-default'], phase: 'planned', cleanup: 'none' },
  phase: 'prepared', createdAt: 1, updatedAt: 2 });

test('Namespace deletion source snapshot binds the original winning context origin, not first-present/default or later shadow', () => {
  const value = namespaceDeleteOutcomeSchema.parse(snapshot()); assert.equal(value.path, '/synthetic/origin'); assert.equal(value.sources[2]?.status, 'missing');
  for (const fields of [{ path: '/synthetic/first' }, { contextOrigin: '/synthetic/shadow', path: '/synthetic/shadow', version: 'v-shadow' }, { version: 'wrong' }]) {
    assert.equal(namespaceDeleteOutcomeSchema.safeParse({ ...snapshot(), ...fields }).success, false);
  }
});
test('non-current Namespace public snapshots require skipped configuration and no write path or config-step dependency', () => {
  const value = snapshot(), other = { ...reference, name: 'other' };
  const skipped = { ...value, reference: other, inventory: { ...value.inventory, reference: other }, path: null,
    switchDefault: { ...value.switchDefault, phase: 'skipped' }, deleteNamespace: { ...value.deleteNamespace, dependencies: [] } };
  assert.equal(namespaceDeleteOutcomeSchema.safeParse(skipped).success, true);
  for (const fields of [{ path: value.path }, { switchDefault: value.switchDefault }, { deleteNamespace: value.deleteNamespace }]) {
    assert.equal(namespaceDeleteOutcomeSchema.safeParse({ ...skipped, ...fields }).success, false);
  }
});
test('post-config target is separate from original target and may only appear after definite switch success for the same context/project/Server', () => {
  const value = snapshot(), targetAfter = { ...value.target, namespace: 'default', configIdentity: 'synthetic-after-config' };
  const after = { ...value, phase: 'failed', switchDefault: { ...value.switchDefault, phase: 'succeeded' }, targetAfter };
  assert.equal(namespaceDeleteOutcomeSchema.safeParse(after).success, true);
  assert.equal(namespaceDeleteOutcomeSchema.safeParse({ ...after, switchDefault: value.switchDefault }).success, false);
  for (const fields of [{ namespace: 'other' }, { context: 'other' }, { projectId: 'other' }, { serviceGeneration: '00000000-0000-4000-8000-000000000002' }]) {
    assert.equal(namespaceDeleteOutcomeSchema.safeParse({ ...after, targetAfter: { ...targetAfter, ...fields } }).success, false);
  }
});
test('source snapshots reject stale effective current, duplicate paths, missing metadata inconsistencies, bodies and credentials', () => {
  const value = snapshot();
  for (const fields of [{ target: { ...value.target, context: 'other' } }, { sources: [...value.sources, value.sources[0]] },
    { sources: value.sources.map(source => source.status === 'missing' ? { ...source, version: 'not-null' } : source) }, { token: 'SYNTHETIC_SECRET' },
    { sources: value.sources.map(source => ({ ...source, content: 'SYNTHETIC_SECRET' })) }]) {
    assert.equal(namespaceDeleteOutcomeSchema.safeParse({ ...value, ...fields }).success, false);
  }
});
test('legacy incomplete or overlarge deletion source DTOs are rejected, while original config-success/delete-failure remains expressible', () => {
  const value = snapshot();
  assert.equal(namespaceDeleteOutcomeSchema.safeParse({ ...value, sources: undefined }).success, false);
  assert.equal(namespaceDeleteOutcomeSchema.safeParse({ ...value, sources: Array.from({ length: 65 }, (_, n) => ({ path: `/synthetic/${n}`, status: 'missing', version: null, currentContext: '', definesContext: false })) }).success, false);
  assert.equal(namespaceDeleteOutcomeSchema.safeParse({ ...value, phase: 'unknown', switchDefault: { ...value.switchDefault, phase: 'succeeded' }, deleteNamespace: { ...value.deleteNamespace, phase: 'unknown' } }).success, true);
});
