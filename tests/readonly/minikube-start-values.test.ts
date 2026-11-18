// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { minikubeStartRequestSchema, minikubeStartResponseSchema, startFlags, minikubeStartArguments, alreadyStartedMessage, startedMessage, startFailedMessage, startThrewMessage, STARTING_STATUS_TEXT, RUNNING_STATUS_TEXT } from '../../src/shared/minikube-start-protocol.ts';
test('the request takes an optional bounded profile/driver/flags and the response is a strict triple', () => {
  assert.equal(minikubeStartRequestSchema.safeParse({ protocol: 2, kind: 'run' }).success, true);
  assert.equal(minikubeStartRequestSchema.safeParse({ protocol: 2, kind: 'run', profile: 'minikube', vmDriver: 'docker', additionalFlags: '--memory=4096' }).success, true);
  for (const bad of [{ profile: '' }, { profile: 'x y' }, { vmDriver: '-lead' }, { vmDriver: 'a'.repeat(65) }, { additionalFlags: '' }, { additionalFlags: 'a\nb' }, { additionalFlags: 'x'.repeat(257) }, { kind: 'read' }, { extra: 1 }]) assert.equal(minikubeStartRequestSchema.safeParse({ protocol: 2, kind: 'run', ...bad }).success === false, true, JSON.stringify(bad));
  assert.equal(minikubeStartResponseSchema.safeParse({ protocol: 2, kind: 'minikube-started' }).success, true);
  assert.equal(minikubeStartResponseSchema.safeParse({ protocol: 2, kind: 'minikube-start-already-running' }).success, true);
  assert.equal(minikubeStartResponseSchema.safeParse({ protocol: 2, kind: 'minikube-start-unavailable', code: 'CLI_NOT_FOUND' }).success, true);
  assert.equal(minikubeStartResponseSchema.safeParse({ protocol: 2, kind: 'minikube-start-unavailable', code: 'NOPE' }).success, false);
});
test('the flag assembly and invocation are upstream verbatim', () => {
  assert.equal(startFlags(undefined, undefined), '');
  assert.equal(startFlags('--memory=4096', undefined), '--memory=4096');
  assert.equal(startFlags(undefined, 'docker'), ' --vm-driver=docker ');
  assert.equal(startFlags('--cpus=2', 'hyperkit'), '--cpus=2 --vm-driver=hyperkit ');
  assert.deepEqual(minikubeStartArguments(''), ['start']);
  assert.deepEqual(minikubeStartArguments('--memory=4096'), ['--memory=4096', 'start']);
  assert.deepEqual(minikubeStartArguments(' --vm-driver=docker '), ['--vm-driver=docker', 'start']);
});
test('all five messages and both status texts are upstream verbatim', () => {
  assert.equal(alreadyStartedMessage(), 'Minikube cluster is already started.');
  assert.equal(startedMessage(), 'Cluster started.');
  assert.equal(startFailedMessage('boom'), 'Failed to start cluster boom');
  assert.equal(startFailedMessage(undefined), 'Failed to start cluster Unable to run Minikube');
  assert.equal(startThrewMessage('ENOENT'), 'Failed to start cluster: ENOENT');
  assert.equal(STARTING_STATUS_TEXT, 'minikube-starting');
  assert.equal(RUNNING_STATUS_TEXT, 'minikube-running');
});
