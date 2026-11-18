// Pure protocol/projection values only. Never import/call the refresh runner/client/operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmRefreshRequestSchema, helmRefreshResponseSchema, countUpdatedRepositories, pluginCacheDirectory, helmRefreshArguments, refreshFailureCode } from '../../src/shared/helm-refresh-protocol.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
import type { HelmRepositorySource } from '../../src/shared/helm-repository-protocol.ts';
const source: HelmRepositorySource = { paths: { repositoryFile: '/home/user/.config/helm/repositories.yaml', indexDirectory: '/home/user/.cache/helm/repository' }, origins: { repositoryFile: 'platform-default', indexDirectory: 'platform-default' } };
test('the request carries no target/source/body and the response is a discriminated fixed pair', () => {
  assert.equal(helmRefreshRequestSchema.safeParse({ protocol: 2, kind: 'run' }).success, true);
  for (const extra of [{ argv: ['repo', 'update'] }, { path: '/x' }, { selection: { mode: 'default' } }, { body: 'x' }]) assert.equal(helmRefreshRequestSchema.safeParse({ protocol: 2, kind: 'run', ...extra }).success === false, true);
  assert.equal(helmRefreshResponseSchema.safeParse({ protocol: 2, kind: 'helm-repo-refreshed' }).success, true);
  assert.equal(helmRefreshResponseSchema.safeParse({ protocol: 2, kind: 'helm-repo-refresh-unavailable', code: 'CLI_NOT_FOUND' }).success, true);
  assert.equal(helmRefreshResponseSchema.safeParse({ protocol: 2, kind: 'helm-repo-refresh-unavailable', code: 'NOPE' }).success, false);
  assert.equal(helmRefreshResponseSchema.safeParse({ protocol: 2, kind: 'helm-repo-refreshed', stdout: 'raw' }).success, false);
});
test('the plugin cache directory stays under the service home and never touches the user cache', () => {
  assert.equal(pluginCacheDirectory('/service/home'), '/service/home/.openchamber-kubernetes/helm-cache');
  assert.equal(pluginCacheDirectory('/service/home/'), '/service/home/.openchamber-kubernetes/helm-cache');
  assert.ok(!pluginCacheDirectory('/service/home').includes('var/empty') && !pluginCacheDirectory('/service/home').includes('/.cache/helm'));
  for (const bad of ['', 'relative', '//double', 'C:\\users', '/x'.repeat(3000), '/home/\u0000user']) assert.throws(() => pluginCacheDirectory(bad), /INVALID_INPUT/);
});
test('helm receives the user repository file read-only and ONLY the plugin cache redirected', () => {
  const { args, cache } = helmRefreshArguments(source, '/service/home');
  assert.deepEqual(args, [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${cache}`, 'repo', 'update']);
  assert.equal(cache, '/service/home/.openchamber-kubernetes/helm-cache/repository');
  assert.ok(cache.startsWith('/service/home/.openchamber-kubernetes/helm-cache/'));
  assert.ok(!cache.startsWith(source.paths.indexDirectory));
  assert.throws(() => helmRefreshArguments(source, 'relative'), /INVALID_INPUT/); // a bad service home is rejected before any cache path is derived
});
test('update-count projection never surfaces raw stdout (repository URLs stay private)', () => {
  assert.equal(countUpdatedRepositories('Hang tight while we grab the latest from your chart repositories...\n...Successfully got an update from the "stable" chart repository\n...Successfully got an update from the "bitnami" chart repository\nUpdate Complete. ⎈Happy Helming!⎈\n'), 2);
  assert.equal(countUpdatedRepositories(''), 0);
  assert.equal(countUpdatedRepositories('no markers here'), 0);
});
test('failure projection keeps fixed codes, including cancelled and missing CLI', () => {
  assert.equal(refreshFailureCode(new BoundaryError('CLI_NOT_FOUND')), 'CLI_NOT_FOUND');
  assert.equal(refreshFailureCode(new BoundaryError('QUERY_CANCELLED')), 'QUERY_CANCELLED');
  assert.equal(refreshFailureCode(new BoundaryError('HELM_INDEX_MISSING')), 'HELM_INDEX_MISSING');
  assert.equal(refreshFailureCode(new Error('boom')), 'STATE_UNAVAILABLE');
  assert.equal(refreshFailureCode(new BoundaryError('DOCUMENT_DIRTY')), 'STATE_UNAVAILABLE');
});
