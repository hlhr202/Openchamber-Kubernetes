// Pure protocol/projection values only. Never import/call the template runner/client/operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmTemplateRequestSchema, helmTemplateResponseSchema, workspaceChartDirectory, pluginCacheDirectory, helmTemplateArguments, templateFailureCode } from '../../src/shared/helm-template-protocol.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
import type { HelmRepositorySource } from '../../src/shared/helm-repository-protocol.ts';
const source: HelmRepositorySource = { paths: { repositoryFile: '/home/user/.config/helm/repositories.yaml', indexDirectory: '/home/user/.cache/helm/repository' }, origins: { repositoryFile: 'platform-default', indexDirectory: 'platform-default' } };
test('the request takes only canonical workspace roots and safe relative paths', () => {
  assert.equal(helmTemplateRequestSchema.safeParse({ protocol: 2, kind: 'read', root: '/workspace/charts', path: 'mychart' }).success, true);
  assert.equal(helmTemplateRequestSchema.safeParse({ protocol: 2, kind: 'read', root: '/workspace/charts', path: '' }).success, true);
  for (const bad of [{ root: 'relative' }, { root: '/trailing/' }, { root: '/a/../b' }, { root: '/a/./b' }, { root: '/back\\slash' }, { root: `/x/${'deep/'.repeat(60)}y` }, { root: '/ok', path: '../escape' }, { root: '/ok', path: 'a/./b' }, { root: '/ok', extra: 1 }]) assert.equal(helmTemplateRequestSchema.safeParse({ protocol: 2, kind: 'read', ...bad }).success === false, true, JSON.stringify(bad));
  // Shell metacharacters stay legitimate: the path travels as one spawn array element with
  // shell:false (never upstream's `template "${path}"` string interpolation).
});
test('the response carries only bounded rendered manifests — success has no failure fields', () => {
  assert.equal(helmTemplateResponseSchema.safeParse({ protocol: 2, kind: 'helm-templated', root: '/w', path: 'c', content: '---\n# Source: c/templates/svc.yaml\n' }).success, true);
  assert.equal(helmTemplateResponseSchema.safeParse({ protocol: 2, kind: 'helm-templated', root: '/w', path: 'c', content: 'x'.repeat(16_385) }).success, false);
  assert.equal(helmTemplateResponseSchema.safeParse({ protocol: 2, kind: 'helm-templated', root: '/w', path: 'c', content: 'ok', stderr: 'leak' }).success, false);
  assert.equal(helmTemplateResponseSchema.safeParse({ protocol: 2, kind: 'helm-template-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(helmTemplateResponseSchema.safeParse({ protocol: 2, kind: 'helm-template-unavailable', code: 'NOPE' }).success, false);
});
test('the chart directory is a canonical join and the args keep isolation flags', () => {
  assert.equal(workspaceChartDirectory('/workspace/charts', 'mychart'), '/workspace/charts/mychart');
  assert.equal(workspaceChartDirectory('/workspace/charts', ''), '/workspace/charts');
  const { args } = helmTemplateArguments('/workspace/charts', 'mychart', source, '/service/home');
  assert.deepEqual(args, [`--repository-config=${source.paths.repositoryFile}`, '--repository-cache=/service/home/.openchamber-kubernetes/helm-cache/repository', 'template', '/workspace/charts/mychart']);
  assert.equal(pluginCacheDirectory('/service/home'), '/service/home/.openchamber-kubernetes/helm-cache');
  for (const bad of ['', 'relative', '//double', 'C:\\users', '/x'.repeat(3000)]) assert.throws(() => pluginCacheDirectory(bad), /INVALID_INPUT/);
});
test('failure projection keeps fixed codes; render failure never masquerades as success or findings', () => {
  assert.equal(templateFailureCode(new BoundaryError('CLI_NOT_FOUND')), 'CLI_NOT_FOUND');
  assert.equal(templateFailureCode(new BoundaryError('CLI_INCOMPATIBLE')), 'CLI_INCOMPATIBLE');
  assert.equal(templateFailureCode(new BoundaryError('QUERY_CANCELLED')), 'QUERY_CANCELLED');
  assert.equal(templateFailureCode(new BoundaryError('BUDGET_EXCEEDED')), 'BUDGET_EXCEEDED');
  assert.equal(templateFailureCode(new BoundaryError('STATE_UNAVAILABLE')), 'STATE_UNAVAILABLE');
  assert.equal(templateFailureCode(new Error('boom')), 'STATE_UNAVAILABLE');
});
test('deep-but-valid trees stay accepted within schema bounds', () => {
  assert.equal(helmTemplateRequestSchema.safeParse({ protocol: 2, kind: 'read', root: '/w', path: 'a/b/c/d/e/f/g' }).success, true);
  assert.equal(helmTemplateRequestSchema.safeParse({ protocol: 2, kind: 'read', root: '/w', path: `${'x/'.repeat(31)}y` }).success, true);
  assert.equal(helmTemplateRequestSchema.safeParse({ protocol: 2, kind: 'read', root: '/w', path: `${'x/'.repeat(32)}y` }).success, false);
});
