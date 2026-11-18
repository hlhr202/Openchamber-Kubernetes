// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmUninstallRequestSchema, helmUninstallResponseSchema, releaseToken, helmUninstallArguments } from '../../src/shared/helm-uninstall-protocol.ts';
const target = { serviceGeneration: 's', projectId: 'p', configIdentity: 'a'.repeat(64), context: 'ctx', namespace: 'default' };
const selection = { mode: 'default' } as const;
test('the request binds target/selection with a bounded release token', () => {
  assert.equal(helmUninstallRequestSchema.safeParse({ protocol: 2, kind: 'run', selection, target, release: 'my-release' }).success, true);
  const cases: unknown[] = [
    { protocol: 2, kind: 'run', selection, target, release: '' },
    { protocol: 2, kind: 'run', selection, target, release: '-lead' },
    { protocol: 2, kind: 'run', selection, target, release: 'x; rm -rf' },
    { protocol: 2, kind: 'run', selection, target, release: 'a'.repeat(129) },
    { protocol: 2, kind: 'run', selection, target: { serviceGeneration: 's' }, release: 'ok' },
    { protocol: 2, kind: 'read', selection, target, release: 'ok' },
    { protocol: 2, kind: 'run', selection, target, release: 'ok', extra: 1 },
  ];
  for (const bad of cases) assert.equal(helmUninstallRequestSchema.safeParse(bad).success === false, true, JSON.stringify(bad));
  assert.equal(releaseToken.safeParse('wandering-yak').success, true);
});
test('the arguments keep the upstream DEL alias verbatim with the pinned kubeconfig', () => {
  assert.deepEqual(helmUninstallArguments('my-release', '/resolved/kubeconfig'), ['--kubeconfig', '/resolved/kubeconfig', 'del', 'my-release']);
});
test('the response is a bounded discriminated pair with no output retention', () => {
  assert.equal(helmUninstallResponseSchema.safeParse({ protocol: 2, kind: 'helm-uninstalled', release: 'my-release' }).success, true);
  assert.equal(helmUninstallResponseSchema.safeParse({ protocol: 2, kind: 'helm-uninstalled', release: 'x'.repeat(129) }).success, false);
  assert.equal(helmUninstallResponseSchema.safeParse({ protocol: 2, kind: 'helm-uninstalled', release: 'ok', stdout: 'leak' }).success, false);
  assert.equal(helmUninstallResponseSchema.safeParse({ protocol: 2, kind: 'helm-uninstall-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(helmUninstallResponseSchema.safeParse({ protocol: 2, kind: 'helm-uninstall-unavailable', code: 'NOPE' }).success, false);
});
