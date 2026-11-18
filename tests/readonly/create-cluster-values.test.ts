// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createClusterRequestSchema, createClusterResponseSchema, selectClusterTypePlaceholder, failedClusterTypeMessage, failedProviderSelectionMessage, failedSignInMessage, aksExtensionId, delegatedCreateClusterCommandId, extensionRequiredMessage, INSTALL_BUTTON, CANCEL_BUTTON, shouldInstallDependency } from '../../src/shared/create-cluster-protocol.ts';
test('the request is a bare create and the response is a strict sextet', () => {
  assert.equal(createClusterRequestSchema.safeParse({ protocol: 2, kind: 'create' }).success, true);
  for (const bad of [{ kind: 'aks' }, { kind: 'create', subscriptionId: 'sub' }, { kind: 'create', provider: 'minikube' }, { extra: 1 }]) assert.equal(createClusterRequestSchema.safeParse({ protocol: 2, kind: 'create', ...bad }).success === false, true, JSON.stringify(bad));
  assert.equal(createClusterResponseSchema.safeParse({ protocol: 2, kind: 'provider-required' }).success, true);
  assert.equal(createClusterResponseSchema.safeParse({ protocol: 2, kind: 'subscription-required' }).success, true);
  assert.equal(createClusterResponseSchema.safeParse({ protocol: 2, kind: 'delegation-prompted', extensionInstalled: false }).success, true);
  assert.equal(createClusterResponseSchema.safeParse({ protocol: 2, kind: 'delegated' }).success, true);
  assert.equal(createClusterResponseSchema.safeParse({ protocol: 2, kind: 'create-cancelled' }).success, true);
  assert.equal(createClusterResponseSchema.safeParse({ protocol: 2, kind: 'create-unavailable', code: 'AUTHENTICATION_UNAVAILABLE' }).success, true);
  for (const bad of [{ kind: 'delegation-prompted' }, { kind: 'delegation-prompted', extensionInstalled: 'yes' }, { kind: 'delegated', inputs: {} }, { kind: 'create-unavailable', code: 'NOPE' }, { kind: 'wizard-shown' }, { kind: 'cluster-created' }]) assert.equal(createClusterResponseSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
});
test('the selection, sign-in and dependency texts are upstream verbatim', () => {
  assert.equal(selectClusterTypePlaceholder(), 'Select the cluster type');
  assert.equal(failedClusterTypeMessage(), 'Failed to get cluster type');
  assert.equal(failedProviderSelectionMessage(), 'Failed to get provider');
  assert.equal(failedSignInMessage('Azure Kubernetes Service'), 'Failed to sign in to Azure Kubernetes Service');
  assert.equal(aksExtensionId(), 'ms-kubernetes-tools.vscode-aks-tools');
  assert.equal(delegatedCreateClusterCommandId(), 'aks.createCluster');
  assert.equal(extensionRequiredMessage(), 'The Azure Kubernetes Service extension is required to create a cluster. Do you want to install it?');
  assert.equal(INSTALL_BUTTON, 'Install');
  assert.equal(CANCEL_BUTTON, 'Cancel');
});
test('only the exact Install choice installs; anything else cancels without creation', () => {
  assert.equal(shouldInstallDependency('Install'), true);
  assert.equal(shouldInstallDependency('Cancel'), false);
  assert.equal(shouldInstallDependency(undefined), false);
  assert.equal(shouldInstallDependency('install'), false);
});
