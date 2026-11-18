// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPodRequestSchema, selectPodResponseSchema, unableToListPodsMessage, quickPickPlaceholder, podPickLabel, podPickItems } from '../../src/shared/select-pod-protocol.ts';
test('the request is a bare select and the response is a strict quadruple with bounded picks', () => {
  assert.equal(selectPodRequestSchema.safeParse({ protocol: 2, kind: 'select' }).success, true);
  for (const bad of [{ kind: 'list' }, { namespace: 'ns' }, { extra: 1 }]) assert.equal(selectPodRequestSchema.safeParse({ protocol: 2, kind: 'select', ...bad }).success === false, true, JSON.stringify(bad));
  assert.equal(selectPodResponseSchema.safeParse({ protocol: 2, kind: 'pods-listed', pods: [] }).success, true);
  assert.equal(selectPodResponseSchema.safeParse({ protocol: 2, kind: 'pods-listed', pods: [{ name: 'web-1', nodeName: 'node-a' }, { name: 'web-2' }] }).success, true);
  for (const bad of [
    { kind: 'pods-listed', pods: [{ name: '' }] }, { kind: 'pods-listed', pods: [{ name: 'a b' }] }, { kind: 'pods-listed', pods: [{ name: '-lead' }] },
    { kind: 'pods-listed', pods: [{ name: 'a'.repeat(254) }] }, { kind: 'pods-listed', pods: [{ nodeName: 'node-a' }] }, { kind: 'pods-listed', pods: [{ name: 'a', spec: {} }] },
    { kind: 'pods-listed', pods: [{ name: 'a', nodeName: 'n o' }] }, { kind: 'pods-listed', pods: Array.from({ length: 501 }, () => ({ name: 'a' })) },
    { kind: 'pod-selected', name: '' }, { kind: 'pod-selected', name: 'a b' }, { kind: 'pod-selected' }, { kind: 'pod-selected', name: 'web-1', extra: 1 },
    { kind: 'pods-unavailable', code: 'NOPE' }, { kind: 'pods-unavailable' }, { kind: 'pods-listed', pods: [], extra: 1 },
  ]) assert.equal(selectPodResponseSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
  assert.equal(selectPodResponseSchema.safeParse({ protocol: 2, kind: 'pod-selected', name: 'web-1' }).success, true);
  assert.equal(selectPodResponseSchema.safeParse({ protocol: 2, kind: 'selection-cancelled' }).success, true);
  assert.equal(selectPodResponseSchema.safeParse({ protocol: 2, kind: 'pods-unavailable', code: 'READ_TRANSPORT_UNAVAILABLE' }).success, true);
});
test('the label template, placeholder, message and item mapping are upstream verbatim', () => {
  assert.equal(podPickLabel('web-1', 'node-a'), 'web-1 (on node-a)');
  assert.equal(podPickLabel('web-1', undefined), 'web-1 (on undefined)');
  assert.equal(quickPickPlaceholder(), 'Select a pod');
  assert.equal(unableToListPodsMessage(), 'Unable to list any pods. No pod found in the current namespace.');
  assert.deepEqual(podPickItems([{ name: 'web-1', nodeName: 'node-a' }, { name: 'web-2' }]), [{ label: 'web-1 (on node-a)', name: 'web-1' }, { label: 'web-2 (on undefined)', name: 'web-2' }]);
  assert.deepEqual(podPickItems([]), []);
});
test('privacy: the boundary payload is strict pick metadata only, never pod specs or credentials', () => {
  assert.equal(selectPodResponseSchema.safeParse({ protocol: 2, kind: 'pods-listed', pods: [{ name: 'web-1', nodeName: 'node-a', spec: { containers: [] } }] }).success, false);
  assert.equal(selectPodResponseSchema.safeParse({ protocol: 2, kind: 'pods-listed', pods: [{ name: 'web-1', nodeName: 'node-a', volumes: [] }] }).success, false);
  assert.equal(selectPodResponseSchema.safeParse({ protocol: 2, kind: 'pod-selected', name: 'web-1', namespace: 'extra' }).success, false);
  assert.equal(selectPodResponseSchema.safeParse({ protocol: 2, kind: 'selection-cancelled', history: [] }).success, false);
});
