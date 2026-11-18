// Pure protocol/projection values only. Never import/call the dependencies runner/client/operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmDependenciesRequestSchema, helmDependenciesResponseSchema, pluginCacheDirectory, pluginTempRoot, helmDependencyFetchArguments, helmDependencyListArguments, parseDependencyTable, dependenciesFailureCode } from '../../src/shared/helm-dependencies-protocol.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
import type { HelmRepositorySource } from '../../src/shared/helm-repository-protocol.ts';
const source: HelmRepositorySource = { paths: { repositoryFile: '/home/user/.config/helm/repositories.yaml', indexDirectory: '/home/user/.cache/helm/repository' }, origins: { repositoryFile: 'platform-default', indexDirectory: 'platform-default' } };
test('the request reuses the strict shared token schemas verbatim', () => {
  assert.equal(helmDependenciesRequestSchema.safeParse({ protocol: 2, kind: 'read', chart: 'bitnami/nginx' }).success, true);
  assert.equal(helmDependenciesRequestSchema.safeParse({ protocol: 2, kind: 'read', chart: 'bitnami/nginx', version: '1.2.3' }).success, true);
  for (const bad of [{ chart: 'x; rm -rf' }, { chart: '' }, { chart: 'a'.repeat(256) }, { chart: 'ok', version: '1 2' }, { chart: 'ok', extra: 1 }]) assert.equal(helmDependenciesRequestSchema.safeParse({ protocol: 2, kind: 'read', ...bad }).success === false, true, JSON.stringify(bad));
});
test('the response is a bounded table pair and cannot claim raw text or saved paths', () => {
  assert.equal(helmDependenciesResponseSchema.safeParse({ protocol: 2, kind: 'helm-dependencies', chart: 'r/c', headers: ['NAME', 'VERSION', 'REPOSITORY', 'STATUS'], rows: [['sub', '1.0.0', 'https://charts.example.com', 'ok']] }).success, true);
  assert.equal(helmDependenciesResponseSchema.safeParse({ protocol: 2, kind: 'helm-dependencies', chart: 'r/c', headers: [], rows: [] }).success, true);
  assert.equal(helmDependenciesResponseSchema.safeParse({ protocol: 2, kind: 'helm-dependencies', chart: 'r/c', headers: ['A'], rows: Array.from({ length: 65 }, () => ['x']) }).success, false);
  assert.equal(helmDependenciesResponseSchema.safeParse({ protocol: 2, kind: 'helm-dependencies', chart: 'r/c', headers: ['A'], rows: [['x'.repeat(257)]] }).success, false);
  assert.equal(helmDependenciesResponseSchema.safeParse({ protocol: 2, kind: 'helm-dependencies', chart: 'r/c', stdout: 'raw' }).success, false);
  assert.equal(helmDependenciesResponseSchema.safeParse({ protocol: 2, kind: 'helm-dependencies-unavailable', code: 'CLI_NOT_FOUND' }).success, true);
  assert.equal(helmDependenciesResponseSchema.safeParse({ protocol: 2, kind: 'helm-dependencies-unavailable', code: 'NOPE' }).success, false);
});
test('fetch takes the isolation flags and the plugin-owned temp target; dep list is the upstream literal', () => {
  const withVersion = helmDependencyFetchArguments('bitnami/nginx', '1.2.3', '/service/home/.openchamber-kubernetes/helm-tmp/vsk-fetchfordeps-X', source, '/service/home');
  assert.deepEqual(withVersion.args, [`--repository-config=${source.paths.repositoryFile}`, '--repository-cache=/service/home/.openchamber-kubernetes/helm-cache/repository', 'fetch', 'bitnami/nginx', '--version', '1.2.3', '-d', '/service/home/.openchamber-kubernetes/helm-tmp/vsk-fetchfordeps-X']);
  const bare = helmDependencyFetchArguments('bitnami/nginx', undefined, '/t', source, '/service/home');
  assert.deepEqual(bare.args.slice(2, 4), ['fetch', 'bitnami/nginx']);
  assert.deepEqual(helmDependencyListArguments('/t/nginx-1.2.3.tgz'), ['dep', 'list', '/t/nginx-1.2.3.tgz']);
  assert.equal(pluginCacheDirectory('/service/home'), '/service/home/.openchamber-kubernetes/helm-cache');
  assert.equal(pluginTempRoot('/service/home'), '/service/home/.openchamber-kubernetes/helm-tmp');
  for (const bad of ['', 'relative', '//double', 'C:\\users', '/x'.repeat(3000)]) { assert.throws(() => pluginCacheDirectory(bad), /INVALID_INPUT/); assert.throws(() => pluginTempRoot(bad), /INVALID_INPUT/); }
});
test('table projection keeps the upstream tab shape: first line headers, header-only means none', () => {
  const table = parseDependencyTable('NAME\tVERSION\tREPOSITORY\tSTATUS\nsub\t1.0.0\thttps://charts.example.com\tok\n');
  assert.deepEqual(table.headers, ['NAME', 'VERSION', 'REPOSITORY', 'STATUS']);
  assert.deepEqual(table.rows, [['sub', '1.0.0', 'https://charts.example.com', 'ok']]);
  const headerOnly = parseDependencyTable('NAME\tVERSION\tREPOSITORY\tSTATUS\n');
  assert.deepEqual(headerOnly.rows, []);
  assert.deepEqual(parseDependencyTable('').headers, []);
  const wide = parseDependencyTable(`H\n${'a\tb\tc\td\te\n'.repeat(70)}`);
  assert.ok(wide.rows.length <= 64 && wide.rows.every(row => row.length <= 4 && row.every(cell => cell.length <= 256)));
});
test('failure projection keeps fixed codes and never invents one', () => {
  assert.equal(dependenciesFailureCode(new BoundaryError('CLI_NOT_FOUND')), 'CLI_NOT_FOUND');
  assert.equal(dependenciesFailureCode(new BoundaryError('HELM_INDEX_MISSING')), 'HELM_INDEX_MISSING');
  assert.equal(dependenciesFailureCode(new BoundaryError('BUDGET_EXCEEDED')), 'BUDGET_EXCEEDED');
  assert.equal(dependenciesFailureCode(new BoundaryError('QUERY_CANCELLED')), 'QUERY_CANCELLED');
  assert.equal(dependenciesFailureCode(new Error('boom')), 'STATE_UNAVAILABLE');
  assert.equal(dependenciesFailureCode(new BoundaryError('DOCUMENT_DIRTY')), 'STATE_UNAVAILABLE');
});
