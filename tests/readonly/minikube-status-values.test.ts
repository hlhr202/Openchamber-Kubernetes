// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { minikubeStatusRequestSchema, minikubeStatusResponseSchema, minikubeStatusArguments, minikubeNotFoundMessage, hostStatusMissingMessage, statusFailedMessage, projectHostLine } from '../../src/shared/minikube-status-protocol.ts';
test('the request takes an optional bounded profile and the pair is strict', () => {
  assert.equal(minikubeStatusRequestSchema.safeParse({ protocol: 2, kind: 'read' }).success, true);
  assert.equal(minikubeStatusRequestSchema.safeParse({ protocol: 2, kind: 'read', profile: 'minikube' }).success, true);
  for (const bad of [{ profile: '' }, { profile: 'x y' }, { profile: 'a'.repeat(1025) }, { kind: 'run' }, { extra: 1 }]) assert.equal(minikubeStatusRequestSchema.safeParse({ protocol: 2, kind: 'read', ...bad }).success === false, true, JSON.stringify(bad));
  assert.equal(minikubeStatusResponseSchema.safeParse({ protocol: 2, kind: 'minikube-status', running: true, message: 'host: Running\n' }).success, true);
  assert.equal(minikubeStatusResponseSchema.safeParse({ protocol: 2, kind: 'minikube-status', running: true, message: 'x'.repeat(16_385) }).success, false);
  assert.equal(minikubeStatusResponseSchema.safeParse({ protocol: 2, kind: 'minikube-status', running: true, message: 'm', stderr: 'leak' }).success, false);
  assert.equal(minikubeStatusResponseSchema.safeParse({ protocol: 2, kind: 'minikube-status-unavailable', code: 'CLI_NOT_FOUND' }).success, true);
  assert.equal(minikubeStatusResponseSchema.safeParse({ protocol: 2, kind: 'minikube-status-unavailable', code: 'NOPE' }).success, false);
});
test('the invocation and the three error messages are upstream verbatim', () => {
  assert.deepEqual(minikubeStatusArguments(), ['status']);
  assert.equal(minikubeNotFoundMessage(), 'Minikube executable could not be found!');
  assert.equal(hostStatusMissingMessage(), 'Failed to get host status: Unable to run Minikube');
  assert.equal(statusFailedMessage('boom'), 'Failed to get status: boom');
  assert.equal(statusFailedMessage(undefined), 'Failed to get status: Unable to run Minikube');
});
test('the host-line projection keeps the upstream semantics with an explicit malformed rejection', () => {
  assert.deepEqual(projectHostLine('minikube\ntype: Control Plane\nhost: Running\nkubelet: Running\n'), { running: true, message: 'minikube\ntype: Control Plane\nhost: Running\nkubelet: Running\n' });
  assert.equal(projectHostLine('host: Stopped\n').running, false); // case-insensitive stopped
  assert.equal(projectHostLine('host: Running\n').running, true);
  assert.throws(() => projectHostLine('kubelet: Running\n'), /Failed to get host status/); // no host line
  assert.throws(() => projectHostLine('host\n'), /Failed to get host status/); // malformed: no ': ' separator
});
