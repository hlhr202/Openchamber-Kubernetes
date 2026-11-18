// Pure protocol/projection values only. Never import/call the lint runner/client/operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmLintRequestSchema, helmLintResponseSchema, workspaceChartDirectory, pluginCacheDirectory, helmLintArguments, lintFailureCode } from '../../src/shared/helm-lint-protocol.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
import type { HelmRepositorySource } from '../../src/shared/helm-repository-protocol.ts';
const source: HelmRepositorySource = { paths: { repositoryFile: '/home/user/.config/helm/repositories.yaml', indexDirectory: '/home/user/.cache/helm/repository' }, origins: { repositoryFile: 'platform-default', indexDirectory: 'platform-default' } };
test('the request takes only canonical workspace roots and safe relative paths', () => {
  assert.equal(helmLintRequestSchema.safeParse({ protocol: 2, kind: 'read', root: '/workspace/charts', path: 'mychart' }).success, true);
  assert.equal(helmLintRequestSchema.safeParse({ protocol: 2, kind: 'read', root: '/workspace/charts', path: '' }).success, true);
  for (const bad of [{ root: 'relative' }, { root: '/trailing/' }, { root: '/a/../b' }, { root: '/a/./b' }, { root: '/back\\slash' }, { root: `/x/${'deep/'.repeat(60)}y` }, { root: '/ok', path: '../escape' }, { root: '/ok', path: 'a/./b' }, { root: '/ok', extra: 1 }]) assert.equal(helmLintRequestSchema.safeParse({ protocol: 2, kind: 'read', ...bad }).success === false, true, JSON.stringify(bad));
  // Shell metacharacters inside a relative path are LEGITIMATE here: the value travels as one spawn
  // array element with shell:false (never upstream's `lint "${path}"` string interpolation), so they
  // are inert; only structural traversal/escape/encoding violations are rejected.
});
test('the response keeps findings as a determinate boolean result with bounded stdout only', () => {
  assert.equal(helmLintResponseSchema.safeParse({ protocol: 2, kind: 'helm-linted', root: '/w', path: 'c', failed: false, content: '1 chart(s) linted, no failures\n' }).success, true);
  assert.equal(helmLintResponseSchema.safeParse({ protocol: 2, kind: 'helm-linted', root: '/w', path: 'c', failed: true, content: '[ERROR] values.yaml: …' }).success, true);
  assert.equal(helmLintResponseSchema.safeParse({ protocol: 2, kind: 'helm-linted', root: '/w', path: 'c', failed: false, content: 'x'.repeat(16_385) }).success, false);
  assert.equal(helmLintResponseSchema.safeParse({ protocol: 2, kind: 'helm-linted', root: '/w', path: 'c', failed: false, stderr: 'leak' }).success, false);
  assert.equal(helmLintResponseSchema.safeParse({ protocol: 2, kind: 'helm-lint-unavailable', code: 'CLI_NOT_FOUND' }).success, true);
  assert.equal(helmLintResponseSchema.safeParse({ protocol: 2, kind: 'helm-lint-unavailable', code: 'NOPE' }).success, false);
});
test('the chart directory is a canonical join of validated components, nothing else', () => {
  assert.equal(workspaceChartDirectory('/workspace/charts', 'mychart'), '/workspace/charts/mychart');
  assert.equal(workspaceChartDirectory('/workspace/charts', ''), '/workspace/charts');
  const { args } = helmLintArguments('/workspace/charts', 'mychart', source, '/service/home');
  assert.deepEqual(args, [`--repository-config=${source.paths.repositoryFile}`, '--repository-cache=/service/home/.openchamber-kubernetes/helm-cache/repository', 'lint', '/workspace/charts/mychart']);
  assert.equal(pluginCacheDirectory('/service/home'), '/service/home/.openchamber-kubernetes/helm-cache');
  for (const bad of ['', 'relative', '//double', 'C:\\users', '/x'.repeat(3000)]) assert.throws(() => pluginCacheDirectory(bad), /INVALID_INPUT/);
});
test('failure projection keeps fixed codes and lint findings are never a failure code', () => {
  assert.equal(lintFailureCode(new BoundaryError('CLI_NOT_FOUND')), 'CLI_NOT_FOUND');
  assert.equal(lintFailureCode(new BoundaryError('CLI_INCOMPATIBLE')), 'CLI_INCOMPATIBLE');
  assert.equal(lintFailureCode(new BoundaryError('QUERY_CANCELLED')), 'QUERY_CANCELLED');
  assert.equal(lintFailureCode(new BoundaryError('BUDGET_EXCEEDED')), 'BUDGET_EXCEEDED');
  assert.equal(lintFailureCode(new Error('boom')), 'STATE_UNAVAILABLE');
  assert.equal(lintFailureCode(new BoundaryError('HELM_INDEX_MISSING')), 'STATE_UNAVAILABLE'); // not a lint outcome
});
test('the empty relative path and deep-but-valid trees stay accepted within schema bounds', () => {
  assert.equal(helmLintRequestSchema.safeParse({ protocol: 2, kind: 'read', root: '/w', path: 'a/b/c/d/e/f/g' }).success, true);
  assert.equal(helmLintRequestSchema.safeParse({ protocol: 2, kind: 'read', root: '/w', path: `${'x/'.repeat(31)}y` }).success, true);
  assert.equal(helmLintRequestSchema.safeParse({ protocol: 2, kind: 'read', root: '/w', path: `${'x/'.repeat(32)}y` }).success, false);
});
