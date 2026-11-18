// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { minikubeStopRequestSchema, minikubeStopResponseSchema, minikubeStopArguments, alreadyStoppedMessage, stoppedMessage, stopFailedMessage, stopThrewMessage, STOPPING_STATUS_TEXT } from '../../src/shared/minikube-stop-protocol.ts';
test('the request takes an optional bounded profile and the response is a strict triple', () => {
  assert.equal(minikubeStopRequestSchema.safeParse({ protocol: 2, kind: 'run' }).success, true);
  assert.equal(minikubeStopRequestSchema.safeParse({ protocol: 2, kind: 'run', profile: 'minikube' }).success, true);
  for (const bad of [{ profile: '' }, { profile: 'x y' }, { profile: 'a'.repeat(129) }, { kind: 'read' }, { extra: 1 }]) assert.equal(minikubeStopRequestSchema.safeParse({ protocol: 2, kind: 'run', ...bad }).success === false, true, JSON.stringify(bad));
  assert.equal(minikubeStopResponseSchema.safeParse({ protocol: 2, kind: 'minikube-stopped' }).success, true);
  assert.equal(minikubeStopResponseSchema.safeParse({ protocol: 2, kind: 'minikube-stop-already-stopped' }).success, true);
  assert.equal(minikubeStopResponseSchema.safeParse({ protocol: 2, kind: 'minikube-stop-unavailable', code: 'CLI_NOT_FOUND' }).success, true);
  assert.equal(minikubeStopResponseSchema.safeParse({ protocol: 2, kind: 'minikube-stop-unavailable', code: 'NOPE' }).success, false);
});
test('the invocation is upstream verbatim: stop only, never delete', () => {
  assert.deepEqual(minikubeStopArguments(), ['stop']);
});
test('all four messages and the status text are upstream verbatim', () => {
  assert.equal(alreadyStoppedMessage(), 'Minikube cluster is already stopped.');
  assert.equal(stoppedMessage(), 'Cluster stopped.');
  assert.equal(stopFailedMessage('boom'), 'Error stopping cluster boom');
  assert.equal(stopFailedMessage(undefined), 'Error stopping cluster Unable to run Minikube');
  assert.equal(stopThrewMessage('ENOENT'), 'Error stopping cluster: ENOENT');
  assert.equal(STOPPING_STATUS_TEXT, 'minikube-stopping');
});
