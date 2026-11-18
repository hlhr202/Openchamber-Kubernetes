// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { removeDebugRequestSchema, removeDebugResponseSchema, debugResourceName, nothingToCleanUpMessage, toDeleteDescription, deleteConfirmationMessage, confirmationErrorMessage, resourceContinueMessage, startingCleanupMessage, resourceRemovedMessage, DELETE_BUTTON, CLEAN_UP_BUTTON, ALWAYS_CLEAN_UP_BUTTON, deleteServiceArguments, deleteDeploymentArguments, cleanupResourceArguments } from '../../src/shared/remove-debug-protocol.ts';
test('the request is bounded and the response is a strict sextet', () => {
  assert.equal(removeDebugRequestSchema.safeParse({ protocol: 2, kind: 'remove', name: 'my-app' }).success, true);
  assert.equal(removeDebugRequestSchema.safeParse({ protocol: 2, kind: 'cleanup-session', resourceId: 'deployment/my-app-debug' }).success, true);
  for (const bad of [{ kind: 'remove', name: '' }, { kind: 'remove', name: 'a b' }, { kind: 'remove', name: '-lead' }, { kind: 'remove', name: 'a'.repeat(254) }, { kind: 'remove' }, { kind: 'remove', name: 'a', extra: 1 }, { kind: 'cleanup-session', resourceId: '' }, { kind: 'cleanup-session', resourceId: 'a'.repeat(513) }, { kind: 'cleanup-session' }, { kind: 'sweep' }]) assert.equal(removeDebugRequestSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
  assert.equal(removeDebugResponseSchema.safeParse({ protocol: 2, kind: 'nothing-to-clean-up' }).success, true);
  assert.equal(removeDebugResponseSchema.safeParse({ protocol: 2, kind: 'confirmation-requested', hasDeployment: true, hasService: false }).success, true);
  assert.equal(removeDebugResponseSchema.safeParse({ protocol: 2, kind: 'confirmation-cancelled' }).success, true);
  assert.equal(removeDebugResponseSchema.safeParse({ protocol: 2, kind: 'cleanup-scheduled', service: true, deployment: true }).success, true);
  assert.equal(removeDebugResponseSchema.safeParse({ protocol: 2, kind: 'session-cleanup-completed' }).success, true);
  assert.equal(removeDebugResponseSchema.safeParse({ protocol: 2, kind: 'remove-unavailable', code: 'STALE_TARGET' }).success, true);
  for (const bad of [{ kind: 'cleanup-scheduled', service: true }, { kind: 'confirmation-requested', hasDeployment: true }, { kind: 'remove-unavailable', code: 'NOPE' }, { kind: 'nothing-to-clean-up', deploymentName: 'x' }, { kind: 'all-success' }]) assert.equal(removeDebugResponseSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
});
test('the name suffix, description truth table, messages, buttons and invocations are upstream verbatim', () => {
  assert.equal(debugResourceName('my-app'), 'my-app-debug');
  assert.equal(nothingToCleanUpMessage('my-app-debug'), 'my-app-debug: nothing to clean up');
  assert.equal(toDeleteDescription(true, true), 'deployment and service');
  assert.equal(toDeleteDescription(true, false), 'deployment');
  assert.equal(toDeleteDescription(false, true), 'service');
  assert.equal(deleteConfirmationMessage('deployment and service', 'my-app-debug'), 'This will delete deployment and service my-app-debug');
  assert.equal(confirmationErrorMessage('boom'), 'Error getting confirmation of delete: boom');
  assert.equal(resourceContinueMessage('deployment/my-app-debug'), 'Resource deployment/my-app-debug will continue running on the cluster.');
  assert.equal(startingCleanupMessage(), 'Starting to clean up debug resource...');
  assert.equal(resourceRemovedMessage('deployment/my-app-debug'), 'Resource deployment/my-app-debug is removed successfully.');
  assert.equal(DELETE_BUTTON, 'Delete');
  assert.equal(CLEAN_UP_BUTTON, 'Clean Up');
  assert.equal(ALWAYS_CLEAN_UP_BUTTON, 'Always Clean Up');
  assert.deepEqual(deleteServiceArguments('my-app-debug'), ['delete', 'service', 'my-app-debug']);
  assert.deepEqual(deleteDeploymentArguments('my-app-debug'), ['delete', 'deployment', 'my-app-debug']);
  assert.deepEqual(cleanupResourceArguments('deployment my-app-debug'), ['delete', 'deployment', 'my-app-debug']);
});
test('each delete stays independent with no combined sweep state', () => {
  for (const [service, deployment] of [[true, true], [true, false], [false, true]] as const) {
    const parsed = removeDebugResponseSchema.safeParse({ protocol: 2, kind: 'cleanup-scheduled', service, deployment });
    assert.equal(parsed.success && parsed.data.kind === 'cleanup-scheduled' && parsed.data.service === service && parsed.data.deployment === deployment, true);
  }
  assert.deepEqual(deleteServiceArguments('a'), ['delete', 'service', 'a']);
  assert.deepEqual(deleteDeploymentArguments('a'), ['delete', 'deployment', 'a']);
});
