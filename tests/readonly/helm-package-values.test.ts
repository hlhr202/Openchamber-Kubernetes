// Pure protocol/projection values only. Never import/call the package runner/client/operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmPackageRequestSchema, helmPackageResponseSchema, workspaceChartDirectory, pluginCacheDirectory, packageArguments, packageFailureCode } from '../../src/shared/helm-package-protocol.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
import type { HelmRepositorySource } from '../../src/shared/helm-repository-protocol.ts';
const source: HelmRepositorySource = { paths: { repositoryFile: '/home/user/.config/helm/repositories.yaml', indexDirectory: '/home/user/.cache/helm/repository' }, origins: { repositoryFile: 'platform-default', indexDirectory: 'platform-default' } };
test('the request requires BOTH canonical chart and destination locations', () => {
  assert.equal(helmPackageRequestSchema.safeParse({ protocol: 2, kind: 'run', root: '/w/charts', path: 'mychart', destinationRoot: '/w/packages', destinationPath: 'out' }).success, true);
  assert.equal(helmPackageRequestSchema.safeParse({ protocol: 2, kind: 'run', root: '/w', path: '', destinationRoot: '/w/packages', destinationPath: '' }).success, true);
  for (const bad of [{ root: 'relative' }, { root: '/w', destinationRoot: 'relative' }, { root: '/w', destinationRoot: '/d', path: '../escape' }, { root: '/w', destinationRoot: '/d', destinationPath: '../escape' }, { root: '/w', destinationRoot: '/d', kind: 'read' }, { root: '/w', destinationRoot: '/d', extra: 1 }]) assert.equal(helmPackageRequestSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
});
test('the response echoes both locations with bounded stdout only', () => {
  assert.equal(helmPackageResponseSchema.safeParse({ protocol: 2, kind: 'helm-packaged', root: '/w', path: 'c', destinationRoot: '/d', destinationPath: 'out', content: 'Successfully packaged chart and saved it to: /d/out/c-1.0.0.tgz\n' }).success, true);
  assert.equal(helmPackageResponseSchema.safeParse({ protocol: 2, kind: 'helm-packaged', root: '/w', path: 'c', destinationRoot: '/d', destinationPath: '', content: 'x'.repeat(16_385) }).success, false);
  assert.equal(helmPackageResponseSchema.safeParse({ protocol: 2, kind: 'helm-packaged', root: '/w', path: 'c', destinationRoot: '/d', destinationPath: '', content: 'ok', stderr: 'leak' }).success, false);
  assert.equal(helmPackageResponseSchema.safeParse({ protocol: 2, kind: 'helm-package-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(helmPackageResponseSchema.safeParse({ protocol: 2, kind: 'helm-package-unavailable', code: 'NOPE' }).success, false);
});
test('the arguments keep the upstream -d shape with isolation flags and canonical joins', () => {
  assert.equal(workspaceChartDirectory('/w/charts', 'mychart'), '/w/charts/mychart');
  const { args } = packageArguments('/w/charts', 'mychart', '/w/packages', 'out', source, '/service/home');
  assert.deepEqual(args, [`--repository-config=${source.paths.repositoryFile}`, '--repository-cache=/service/home/.openchamber-kubernetes/helm-cache/repository', 'package', '/w/charts/mychart', '-d', '/w/packages/out']);
  const bare = packageArguments('/w/charts', '', '/w/packages', '', source, '/service/home').args;
  assert.deepEqual(bare.slice(2, 6), ['package', '/w/charts', '-d', '/w/packages']);
  assert.equal(pluginCacheDirectory('/service/home'), '/service/home/.openchamber-kubernetes/helm-cache');
  for (const bad of ['', 'relative', '//double', 'C:\\users', '/x'.repeat(3000)]) assert.throws(() => pluginCacheDirectory(bad), /INVALID_INPUT/);
});
test('failure projection keeps fixed codes; packaging failure never claims success', () => {
  assert.equal(packageFailureCode(new BoundaryError('CLI_NOT_FOUND')), 'CLI_NOT_FOUND');
  assert.equal(packageFailureCode(new BoundaryError('QUERY_CANCELLED')), 'QUERY_CANCELLED');
  assert.equal(packageFailureCode(new BoundaryError('BUDGET_EXCEEDED')), 'BUDGET_EXCEEDED');
  assert.equal(packageFailureCode(new BoundaryError('STATE_UNAVAILABLE')), 'STATE_UNAVAILABLE');
  assert.equal(packageFailureCode(new Error('boom')), 'STATE_UNAVAILABLE');
});
