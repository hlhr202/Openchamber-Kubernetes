// Pure protocol/projection values only. Never import/call the dry-run runner/client/operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmDryRunRequestSchema, helmDryRunResponseSchema, workspaceChartDirectory, pluginCacheDirectory, dryRunArguments, dryRunFailureCode } from '../../src/shared/helm-dryrun-protocol.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
import type { HelmRepositorySource } from '../../src/shared/helm-repository-protocol.ts';
const source: HelmRepositorySource = { paths: { repositoryFile: '/home/user/.config/helm/repositories.yaml', indexDirectory: '/home/user/.cache/helm/repository' }, origins: { repositoryFile: 'platform-default', indexDirectory: 'platform-default' } };
test('the request is a strict explicit run over canonical workspace locations', () => {
  assert.equal(helmDryRunRequestSchema.safeParse({ protocol: 2, kind: 'run', root: '/workspace/charts', path: 'mychart' }).success, true);
  assert.equal(helmDryRunRequestSchema.safeParse({ protocol: 2, kind: 'run', root: '/workspace/charts', path: '' }).success, true);
  for (const bad of [{ root: 'relative' }, { root: '/a/../b' }, { root: '/back\\slash' }, { root: '/ok', path: '../escape' }, { root: '/ok', kind: 'read' }, { root: '/ok', extra: 1 }]) assert.equal(helmDryRunRequestSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
});
test('the response echoes the probed syntax with bounded output only', () => {
  assert.equal(helmDryRunResponseSchema.safeParse({ protocol: 2, kind: 'helm-dry-ran', root: '/w', path: 'c', syntax: 'v3', content: 'NAME: mychart\n' }).success, true);
  assert.equal(helmDryRunResponseSchema.safeParse({ protocol: 2, kind: 'helm-dry-ran', root: '/w', path: 'c', syntax: 'unknown', content: '' }).success, true);
  assert.equal(helmDryRunResponseSchema.safeParse({ protocol: 2, kind: 'helm-dry-ran', root: '/w', path: 'c', syntax: 'v9', content: '' }).success, false);
  assert.equal(helmDryRunResponseSchema.safeParse({ protocol: 2, kind: 'helm-dry-ran', root: '/w', path: 'c', syntax: 'v2', content: 'x'.repeat(16_385) }).success, false);
  assert.equal(helmDryRunResponseSchema.safeParse({ protocol: 2, kind: 'helm-dry-ran', root: '/w', path: 'c', syntax: 'v2', content: 'ok', stderr: 'leak' }).success, false);
  assert.equal(helmDryRunResponseSchema.safeParse({ protocol: 2, kind: 'helm-dry-run-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(helmDryRunResponseSchema.safeParse({ protocol: 2, kind: 'helm-dry-run-unavailable', code: 'NOPE' }).success, false);
});
test('the install argument branch matches upstream verbatim across syntaxes', () => {
  assert.equal(workspaceChartDirectory('/workspace/charts', 'mychart'), '/workspace/charts/mychart');
  const v4 = dryRunArguments('v4', '/w', 'c', source, '/service/home').args;
  assert.deepEqual(v4, [`--repository-config=${source.paths.repositoryFile}`, '--repository-cache=/service/home/.openchamber-kubernetes/helm-cache/repository', 'install', '--dry-run=client', '--generate-name', '--debug', '/w/c']);
  const v3 = dryRunArguments('v3', '/w', 'c', source, '/service/home').args;
  assert.deepEqual(v3.slice(2, 7), ['install', '--dry-run', '--generate-name', '--debug', '/w/c']);
  const v2 = dryRunArguments('v2', '/w', 'c', source, '/service/home').args;
  assert.deepEqual(v2.slice(2, 6), ['install', '--dry-run', '--debug', '/w/c']); // v2 has no generate-name
  const unknown = dryRunArguments('unknown', '/w', 'c', source, '/service/home').args;
  assert.deepEqual(unknown.slice(2, 6), ['install', '--dry-run', '--debug', '/w/c']); // unknown follows upstream verbatim: only v3/v4 take --generate-name
  assert.equal(pluginCacheDirectory('/service/home'), '/service/home/.openchamber-kubernetes/helm-cache');
  for (const bad of ['', 'relative', '//double', 'C:\\users', '/x'.repeat(3000)]) assert.throws(() => pluginCacheDirectory(bad), /INVALID_INPUT/);
});
test('failure projection keeps fixed codes; dry-run failure never masquerades as success', () => {
  assert.equal(dryRunFailureCode(new BoundaryError('CLI_NOT_FOUND')), 'CLI_NOT_FOUND');
  assert.equal(dryRunFailureCode(new BoundaryError('QUERY_CANCELLED')), 'QUERY_CANCELLED');
  assert.equal(dryRunFailureCode(new BoundaryError('BUDGET_EXCEEDED')), 'BUDGET_EXCEEDED');
  assert.equal(dryRunFailureCode(new BoundaryError('STATE_UNAVAILABLE')), 'STATE_UNAVAILABLE');
  assert.equal(dryRunFailureCode(new Error('boom')), 'STATE_UNAVAILABLE');
});
