// Pure protocol/projection values only. Never import/call the dep-up runner/client/operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmDepUpRequestSchema, helmDepUpResponseSchema, workspaceChartDirectory, pluginCacheDirectory, depUpArguments, depUpFailureCode } from '../../src/shared/helm-depup-protocol.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
import type { HelmRepositorySource } from '../../src/shared/helm-repository-protocol.ts';
const source: HelmRepositorySource = { paths: { repositoryFile: '/home/user/.config/helm/repositories.yaml', indexDirectory: '/home/user/.cache/helm/repository' }, origins: { repositoryFile: 'platform-default', indexDirectory: 'platform-default' } };
test('the request is a strict explicit run over a canonical workspace chart directory', () => {
  assert.equal(helmDepUpRequestSchema.safeParse({ protocol: 2, kind: 'run', root: '/workspace/charts', path: 'mychart' }).success, true);
  assert.equal(helmDepUpRequestSchema.safeParse({ protocol: 2, kind: 'run', root: '/workspace/charts', path: '' }).success, true);
  for (const bad of [{ root: 'relative' }, { root: '/a/../b' }, { root: '/back\\slash' }, { root: '/ok', path: '../escape' }, { root: '/ok', kind: 'read' }, { root: '/ok', extra: 1 }]) assert.equal(helmDepUpRequestSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
});
test('the response carries only bounded stdout — success has no failure fields', () => {
  assert.equal(helmDepUpResponseSchema.safeParse({ protocol: 2, kind: 'helm-dep-updated', root: '/w', path: 'c', content: 'Saving 1 charts\nDeleting outdated charts\n' }).success, true);
  assert.equal(helmDepUpResponseSchema.safeParse({ protocol: 2, kind: 'helm-dep-updated', root: '/w', path: 'c', content: 'x'.repeat(16_385) }).success, false);
  assert.equal(helmDepUpResponseSchema.safeParse({ protocol: 2, kind: 'helm-dep-updated', root: '/w', path: 'c', content: 'ok', stderr: 'leak' }).success, false);
  assert.equal(helmDepUpResponseSchema.safeParse({ protocol: 2, kind: 'helm-dep-up-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(helmDepUpResponseSchema.safeParse({ protocol: 2, kind: 'helm-dep-up-unavailable', code: 'NOPE' }).success, false);
});
test('the arguments keep the upstream dep up shape with isolation flags and a canonical join', () => {
  assert.equal(workspaceChartDirectory('/workspace/charts', 'mychart'), '/workspace/charts/mychart');
  const { args } = depUpArguments('/w/charts', 'mychart', source, '/service/home');
  assert.deepEqual(args, [`--repository-config=${source.paths.repositoryFile}`, '--repository-cache=/service/home/.openchamber-kubernetes/helm-cache/repository', 'dep', 'up', '/w/charts/mychart']);
  const bare = depUpArguments('/w/charts', '', source, '/service/home').args;
  assert.deepEqual(bare.slice(2, 5), ['dep', 'up', '/w/charts']);
  assert.equal(pluginCacheDirectory('/service/home'), '/service/home/.openchamber-kubernetes/helm-cache');
  for (const bad of ['', 'relative', '//double', 'C:\\users', '/x'.repeat(3000)]) assert.throws(() => pluginCacheDirectory(bad), /INVALID_INPUT/);
});
test('failure projection keeps fixed codes; an update failure never claims success', () => {
  assert.equal(depUpFailureCode(new BoundaryError('CLI_NOT_FOUND')), 'CLI_NOT_FOUND');
  assert.equal(depUpFailureCode(new BoundaryError('QUERY_CANCELLED')), 'QUERY_CANCELLED');
  assert.equal(depUpFailureCode(new BoundaryError('BUDGET_EXCEEDED')), 'BUDGET_EXCEEDED');
  assert.equal(depUpFailureCode(new BoundaryError('STATE_UNAVAILABLE')), 'STATE_UNAVAILABLE');
  assert.equal(depUpFailureCode(new Error('boom')), 'STATE_UNAVAILABLE');
});
