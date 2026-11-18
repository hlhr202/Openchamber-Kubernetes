// Pure protocol/projection values only. Never import/call the inspect runner/client/operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmInspectRequestSchema, helmInspectResponseSchema, inspectScope, pluginCacheDirectory, helmInspectArguments, inspectFailureCode } from '../../src/shared/helm-inspect-protocol.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
import type { HelmRepositorySource } from '../../src/shared/helm-repository-protocol.ts';
const source: HelmRepositorySource = { paths: { repositoryFile: '/home/user/.config/helm/repositories.yaml', indexDirectory: '/home/user/.cache/helm/repository' }, origins: { repositoryFile: 'platform-default', indexDirectory: 'platform-default' } };
test('the request is a strict bounded read pair and unsafe chart/version tokens are rejected', () => {
  assert.equal(helmInspectRequestSchema.safeParse({ protocol: 2, kind: 'read', chart: 'bitnami/nginx' }).success, true);
  assert.equal(helmInspectRequestSchema.safeParse({ protocol: 2, kind: 'read', chart: 'bitnami/nginx', version: '1.2.3' }).success, true);
  for (const bad of [{ chart: '' }, { chart: 'x; rm -rf' }, { chart: 'x $(id)' }, { chart: 'x\n' }, { chart: '/leading-slash' }, { chart: 'a'.repeat(256) }, { chart: 'ok', version: '1 2' }, { chart: 'ok', version: '--version' }, { chart: 'ok', version: 'a'.repeat(64) }, { chart: 'ok', extra: 1 }]) assert.equal(helmInspectRequestSchema.safeParse({ protocol: 2, kind: 'read', ...bad }).success === false, true, JSON.stringify(bad));
});
test('the response is a discriminated pair with bounded preview text only', () => {
  assert.equal(helmInspectResponseSchema.safeParse({ protocol: 2, kind: 'helm-chart-inspected', chart: 'r/c', content: 'apiVersion: v2\nname: c\n' }).success, true);
  assert.equal(helmInspectResponseSchema.safeParse({ protocol: 2, kind: 'helm-chart-inspected', chart: 'r/c', version: '1.0.0', content: '' }).success, true);
  assert.equal(helmInspectResponseSchema.safeParse({ protocol: 2, kind: 'helm-chart-inspected', chart: 'r/c', content: 'x'.repeat(16_385) }).success, false);
  assert.equal(helmInspectResponseSchema.safeParse({ protocol: 2, kind: 'helm-chart-inspected', chart: 'r/c', stderr: 'leak' }).success, false);
  assert.equal(helmInspectResponseSchema.safeParse({ protocol: 2, kind: 'helm-chart-inspect-unavailable', code: 'CLI_NOT_FOUND' }).success, true);
  assert.equal(helmInspectResponseSchema.safeParse({ protocol: 2, kind: 'helm-chart-inspect-unavailable', code: 'NOPE' }).success, false);
});
test('the inspect scope follows upstream exactly: only v2 omits the all scope', () => {
  assert.equal(inspectScope('v2'), 'none'); assert.equal(inspectScope('v3'), 'all'); assert.equal(inspectScope('v4'), 'all'); assert.equal(inspectScope('unknown'), 'all');
});
test('helm receives the user repository file read-only, the isolated cache redirect, and shaped tokens', () => {
  const v3 = helmInspectArguments('v3', 'bitnami/nginx', '1.2.3', source, '/service/home');
  assert.deepEqual(v3.args, [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${v3.cache}`, 'inspect', 'all', 'bitnami/nginx', '--version', '1.2.3']);
  const v2 = helmInspectArguments('v2', 'bitnami/nginx', undefined, source, '/service/home');
  assert.deepEqual(v2.args, [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${v2.cache}`, 'inspect', 'bitnami/nginx']);
  assert.equal(v3.cache, '/service/home/.openchamber-kubernetes/helm-cache/repository');
  assert.ok(!v3.cache.startsWith(source.paths.indexDirectory));
  for (const bad of ['', 'relative', '//double', 'C:\\users', '/x'.repeat(3000)]) assert.throws(() => pluginCacheDirectory(bad), /INVALID_INPUT/);
});
test('failure projection keeps fixed codes and never invents one', () => {
  assert.equal(inspectFailureCode(new BoundaryError('CLI_NOT_FOUND')), 'CLI_NOT_FOUND');
  assert.equal(inspectFailureCode(new BoundaryError('HELM_INDEX_MISSING')), 'HELM_INDEX_MISSING');
  assert.equal(inspectFailureCode(new BoundaryError('QUERY_CANCELLED')), 'QUERY_CANCELLED');
  assert.equal(inspectFailureCode(new BoundaryError('BUDGET_EXCEEDED')), 'BUDGET_EXCEEDED');
  assert.equal(inspectFailureCode(new Error('boom')), 'STATE_UNAVAILABLE');
  assert.equal(inspectFailureCode(new BoundaryError('DOCUMENT_DIRTY')), 'STATE_UNAVAILABLE');
});
