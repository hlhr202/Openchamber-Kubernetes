// Pure protocol/projection values only. Never import/call the create runner/client/operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmCreateRequestSchema, helmCreateResponseSchema, helmChartName, workspaceChartDirectory, createdChartPath, pluginCacheDirectory, createArguments, createFailureCode } from '../../src/shared/helm-create-protocol.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
import type { HelmRepositorySource } from '../../src/shared/helm-repository-protocol.ts';
const source: HelmRepositorySource = { paths: { repositoryFile: '/home/user/.config/helm/repositories.yaml', indexDirectory: '/home/user/.cache/helm/repository' }, origins: { repositoryFile: 'platform-default', indexDirectory: 'platform-default' } };
test('the request requires a canonical parent location and a bounded chart name', () => {
  assert.equal(helmCreateRequestSchema.safeParse({ protocol: 2, kind: 'run', root: '/w/charts', path: '', name: 'mychart' }).success, true);
  assert.equal(helmCreateRequestSchema.safeParse({ protocol: 2, kind: 'run', root: '/w/charts', path: 'sub', name: 'my.chart-2' }).success, true);
  for (const bad of [{ root: 'relative' }, { root: '/w', name: '' }, { root: '/w', name: '-lead' }, { root: '/w', name: 'x y' }, { root: '/w', name: 'x; rm -rf' }, { root: '/w', name: 'a'.repeat(129) }, { root: '/w', name: 'ok', path: '../escape' }, { root: '/w', name: 'ok', kind: 'read' }]) assert.equal(helmCreateRequestSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
  assert.equal(helmChartName.safeParse('mychart').success, true);
});
test('the response echoes the created location with bounded stdout only', () => {
  assert.equal(helmCreateResponseSchema.safeParse({ protocol: 2, kind: 'helm-chart-created', root: '/w', path: '', name: 'mychart', content: 'Creating mychart\n' }).success, true);
  assert.equal(helmCreateResponseSchema.safeParse({ protocol: 2, kind: 'helm-chart-created', root: '/w', path: 'sub', name: 'c', content: 'x'.repeat(16_385) }).success, false);
  assert.equal(helmCreateResponseSchema.safeParse({ protocol: 2, kind: 'helm-chart-created', root: '/w', path: '', name: 'c', content: 'ok', stderr: 'leak' }).success, false);
  assert.equal(helmCreateResponseSchema.safeParse({ protocol: 2, kind: 'helm-chart-create-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(helmCreateResponseSchema.safeParse({ protocol: 2, kind: 'helm-chart-create-unavailable', code: 'NOPE' }).success, false);
});
test('the created path is a canonical join and the args keep isolation flags', () => {
  assert.equal(workspaceChartDirectory('/w/charts', ''), '/w/charts');
  assert.equal(createdChartPath('/w/charts', 'sub', 'mychart'), '/w/charts/sub/mychart');
  const { args } = createArguments('/w/charts', 'sub', 'mychart', source, '/service/home');
  assert.deepEqual(args, [`--repository-config=${source.paths.repositoryFile}`, '--repository-cache=/service/home/.openchamber-kubernetes/helm-cache/repository', 'create', '/w/charts/sub/mychart']);
  const bare = createArguments('/w/charts', '', 'c', source, '/service/home').args;
  assert.deepEqual(bare.slice(2), ['create', '/w/charts/c']);
  assert.equal(pluginCacheDirectory('/service/home'), '/service/home/.openchamber-kubernetes/helm-cache');
  for (const bad of ['', 'relative', '//double', 'C:\\users', '/x'.repeat(3000)]) assert.throws(() => pluginCacheDirectory(bad), /INVALID_INPUT/);
});
test('failure projection keeps fixed codes; a create failure never claims success', () => {
  assert.equal(createFailureCode(new BoundaryError('CLI_NOT_FOUND')), 'CLI_NOT_FOUND');
  assert.equal(createFailureCode(new BoundaryError('QUERY_CANCELLED')), 'QUERY_CANCELLED');
  assert.equal(createFailureCode(new BoundaryError('BUDGET_EXCEEDED')), 'BUDGET_EXCEEDED');
  assert.equal(createFailureCode(new BoundaryError('STATE_UNAVAILABLE')), 'STATE_UNAVAILABLE');
  assert.equal(createFailureCode(new Error('boom')), 'STATE_UNAVAILABLE');
});
