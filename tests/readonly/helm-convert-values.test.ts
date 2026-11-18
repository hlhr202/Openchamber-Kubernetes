// Pure protocol/transform values only. Never import/call the write adapter/client/operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmConvertRequestSchema, helmConvertResponseSchema, helmTemplateName, workspaceChartDirectory, templateFilePath, convertFailureCode } from '../../src/shared/helm-convert-protocol.ts';
import { convertToTemplateText, NAME_EXPRESSION, CHART_LABEL_EXPRESSION } from '../../src/parsing/helm-template-transform.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: prod
  uid: 1
  resourceVersion: '42'
  creationTimestamp: '2020-01-01T00:00:00Z'
  generation: 3
  labels:
    app: myapp
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: '{"big":"blob"}'
spec:
  replicas: 1
status:
  readyReplicas: 1
`;
test('the request takes canonical chart locations, a bounded template name and a bounded document', () => {
  assert.equal(helmConvertRequestSchema.safeParse({ protocol: 2, kind: 'run', root: '/w/charts', path: 'mychart', name: 'deployment-template', document: deployment }).success, true);
  const cases: unknown[] = [
    { protocol: 2, kind: 'run', root: 'relative', path: 'c', name: 'ok', document: deployment },
    { protocol: 2, kind: 'run', root: '/w', path: 'c', name: '-lead', document: deployment },
    { protocol: 2, kind: 'run', root: '/w', path: 'c', name: 'x y', document: deployment },
    { protocol: 2, kind: 'run', root: '/w', path: 'c', name: 'a'.repeat(129), document: deployment },
    { protocol: 2, kind: 'run', root: '/w', path: '../escape', name: 'ok', document: deployment },
    { protocol: 2, kind: 'run', root: '/w', path: 'c', name: 'ok', document: '' },
    { protocol: 2, kind: 'run', root: '/w', path: 'c', name: 'ok', document: 'x'.repeat(46_081) },
    { protocol: 2, kind: 'read', root: '/w', path: 'c', name: 'ok', document: deployment },
    { protocol: 2, kind: 'run', root: '/w', path: 'c', name: 'ok', document: deployment, extra: 1 },
  ];
  for (const bad of cases) assert.equal(helmConvertRequestSchema.safeParse(bad).success === false, true, JSON.stringify(bad));
  assert.equal(helmTemplateName.safeParse('deployment-template').success, true);
});
test('the transform strips cluster metadata, the last-applied annotation and status, then sets expressions', () => {
  const text = convertToTemplateText(deployment);
  for (const gone of ['namespace: prod', 'uid: 1', 'resourceVersion', 'creationTimestamp', 'generation: 3', 'last-applied-configuration', 'status:', 'readyReplicas']) assert.ok(!text.includes(gone), gone);
  assert.ok(text.includes(`name: ${NAME_EXPRESSION}`));
  assert.ok(text.includes(`chart: "${CHART_LABEL_EXPRESSION}"`));
  assert.ok(text.includes('kind: Deployment') && text.includes('replicas: 1') && text.includes('app: myapp'));
});
test('the name expression stays unquoted and the chart label double-quoted (upstream quoting fix)', () => {
  const text = convertToTemplateText(deployment);
  assert.ok(!text.includes(`'${NAME_EXPRESSION}'`));
  assert.ok(!text.includes(`'${CHART_LABEL_EXPRESSION}'`));
  assert.ok(text.includes(`"${CHART_LABEL_EXPRESSION}"`));
});
test('missing metadata is ensured; invalid, multi-document and oversized inputs map to fixed codes', () => {
  const bare = convertToTemplateText('kind: ConfigMap\ndata:\n  k: v\n');
  assert.ok(bare.includes(`name: ${NAME_EXPRESSION}`) && bare.includes(`chart: "${CHART_LABEL_EXPRESSION}"`));
  assert.throws(() => convertToTemplateText('not: [valid'), /CONTENT_INVALID/);
  assert.throws(() => convertToTemplateText('- a\n- b\n'), /CONTENT_INVALID/);
  assert.throws(() => convertToTemplateText('a: 1\n---\nb: 2\n'), /CONTENT_INVALID|INVALID_INPUT/);
  assert.throws(() => convertToTemplateText(`k: '${'x'.repeat(46_100)}'\n`), /INVALID_INPUT|BUDGET_EXCEEDED/);
  assert.throws(() => convertToTemplateText('null\n'), /CONTENT_INVALID/);
  assert.throws(() => convertToTemplateText('k: v\u0000\n'), /INVALID_INPUT/); // control characters other than newline/tab are rejected
});
test('the template path is a canonical join and failure projection keeps fixed codes', () => {
  assert.equal(workspaceChartDirectory('/w/charts', 'mychart'), '/w/charts/mychart');
  assert.equal(templateFilePath('/w/charts', 'mychart', 'dep-tpl'), '/w/charts/mychart/templates/dep-tpl.yaml');
  assert.equal(helmConvertResponseSchema.safeParse({ protocol: 2, kind: 'helm-template-written', root: '/w', path: 'c', name: 't' }).success, true);
  assert.equal(helmConvertResponseSchema.safeParse({ protocol: 2, kind: 'helm-convert-unavailable', code: 'DOCUMENT_DIRTY' }).success, true);
  assert.equal(helmConvertResponseSchema.safeParse({ protocol: 2, kind: 'helm-convert-unavailable', code: 'NOPE' }).success, false);
  assert.equal(convertFailureCode(new BoundaryError('DOCUMENT_DIRTY')), 'DOCUMENT_DIRTY');
  assert.equal(convertFailureCode(new BoundaryError('CONTENT_INVALID')), 'CONTENT_INVALID');
  assert.equal(convertFailureCode(new Error('boom')), 'STATE_UNAVAILABLE');
});
