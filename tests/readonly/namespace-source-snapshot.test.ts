// Public synthetic metadata DTO validation only; no operation/planner/client/adapter import or invocation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { namespaceOutcomeSchema } from '../../src/shared/namespace-protocol.ts';

const generation = '00000000-0000-4000-8000-000000000001';
const snapshot = () => ({ id: generation, serviceGeneration: generation, configuration: { serviceGeneration: generation, projectId: 'synthetic-view', configIdentity: 'synthetic-config' }, context: 'active',
  step: 'set-namespace', dependencies: [], contextAction: 'update', path: '/synthetic/origin', contextOrigin: '/synthetic/origin', previous: 'old', namespace: 'next', version: 'v-origin',
  sources: [{ path: '/synthetic/missing', status: 'missing', version: null, currentContext: '', definesContext: false },
    { path: '/synthetic/first', status: 'present', version: 'v-first', currentContext: 'active', definesContext: false },
    { path: '/synthetic/origin', status: 'present', version: 'v-origin', currentContext: 'other', definesContext: true },
    { path: '/synthetic/shadow', status: 'present', version: 'v-shadow', currentContext: '', definesContext: true }],
  phase: 'succeeded', cleanup: 'none', result: 'changed', createdAt: 1, updatedAt: 2 });

test('namespace source snapshot writes the first context definition, not the first existing file or the file providing current-context', () => {
  const value = namespaceOutcomeSchema.parse(snapshot());
  assert.equal(value.path, '/synthetic/origin'); assert.equal(value.sources[1]?.currentContext, value.context);
  assert.equal(value.sources[2]?.currentContext, 'other'); assert.equal(value.sources[3]?.definesContext, true);
});
test('snapshot rejects the current-context/default destination and later same-name shadow as the namespace write origin', () => {
  for (const fields of [{ path: '/synthetic/first', contextOrigin: '/synthetic/first', version: 'v-first' }, { path: '/synthetic/shadow', contextOrigin: '/synthetic/shadow', version: 'v-shadow' }]) {
    assert.equal(namespaceOutcomeSchema.safeParse({ ...snapshot(), ...fields }).success, false);
  }
});
test('source-bound namespace DTO requires a valid previous namespace, coherent effective current and configuration generation without a resource target', () => {
  const value = snapshot();
  for (const fields of [{ previous: 'INVALID NS' }, { version: 'wrong' }, { context: 'other' }, { configuration: { ...value.configuration, serviceGeneration: 'wrong' } }, { target: { context: 'active' } }]) {
    assert.equal(namespaceOutcomeSchema.safeParse({ ...value, ...fields }).success, false);
  }
});
test('missing source facts, duplicated paths, source contents or credential extensions never become valid public outcomes', () => {
  const value = snapshot();
  for (const fields of [{ version: 'not-null' }, { definesContext: true }, { currentContext: 'unexpected' }]) {
    assert.equal(namespaceOutcomeSchema.safeParse({ ...value, sources: [{ ...value.sources[0], ...fields }, ...value.sources.slice(1)] }).success, false);
  }
  assert.equal(namespaceOutcomeSchema.safeParse({ ...value, sources: [...value.sources, value.sources[2]] }).success, false);
  assert.equal(namespaceOutcomeSchema.safeParse({ ...value, sources: value.sources.map(source => ({ ...source, content: 'SYNTHETIC_SECRET' })) }).success, false);
  assert.equal(namespaceOutcomeSchema.safeParse({ ...value, token: 'SYNTHETIC_SECRET' }).success, false);
});
test('legacy incomplete namespace DTOs and overlarge source inventories fail rather than silently losing origin metadata', () => {
  const value = snapshot();
  assert.equal(namespaceOutcomeSchema.safeParse({ ...value, sources: undefined }).success, false);
  assert.equal(namespaceOutcomeSchema.safeParse({ ...value, sources: Array.from({ length: 65 }, (_, n) => ({ path: `/synthetic/${n}`, status: 'missing', version: null, currentContext: '', definesContext: false })) }).success, false);
});
