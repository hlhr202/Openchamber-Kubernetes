// Pure protocol/transform values only. No adapters, no writes, no client imports.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmParameteriseRequestSchema, helmParameteriseResponseSchema, keyReference, parameterReference, entryText } from '../../src/shared/helm-parameterise-protocol.ts';
import { parameteriseDocument } from '../../src/parsing/helm-parameterise-transform.ts';
const templateText = 'apiVersion: apps/v1\nkind: Deployment\nspec:\n  replicas: 3\n  template:\n    metadata:\n      labels:\n        app: web\n';
test('the request takes bounded tokens, a single-line literal value and a bounded document', () => {
  assert.equal(helmParameteriseRequestSchema.safeParse({ protocol: 2, kind: 'read', template: 'mychart', field: 'replicas', value: '3', document: templateText }).success, true);
  const cases: unknown[] = [
    { protocol: 2, kind: 'read', template: '', field: 'replicas', value: '3', document: templateText },
    { protocol: 2, kind: 'read', template: 'mychart', field: 'x y', value: '3', document: templateText },
    { protocol: 2, kind: 'read', template: 'mychart', field: 'replicas', value: 'a\nb', document: templateText },
    { protocol: 2, kind: 'read', template: 'mychart', field: 'replicas', value: 'x'.repeat(1025), document: templateText },
    { protocol: 2, kind: 'read', template: 'mychart', field: 'replicas', value: '3', document: '' },
    { protocol: 2, kind: 'read', template: 'mychart', field: 'replicas', value: '3', document: 'x'.repeat(46_081) },
    { protocol: 2, kind: 'run', template: 'mychart', field: 'replicas', value: '3', document: templateText },
    { protocol: 2, kind: 'read', template: 'mychart', field: 'replicas', value: '3', document: templateText, extra: 1 },
  ];
  for (const bad of cases) assert.equal(helmParameteriseRequestSchema.safeParse(bad).success === false, true, JSON.stringify(bad));
});
test('the transform swaps the unique assignment for the .Values reference and emits the entry', () => {
  const result = parameteriseDocument(templateText, 'mychart', 'replicas', '3');
  assert.ok(result.document.includes(`  replicas: ${parameterReference('mychart', 'replicas')}`));
  assert.ok(!result.document.includes('replicas: 3\n'));
  assert.ok(result.document.includes('labels:\n        app: web')); // untouched context
  assert.equal(result.entry, 'mychart:\n  replicas: 3\n');
  assert.equal(entryText('t', 'f', 'v'), 't:\n  f: v\n');
  assert.equal(keyReference('t', 'f'), 't.f');
  assert.equal(parameterReference('t', 'f'), '{{ .Values.t.f }}');
});
test('nested fields locate by name and value; comments and partial matches do not count', () => {
  const nested = 'metadata:\n  name: busy\nspec:\n  name: busy2\n';
  const result = parameteriseDocument(nested, 't', 'name', 'busy2');
  assert.ok(result.document.includes(`  name: ${parameterReference('t', 'name')}`));
  assert.ok(result.document.includes('  name: busy\n'));
  const commented = 'spec:\n  replicas: 3 # comment\n';
  assert.throws(() => parameteriseDocument(commented, 't', 'replicas', '3'), /NOT_FOUND/);
});
test('missing and ambiguous assignments map to explicit failures, never guesses', () => {
  assert.throws(() => parameteriseDocument(templateText, 't', 'replicas', '9'), /NOT_FOUND/);
  assert.throws(() => parameteriseDocument(templateText, 't', 'kind', 'StatefulSet'), /NOT_FOUND/);
  const realAmbiguous = 'x: 1\ny:\n  x: 1\n';
  assert.throws(() => parameteriseDocument(realAmbiguous, 't', 'x', '1'), /STATE_UNAVAILABLE/);
});
test('bounds and control characters map to fixed codes; the response pair stays bounded', () => {
  assert.throws(() => parameteriseDocument(`k: v\u0000\n`, 't', 'k', 'v'), /INVALID_INPUT/);
  assert.throws(() => parameteriseDocument(`${'a: 1\n'.repeat(4100)}`, 't', 'a', '1'), /BUDGET_EXCEEDED|STATE_UNAVAILABLE/);
  assert.equal(helmParameteriseResponseSchema.safeParse({ protocol: 2, kind: 'helm-parameterised', template: 't', field: 'f', keyReference: 't.f', document: 'd', entry: 'e' }).success, true);
  assert.equal(helmParameteriseResponseSchema.safeParse({ protocol: 2, kind: 'helm-parameterised', template: 't', field: 'f', keyReference: 't.f', document: 'x'.repeat(46_081), entry: 'e' }).success, false);
  assert.equal(helmParameteriseResponseSchema.safeParse({ protocol: 2, kind: 'helm-parameterised-unavailable', code: 'NOT_FOUND' }).success, true);
  assert.equal(helmParameteriseResponseSchema.safeParse({ protocol: 2, kind: 'helm-parameterised-unavailable', code: 'NOPE' }).success, false);
});
