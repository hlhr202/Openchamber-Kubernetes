// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmRollbackRequestSchema, helmRollbackResponseSchema, helmRollbackArguments } from '../../src/shared/helm-rollback-protocol.ts';
const target = { serviceGeneration: 's', projectId: 'p', configIdentity: 'a'.repeat(64), context: 'ctx', namespace: 'default' };
const selection = { mode: 'default' } as const;
test('the request binds target/selection with a release token and a bounded revision', () => {
  assert.equal(helmRollbackRequestSchema.safeParse({ protocol: 2, kind: 'run', selection, target, release: 'my-release', revision: 3 }).success, true);
  const cases: unknown[] = [
    { protocol: 2, kind: 'run', selection, target, release: '', revision: 3 },
    { protocol: 2, kind: 'run', selection, target, release: 'x; rm -rf', revision: 3 },
    { protocol: 2, kind: 'run', selection, target, release: 'a'.repeat(129), revision: 3 },
    { protocol: 2, kind: 'run', selection, target, release: 'ok', revision: 0 },
    { protocol: 2, kind: 'run', selection, target, release: 'ok', revision: 10_001 },
    { protocol: 2, kind: 'run', selection, target, release: 'ok', revision: 2.5 },
    { protocol: 2, kind: 'run', selection, target: { serviceGeneration: 's' }, release: 'ok', revision: 3 },
    { protocol: 2, kind: 'read', selection, target, release: 'ok', revision: 3 },
    { protocol: 2, kind: 'run', selection, target, release: 'ok', revision: 3, extra: 1 },
  ];
  for (const bad of cases) assert.equal(helmRollbackRequestSchema.safeParse(bad).success === false, true, JSON.stringify(bad));
});
test('the arguments keep the upstream shape verbatim including --cleanup-on-fail', () => {
  assert.deepEqual(helmRollbackArguments('my-release', 3, '/resolved/kubeconfig'), ['--kubeconfig', '/resolved/kubeconfig', 'rollback', 'my-release', '3', '--cleanup-on-fail']);
});
test('the response is a bounded discriminated pair with no output retention', () => {
  assert.equal(helmRollbackResponseSchema.safeParse({ protocol: 2, kind: 'helm-rolled-back', release: 'my-release', revision: 3 }).success, true);
  assert.equal(helmRollbackResponseSchema.safeParse({ protocol: 2, kind: 'helm-rolled-back', release: 'ok', revision: 10_001 }).success, false);
  assert.equal(helmRollbackResponseSchema.safeParse({ protocol: 2, kind: 'helm-rolled-back', release: 'ok', revision: 3, stdout: 'leak' }).success, false);
  assert.equal(helmRollbackResponseSchema.safeParse({ protocol: 2, kind: 'helm-rollback-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(helmRollbackResponseSchema.safeParse({ protocol: 2, kind: 'helm-rollback-unavailable', code: 'NOPE' }).success, false);
});
