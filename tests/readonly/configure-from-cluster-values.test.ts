// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { configureFromClusterRequestSchema, configureFromClusterResponseSchema, providerName, gettingSubscriptionsProgress, failedSubscriptionsMessage, selectSubscriptionPlaceholder, failedSubscriptionMessage, failedKubeconfigMessage, mustBeSignedInMessage, networkErrorMessage, resourceGraphFailedMessage, failedCredentialsMessage, failedRetrieveKubeconfigMessage, errorFetchingKubeconfigMessage, subscriptionIdByName } from '../../src/shared/configure-from-cluster-protocol.ts';
test('the request is a bare configure and the response is a strict sextet', () => {
  assert.equal(configureFromClusterRequestSchema.safeParse({ protocol: 2, kind: 'configure' }).success, true);
  for (const bad of [{ kind: 'merge' }, { kind: 'configure', subscriptionId: 'sub' }, { kind: 'configure', cluster: 'c' }, { extra: 1 }]) assert.equal(configureFromClusterRequestSchema.safeParse({ protocol: 2, kind: 'configure', ...bad }).success === false, true, JSON.stringify(bad));
  for (const kind of ['provider-required', 'subscription-required', 'cluster-required', 'kubeconfig-required', 'merge-initiated']) assert.equal(configureFromClusterResponseSchema.safeParse({ protocol: 2, kind }).success, true, kind);
  assert.equal(configureFromClusterResponseSchema.safeParse({ protocol: 2, kind: 'configure-unavailable', code: 'AUTHENTICATION_UNAVAILABLE' }).success, true);
  for (const bad of [{ kind: 'configure-unavailable', code: 'NOPE' }, { kind: 'configure-unavailable' }, { kind: 'merge-initiated', kubeconfig: 'apiVersion: v1' }, { kind: 'first-item-bound' }]) assert.equal(configureFromClusterResponseSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
});
test('the provider, subscription and cloud-leg texts are upstream verbatim', () => {
  assert.equal(providerName(), 'Azure Kubernetes Service (AKS)');
  assert.equal(gettingSubscriptionsProgress(), 'Getting Azure subscriptions');
  assert.equal(failedSubscriptionsMessage('Azure Kubernetes Service (AKS)'), 'Failed to get subscriptions for Azure Kubernetes Service (AKS)');
  assert.equal(selectSubscriptionPlaceholder(), 'Select the subscription');
  assert.equal(failedSubscriptionMessage('Azure Kubernetes Service (AKS)'), 'Failed to get subscription for Azure Kubernetes Service (AKS)');
  assert.equal(failedKubeconfigMessage(), 'Failed to get kubeconfig');
  assert.equal(mustBeSignedInMessage(), 'You must be signed into Azure to list clusters.');
  assert.equal(networkErrorMessage('ETIMEDOUT'), 'Network error querying Resource Graph: ETIMEDOUT');
  assert.equal(resourceGraphFailedMessage(403, 'Forbidden'), 'Resource Graph failed: 403 Forbidden');
  assert.equal(failedCredentialsMessage(), 'Failed to get credentials for AKS.');
  assert.equal(failedRetrieveKubeconfigMessage(), 'Failed to retrieve kubeconfig from AKS.');
  assert.equal(errorFetchingKubeconfigMessage('boom'), 'Error fetching kubeconfig: boom');
});
test('identity binds by exact name match, never a same-name list first item', () => {
  const subscriptions = [{ name: 'sub-a', subscriptionId: 'id-1' }, { name: 'sub-b', subscriptionId: 'id-2' }];
  assert.equal(subscriptionIdByName(subscriptions, 'sub-b'), 'id-2');
  assert.equal(subscriptionIdByName(subscriptions, 'sub-c'), undefined);
  assert.equal(subscriptionIdByName([], 'sub-a'), undefined);
});
