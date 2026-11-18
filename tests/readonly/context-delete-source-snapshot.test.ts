// Synthetic PUBLIC DTOs only. Never import or invoke a deletion planner/controller/client/source hook/adapter/writer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { contextDeleteOutcomeSchema } from '../../src/shared/context-delete-protocol.ts';

const generation = '00000000-0000-4000-8000-000000000001';
const snapshot = () => ({ id: generation, serviceGeneration: generation, configuration: { serviceGeneration: generation, projectId: 'synthetic-view', configIdentity: 'synthetic-config' },
  context: 'target', path: '/synthetic/context', version: 'v-context', currentContextRetained: 'target', removesCurrent: true, contextRemains: true,
  contextAfter: { origin: '/synthetic/shadow', cluster: 'other-cluster', user: 'other-user', namespace: 'other' },
  sources: [{ path: '/synthetic/missing', status: 'missing', version: null, currentContext: '', definesContext: false, definesCluster: false, definesUser: false },
    { path: '/synthetic/cluster', status: 'present', version: 'v-cluster', currentContext: 'target', definesContext: false, definesCluster: true, definesUser: false },
    { path: '/synthetic/user', status: 'present', version: 'v-user', currentContext: 'different', definesContext: false, definesCluster: false, definesUser: true },
    { path: '/synthetic/context', status: 'present', version: 'v-context', currentContext: '', definesContext: true, definesCluster: false, definesUser: false },
    { path: '/synthetic/shadow', status: 'present', version: 'v-shadow', currentContext: '', definesContext: true, definesCluster: true, definesUser: true }],
  steps: [{ id: 'cluster', name: 'cluster.with.dot', dependencies: [], path: '/synthetic/cluster', nextOrigin: '/synthetic/shadow', shadowDefinitions: 1, sharedReferences: 0, phase: 'planned', reason: 'exclusive', cleanup: 'none' },
    { id: 'user', name: 'user.with.dot', dependencies: ['cluster'], path: '/synthetic/user', nextOrigin: '/synthetic/shadow', shadowDefinitions: 1, sharedReferences: 1, phase: 'skipped', reason: 'shared', cleanup: 'none' },
    { id: 'context', name: 'target', dependencies: ['cluster', 'user'], path: '/synthetic/context', nextOrigin: '/synthetic/shadow', shadowDefinitions: 1, sharedReferences: 0, phase: 'planned', reason: 'target', cleanup: 'none' }],
  phase: 'prepared', createdAt: 1, updatedAt: 2 });

test('deletion source DTO distinguishes per-step origins, physical shadows and the expected newly effective context without config bodies', () => {
  const value = contextDeleteOutcomeSchema.parse(snapshot());
  assert.equal(value.steps[0].path, '/synthetic/cluster'); assert.equal(value.steps[1].phase, 'skipped');
  assert.equal(value.steps[2].path, '/synthetic/context'); assert.equal(value.contextAfter?.cluster, 'other-cluster'); assert.equal(value.contextRemains, true);
});
test('source DTO rejects fabricated write origins, next origins, shadow counts, dependencies and inconsistent retained current-context', () => {
  const value = snapshot();
  for (const fields of [{ path: '/synthetic/shadow' }, { nextOrigin: '/synthetic/context' }, { shadowDefinitions: 0 }, { dependencies: ['context'] }]) {
    assert.equal(contextDeleteOutcomeSchema.safeParse({ ...value, steps: [{ ...value.steps[0], ...fields }, ...value.steps.slice(1)] }).success, false);
  }
  for (const fields of [{ path: '/synthetic/cluster' }, { version: 'wrong' }, { currentContextRetained: 'different' }, { removesCurrent: false }]) {
    assert.equal(contextDeleteOutcomeSchema.safeParse({ ...value, ...fields }).success, false);
  }
});
test('predicted shadow resolution and dangling-current branches are distinct and cannot silently discard the next context disclosure', () => {
  const value = snapshot();
  assert.equal(contextDeleteOutcomeSchema.safeParse({ ...value, contextAfter: null }).success, false);
  assert.equal(contextDeleteOutcomeSchema.safeParse({ ...value, contextRemains: false }).success, false);
  assert.equal(contextDeleteOutcomeSchema.safeParse({ ...value, contextAfter: { ...value.contextAfter, origin: '/synthetic/context' } }).success, false);
  const sources = value.sources.slice(0, -1), steps = value.steps.map(step => ({ ...step, shadowDefinitions: 0, nextOrigin: null }));
  assert.equal(contextDeleteOutcomeSchema.safeParse({ ...value, sources, steps, contextAfter: null, contextRemains: false }).success, true);
});
test('shared entries cannot be marked for deletion, missing/empty references require skipped, and missing source facts remain coherent', () => {
  const value = snapshot();
  assert.equal(contextDeleteOutcomeSchema.safeParse({ ...value, steps: [value.steps[0], { ...value.steps[1], phase: 'planned' }, value.steps[2]] }).success, false);
  for (const fields of [{ version: 'not-null' }, { definesUser: true }, { definesCluster: true }, { definesContext: true }]) {
    assert.equal(contextDeleteOutcomeSchema.safeParse({ ...value, sources: [{ ...value.sources[0], ...fields }, ...value.sources.slice(1)] }).success, false);
  }
  const sources = value.sources.map(source => ({ ...source, definesUser: false })), steps = [value.steps[0], { ...value.steps[1], name: '', path: null, nextOrigin: null, shadowDefinitions: 0, sharedReferences: 0, reason: 'empty' }, value.steps[2]];
  assert.equal(contextDeleteOutcomeSchema.safeParse({ ...value, sources, steps }).success, true);
});
test('original cross-file partial success and unknown later step remain expressible without overwriting original source metadata', () => {
  const value = snapshot();
  const outcome = contextDeleteOutcomeSchema.parse({ ...value, phase: 'unknown', steps: [{ ...value.steps[0], phase: 'succeeded', result: 'changed' }, value.steps[1], { ...value.steps[2], phase: 'unknown', code: 'OPERATION_UNKNOWN' }] });
  assert.equal(outcome.steps[0].phase, 'succeeded'); assert.equal(outcome.sources[1]?.version, 'v-cluster');
});
test('legacy incomplete DTOs, duplicate/overlarge source lists and credential/body extensions are rejected', () => {
  const value = snapshot();
  for (const fields of [{ sources: undefined }, { contextAfter: undefined }, { sources: [...value.sources, value.sources[1]] }, { token: 'SYNTHETIC_SECRET' },
    { sources: value.sources.map(source => ({ ...source, content: 'SYNTHETIC_SECRET' })) }, { sources: Array.from({ length: 65 }, (_, n) => ({ ...value.sources[0], path: `/synthetic/${n}` })) }]) {
    assert.equal(contextDeleteOutcomeSchema.safeParse({ ...value, ...fields }).success, false);
  }
});
