// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmInstallRequestSchema, helmInstallResponseSchema, installGenerateName, helmInstallArguments, extractReleaseName } from '../../src/shared/helm-install-protocol.ts';
const target = { serviceGeneration: 's', projectId: 'p', configIdentity: 'a'.repeat(64), context: 'ctx', namespace: 'default' };
const selection = { mode: 'default' } as const;
test('the request binds target/selection with the shared chart/version token schemas', () => {
  assert.equal(helmInstallRequestSchema.safeParse({ protocol: 2, kind: 'run', selection, target, chart: 'bitnami/nginx' }).success, true);
  assert.equal(helmInstallRequestSchema.safeParse({ protocol: 2, kind: 'run', selection, target, chart: 'bitnami/nginx', version: '1.2.3' }).success, true);
  const cases: unknown[] = [
    { protocol: 2, kind: 'run', selection, target, chart: 'x; rm -rf' },
    { protocol: 2, kind: 'run', selection, target, chart: '' },
    { protocol: 2, kind: 'run', selection, target, chart: 'a'.repeat(256) },
    { protocol: 2, kind: 'run', selection, target, chart: 'ok', version: '1 2' },
    { protocol: 2, kind: 'run', selection, target: { serviceGeneration: 's' }, chart: 'ok' },
    { protocol: 2, kind: 'read', selection, target, chart: 'ok' },
    { protocol: 2, kind: 'run', selection, target, chart: 'ok', extra: 1 },
  ];
  for (const bad of cases) assert.equal(helmInstallRequestSchema.safeParse(bad).success === false, true, JSON.stringify(bad));
});
test('generate-name follows upstream: only v3 and v4', () => {
  assert.equal(installGenerateName('v2'), false); assert.equal(installGenerateName('v3'), true); assert.equal(installGenerateName('v4'), true); assert.equal(installGenerateName('unknown'), false);
});
test('the arguments keep the upstream order with the pinned kubeconfig and target namespace', () => {
  assert.deepEqual(helmInstallArguments('v4', 'bitnami/nginx', '1.2.3', 'prod', '/k'), ['--kubeconfig', '/k', 'install', 'bitnami/nginx', '--version', '1.2.3', '--namespace', 'prod', '--generate-name']);
  assert.deepEqual(helmInstallArguments('v2', 'stable/redis', undefined, 'dev', '/k'), ['--kubeconfig', '/k', 'install', 'stable/redis', '--namespace', 'dev']);
  assert.deepEqual(helmInstallArguments('unknown', 'stable/redis', undefined, 'dev', '/k').slice(-1), ['--namespace', 'dev'].slice(-1));
});
test('release-name extraction is the upstream NAME: port with the verbatim fallback', () => {
  assert.equal(extractReleaseName('NAME: wandering-yak\nLAST DEPLOYED: ...\n'), 'wandering-yak');
  assert.equal(extractReleaseName('  NAME:   spaced-name  \n'), 'spaced-name');
  assert.equal(extractReleaseName('NAMES:\n'), '(unknown)'); // NAMES: does not start with NAME:
  assert.equal(extractReleaseName('no line\n'), '(unknown)');
  assert.equal(extractReleaseName('NAME:\n'), '(unknown)');
  assert.equal(helmInstallResponseSchema.safeParse({ protocol: 2, kind: 'helm-installed', chart: 'r/c', releaseName: 'wandering-yak', syntax: 'v3' }).success, true);
  assert.equal(helmInstallResponseSchema.safeParse({ protocol: 2, kind: 'helm-installed', chart: 'r/c', releaseName: 'x'.repeat(129), syntax: 'v3' }).success, false);
  assert.equal(helmInstallResponseSchema.safeParse({ protocol: 2, kind: 'helm-install-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(helmInstallResponseSchema.safeParse({ protocol: 2, kind: 'helm-install-unavailable', code: 'NOPE' }).success, false);
});
