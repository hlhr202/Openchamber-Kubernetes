// Pure protocol/projection values only. Never import/call the fetch runner/client/operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmFetchRequestSchema, helmFetchResponseSchema, workspaceChartDirectory, pluginCacheDirectory, fetchArguments, fetchFailureCode } from '../../src/shared/helm-fetch-protocol.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
import type { HelmRepositorySource } from '../../src/shared/helm-repository-protocol.ts';
const source: HelmRepositorySource = { paths: { repositoryFile: '/home/user/.config/helm/repositories.yaml', indexDirectory: '/home/user/.cache/helm/repository' }, origins: { repositoryFile: 'platform-default', indexDirectory: 'platform-default' } };
test('the request reuses the strict inspect token schemas and requires a canonical destination', () => {
  assert.equal(helmFetchRequestSchema.safeParse({ protocol: 2, kind: 'run', chart: 'bitnami/nginx', root: '/w/charts', path: 'deps' }).success, true);
  assert.equal(helmFetchRequestSchema.safeParse({ protocol: 2, kind: 'run', chart: 'bitnami/nginx', version: '1.2.3', root: '/w/charts', path: '' }).success, true);
  for (const bad of [{ chart: 'x; rm -rf' }, { chart: '' }, { chart: 'a'.repeat(256) }, { chart: 'ok', version: '1 2' }, { chart: 'ok', root: 'relative' }, { chart: 'ok', root: '/w', path: '../escape' }, { chart: 'ok', root: '/w', kind: 'read' }, { chart: 'ok', root: '/w', extra: 1 }]) assert.equal(helmFetchRequestSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
});
test('the response echoes chart, version and destination with bounded stdout only', () => {
  assert.equal(helmFetchResponseSchema.safeParse({ protocol: 2, kind: 'helm-fetched', chart: 'r/c', root: '/w', path: 'deps', content: '' }).success, true);
  assert.equal(helmFetchResponseSchema.safeParse({ protocol: 2, kind: 'helm-fetched', chart: 'r/c', version: '1.0.0', root: '/w', path: '', content: 'x'.repeat(16_385) }).success, false);
  assert.equal(helmFetchResponseSchema.safeParse({ protocol: 2, kind: 'helm-fetched', chart: 'r/c', root: '/w', path: '', content: 'ok', stderr: 'leak' }).success, false);
  assert.equal(helmFetchResponseSchema.safeParse({ protocol: 2, kind: 'helm-fetch-unavailable', code: 'HELM_INDEX_MISSING' }).success, true);
  assert.equal(helmFetchResponseSchema.safeParse({ protocol: 2, kind: 'helm-fetch-unavailable', code: 'NOPE' }).success, false);
});
test('the arguments keep the upstream --untar -d shape with isolation flags and canonical joins', () => {
  assert.equal(workspaceChartDirectory('/w/charts', 'deps'), '/w/charts/deps');
  const withVersion = fetchArguments('bitnami/nginx', '1.2.3', '/w/charts', 'deps', source, '/service/home');
  assert.deepEqual(withVersion.args, [`--repository-config=${source.paths.repositoryFile}`, '--repository-cache=/service/home/.openchamber-kubernetes/helm-cache/repository', 'fetch', 'bitnami/nginx', '--untar', '--version', '1.2.3', '-d', '/w/charts/deps']);
  const bare = fetchArguments('bitnami/nginx', undefined, '/w/charts', '', source, '/service/home').args;
  assert.deepEqual(bare.slice(2), ['fetch', 'bitnami/nginx', '--untar', '-d', '/w/charts']);
  assert.equal(pluginCacheDirectory('/service/home'), '/service/home/.openchamber-kubernetes/helm-cache');
  for (const bad of ['', 'relative', '//double', 'C:\\users', '/x'.repeat(3000)]) assert.throws(() => pluginCacheDirectory(bad), /INVALID_INPUT/);
});
test('failure projection keeps fixed codes including the missing-chart case; never invents one', () => {
  assert.equal(fetchFailureCode(new BoundaryError('CLI_NOT_FOUND')), 'CLI_NOT_FOUND');
  assert.equal(fetchFailureCode(new BoundaryError('HELM_INDEX_MISSING')), 'HELM_INDEX_MISSING');
  assert.equal(fetchFailureCode(new BoundaryError('QUERY_CANCELLED')), 'QUERY_CANCELLED');
  assert.equal(fetchFailureCode(new BoundaryError('BUDGET_EXCEEDED')), 'BUDGET_EXCEEDED');
  assert.equal(fetchFailureCode(new Error('boom')), 'STATE_UNAVAILABLE');
  assert.equal(fetchFailureCode(new BoundaryError('DOCUMENT_DIRTY')), 'STATE_UNAVAILABLE');
});
