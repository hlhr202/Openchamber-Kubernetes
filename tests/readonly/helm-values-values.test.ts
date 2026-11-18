// Pure protocol/projection values only. Never import/call the values runner/client/operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmValuesRequestSchema, helmValuesResponseSchema, pluginCacheDirectory, helmValuesArguments, valuesFailureCode } from '../../src/shared/helm-values-protocol.ts';
import { helmChartReference } from '../../src/shared/helm-inspect-protocol.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
import type { HelmRepositorySource } from '../../src/shared/helm-repository-protocol.ts';
const source: HelmRepositorySource = { paths: { repositoryFile: '/home/user/.config/helm/repositories.yaml', indexDirectory: '/home/user/.cache/helm/repository' }, origins: { repositoryFile: 'platform-default', indexDirectory: 'platform-default' } };
test('the request reuses the strict inspect token schemas verbatim', () => {
  assert.equal(helmValuesRequestSchema.safeParse({ protocol: 2, kind: 'read', chart: 'bitnami/nginx' }).success, true);
  assert.equal(helmValuesRequestSchema.safeParse({ protocol: 2, kind: 'read', chart: 'bitnami/nginx', version: '1.2.3' }).success, true);
  for (const bad of [{ chart: 'x; rm -rf' }, { chart: '' }, { chart: 'a'.repeat(256) }, { chart: 'ok', version: '1 2' }, { chart: 'ok', extra: 1 }]) assert.equal(helmValuesRequestSchema.safeParse({ protocol: 2, kind: 'read', ...bad }).success === false, true, JSON.stringify(bad));
  assert.equal(helmChartReference.safeParse('stable/mysql').success, true); // shared schema, not a copy
});
test('the response is a discriminated pair with bounded preview text and no stderr field', () => {
  assert.equal(helmValuesResponseSchema.safeParse({ protocol: 2, kind: 'helm-values-fetched', chart: 'r/c', content: 'replicaCount: 1\n' }).success, true);
  assert.equal(helmValuesResponseSchema.safeParse({ protocol: 2, kind: 'helm-values-fetched', chart: 'r/c', version: '1.0.0', content: '' }).success, true);
  assert.equal(helmValuesResponseSchema.safeParse({ protocol: 2, kind: 'helm-values-fetched', chart: 'r/c', content: 'x'.repeat(16_385) }).success, false);
  assert.equal(helmValuesResponseSchema.safeParse({ protocol: 2, kind: 'helm-values-fetched', chart: 'r/c', savedTo: '/disk/path' }).success, false);
  assert.equal(helmValuesResponseSchema.safeParse({ protocol: 2, kind: 'helm-values-fetch-unavailable', code: 'CLI_NOT_FOUND' }).success, true);
  assert.equal(helmValuesResponseSchema.safeParse({ protocol: 2, kind: 'helm-values-fetch-unavailable', code: 'NOPE' }).success, false);
});
test('the values command NEVER takes the all scope and keeps the isolation flags', () => {
  const withVersion = helmValuesArguments('bitnami/nginx', '1.2.3', source, '/service/home');
  assert.deepEqual(withVersion.args, [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${withVersion.cache}`, 'inspect', 'values', 'bitnami/nginx', '--version', '1.2.3']);
  const bare = helmValuesArguments('bitnami/nginx', undefined, source, '/service/home');
  assert.deepEqual(bare.args, [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${bare.cache}`, 'inspect', 'values', 'bitnami/nginx']);
  assert.ok(!withVersion.args.includes('all'));
  assert.equal(withVersion.cache, '/service/home/.openchamber-kubernetes/helm-cache/repository');
  assert.ok(!withVersion.cache.startsWith(source.paths.indexDirectory));
  for (const bad of ['', 'relative', '//double', 'C:\\users', '/x'.repeat(3000)]) assert.throws(() => pluginCacheDirectory(bad), /INVALID_INPUT/);
});
test('failure projection keeps fixed codes and never invents one', () => {
  assert.equal(valuesFailureCode(new BoundaryError('CLI_NOT_FOUND')), 'CLI_NOT_FOUND');
  assert.equal(valuesFailureCode(new BoundaryError('HELM_INDEX_MISSING')), 'HELM_INDEX_MISSING');
  assert.equal(valuesFailureCode(new BoundaryError('BUDGET_EXCEEDED')), 'BUDGET_EXCEEDED');
  assert.equal(valuesFailureCode(new BoundaryError('QUERY_CANCELLED')), 'QUERY_CANCELLED');
  assert.equal(valuesFailureCode(new Error('boom')), 'STATE_UNAVAILABLE');
  assert.equal(valuesFailureCode(new BoundaryError('DOCUMENT_DIRTY')), 'STATE_UNAVAILABLE');
});
