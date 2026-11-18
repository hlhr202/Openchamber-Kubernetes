// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmGetRequestSchema, helmGetResponseSchema, getScope, helmGetArguments } from '../../src/shared/helm-get-protocol.ts';
const target = { serviceGeneration: 's', projectId: 'p', configIdentity: 'a'.repeat(64), context: 'ctx', namespace: 'default' };
const selection = { mode: 'default' } as const;
test('the request binds the established target/selection pair with a bounded release and revision', () => {
  assert.equal(helmGetRequestSchema.safeParse({ protocol: 2, kind: 'read', selection, target, release: 'my-release' }).success, true);
  assert.equal(helmGetRequestSchema.safeParse({ protocol: 2, kind: 'read', selection, target, release: 'my-release', revision: 7 }).success, true);
  const cases: unknown[] = [
    { protocol: 2, kind: 'read', selection, target, release: '' },
    { protocol: 2, kind: 'read', selection, target, release: 'x y' },
    { protocol: 2, kind: 'read', selection, target, release: 'a'.repeat(129) },
    { protocol: 2, kind: 'read', selection, target, release: 'ok', revision: 0 },
    { protocol: 2, kind: 'read', selection, target, release: 'ok', revision: 10_001 },
    { protocol: 2, kind: 'read', selection, target, release: 'ok', revision: 1.5 },
    { protocol: 2, kind: 'read', selection: { mode: 'default' }, target: { serviceGeneration: 's' }, release: 'ok' },
    { protocol: 2, kind: 'run', selection, target, release: 'ok' },
    { protocol: 2, kind: 'read', selection, target, release: 'ok', extra: 1 },
  ];
  for (const bad of cases) assert.equal(helmGetRequestSchema.safeParse(bad).success === false, true, JSON.stringify(bad));
});
test('the scope follows upstream exactly: only v2 omits all', () => {
  assert.equal(getScope('v2'), 'none'); assert.equal(getScope('v3'), 'all'); assert.equal(getScope('v4'), 'all'); assert.equal(getScope('unknown'), 'all');
});
test('the arguments keep the upstream revision spelling with the pinned kubeconfig path', () => {
  assert.deepEqual(helmGetArguments('v3', 'rel', 7, '/resolved/kubeconfig'), ['--kubeconfig', '/resolved/kubeconfig', 'get', 'all', 'rel', '--revision=7']);
  assert.deepEqual(helmGetArguments('v2', 'rel', undefined, '/k'), ['--kubeconfig', '/k', 'get', 'rel']);
  assert.deepEqual(helmGetArguments('unknown', 'rel', undefined, '/k'), ['--kubeconfig', '/k', 'get', 'all', 'rel']);
});
test('the response is a bounded discriminated pair with the probed syntax echo', () => {
  assert.equal(helmGetResponseSchema.safeParse({ protocol: 2, kind: 'helm-release-read', release: 'r', syntax: 'v3', content: 'HOOKS:\n---\n' }).success, true);
  assert.equal(helmGetResponseSchema.safeParse({ protocol: 2, kind: 'helm-release-read', release: 'r', revision: 3, syntax: 'unknown', content: '' }).success, true);
  assert.equal(helmGetResponseSchema.safeParse({ protocol: 2, kind: 'helm-release-read', release: 'r', syntax: 'v9', content: '' }).success, false);
  assert.equal(helmGetResponseSchema.safeParse({ protocol: 2, kind: 'helm-release-read', release: 'r', syntax: 'v2', content: 'x'.repeat(32_769) }).success, false);
  assert.equal(helmGetResponseSchema.safeParse({ protocol: 2, kind: 'helm-release-read', release: 'r', syntax: 'v2', content: 'ok', stderr: 'leak' }).success, false);
  assert.equal(helmGetResponseSchema.safeParse({ protocol: 2, kind: 'helm-get-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(helmGetResponseSchema.safeParse({ protocol: 2, kind: 'helm-get-unavailable', code: 'NOPE' }).success, false);
});
