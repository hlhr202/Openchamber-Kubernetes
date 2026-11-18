// Synthetic public DTO validation only. No operation/client/planner/adapter import or invocation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { contextOutcomeSchema } from '../../src/shared/context-protocol.ts';

const generation = '00000000-0000-4000-8000-000000000001';
const snapshot = () => ({ id: generation, serviceGeneration: generation, configuration: { serviceGeneration: generation, projectId: 'synthetic-view', configIdentity: 'synthetic-config' },
  step: 'use-context', dependencies: [], path: '/synthetic/first', version: 'v-first', previous: 'old', context: 'target', writePrevious: '', contextOrigin: '/synthetic/second',
  sources: [{ path: '/synthetic/missing', status: 'missing', version: null, currentContext: '', definesContext: false },
    { path: '/synthetic/first', status: 'present', version: 'v-first', currentContext: '', definesContext: false },
    { path: '/synthetic/second', status: 'present', version: 'v-second', currentContext: 'old', definesContext: true }],
  phase: 'succeeded', cleanup: 'none', result: 'changed', createdAt: 1, updatedAt: 2 });

test('public context-source snapshot distinguishes effective current, physical previous, missing source and later target origin without private config', () => {
  const value = contextOutcomeSchema.parse(snapshot());
  assert.equal(value.path, '/synthetic/first'); assert.equal(value.contextOrigin, '/synthetic/second'); assert.equal(value.previous, 'old'); assert.equal(value.writePrevious, '');
  assert.equal(value.sources[0]?.status, 'missing'); assert.equal(value.sources[2]?.definesContext, true);
});
test('snapshot rejects moving the write destination to context origin, mismatching physical versions or a fabricated effective previous', () => {
  for (const fields of [{ path: '/synthetic/second', version: 'v-second', writePrevious: 'old' }, { version: 'wrong' }, { writePrevious: 'wrong' }, { previous: 'wrong' }]) {
    assert.equal(contextOutcomeSchema.safeParse({ ...snapshot(), ...fields }).success, false);
  }
});
test('snapshot validates first target definition, retains later shadow metadata and refuses a later origin or duplicate source paths', () => {
  const value = snapshot(); value.sources.push({ path: '/synthetic/shadow', status: 'present', version: 'v-shadow', currentContext: 'ignored', definesContext: true });
  assert.equal(contextOutcomeSchema.safeParse(value).success, true);
  assert.equal(contextOutcomeSchema.safeParse({ ...value, contextOrigin: '/synthetic/shadow' }).success, false);
  value.sources.push({ ...value.sources[1], path: '/synthetic/first', status: 'present', version: 'v-first', currentContext: '', definesContext: false });
  assert.equal(contextOutcomeSchema.safeParse(value).success, false);
});
test('missing-source inconsistencies, credentials/content extensions and legacy incomplete DTOs are rejected instead of silently defaulted', () => {
  const value = snapshot();
  for (const fields of [{ version: 'not-null' }, { definesContext: true }, { currentContext: 'unexpected' }]) {
    assert.equal(contextOutcomeSchema.safeParse({ ...value, sources: [{ ...value.sources[0], ...fields }, ...value.sources.slice(1)] }).success, false);
  }
  assert.equal(contextOutcomeSchema.safeParse({ ...value, token: 'SYNTHETIC_SECRET' }).success, false);
  assert.equal(contextOutcomeSchema.safeParse({ ...value, sources: value.sources.map(source => ({ ...source, content: 'SYNTHETIC_SECRET' })) }).success, false);
  assert.equal(contextOutcomeSchema.safeParse({ ...value, sources: undefined }).success, false);
});
test('source metadata is bounded and only absolute control-free paths can appear in a public outcome', () => {
  for (const path of ['relative', '/synthetic/\u0000file']) assert.equal(contextOutcomeSchema.safeParse({ ...snapshot(), path }).success, false);
  const value = snapshot();
  assert.equal(contextOutcomeSchema.safeParse({ ...value, sources: Array.from({ length: 65 }, (_, n) => ({ path: `/synthetic/${n}`, status: 'missing', version: null, currentContext: '', definesContext: false })) }).success, false);
});
