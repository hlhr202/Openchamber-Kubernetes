// Pure protocol/input values only. Never import/call any real or mock Scale client/controller/adapter/operation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { scaleParametersSchema, scaleRequestSchema, scaleResponseSchema, scaleOutcomeSchema, parseScaleReplicasInput } from '../../src/shared/scale-protocol.ts';
const target = { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'default' };
const grant = { id: '00000000-0000-4000-8000-000000000001', capability: 'a'.repeat(64), serviceGeneration: '00000000-0000-4000-8000-000000000002', expiresAt: 120_001 };
const reference = (resource: string, kind: string, group = 'apps', version = 'v1') => ({ type: { group, version, resource, kind, scope: 'namespace' as const }, name: 'web', namespace: 'default', uid: 'object-uid', resourceVersion: '5' });
const parameters = { reference: reference('deployments', 'Deployment'), replicas: 3 };
const outcome = { id: '00000000-0000-4000-8000-000000000003', owner: grant.id, step: 'scale-request' as const, dependencies: [] as const, target, parameters, createdAt: 1, updatedAt: 1, phase: 'prepared' as const };
test('scale parameters admit exactly the upstream five kinds with an explicit original namespace', () => {
  // Reachable today through the exact-reference plane (tree descriptors): Deployment/StatefulSet/Job.
  // ReplicaSet/ReplicationController stay in the five-kind rule but no reference can be produced for them
  // until the descriptor plane itself covers them; the scale protocol never widens that plane.
  assert.equal(scaleParametersSchema.safeParse(parameters).success, true);
  assert.equal(scaleParametersSchema.safeParse({ reference: reference('statefulsets', 'StatefulSet'), replicas: 0 }).success, true);
  assert.equal(scaleParametersSchema.safeParse({ reference: reference('jobs', 'Job', 'batch'), replicas: 1 }).success, true);
  assert.equal(scaleParametersSchema.safeParse({ reference: reference('replicasets', 'ReplicaSet'), replicas: 1 }).success, false); // not a tree descriptor yet
  for (const bad of [
    { reference: reference('pods', 'Pod', '', 'v1'), replicas: 1 }, // not in scaleableKinds
    { reference: reference('configmaps', 'ConfigMap', '', 'v1'), replicas: 1 },
    { reference: { ...reference('deployments', 'Deployment'), namespace: undefined }, replicas: 1 }, // never the current global namespace
    { reference: { ...reference('deployments', 'Deployment'), uid: '' }, replicas: 1 },
  ]) assert.equal(scaleParametersSchema.safeParse(bad).success, false, JSON.stringify(bad.reference.type));
});
test('replicas are non-negative safe int32 integers only, mirroring the upstream input-box rule', () => {
  for (const replicas of [0, 1, 42, 2147483647]) assert.equal(scaleParametersSchema.safeParse({ reference: parameters.reference, replicas }).success, true, String(replicas));
  for (const replicas of [-1, 1.5, 2147483648, Number.NaN, Number.MAX_SAFE_INTEGER]) assert.equal(scaleParametersSchema.safeParse({ reference: parameters.reference, replicas }).success, false, String(replicas));
});
test('pure input parse rejects empty/negative/fractional/suffix/unsafe strings before any request exists', () => {
  assert.deepEqual(['0', '3', '2147483647'].map(parseScaleReplicasInput), [0, 3, 2147483647]);
  for (const value of ['', '-1', '1.5', '+3', '1e3', '0x10', '3 replicas', ' ', '2147483648', '999999999999999999999']) assert.equal(parseScaleReplicasInput(value), undefined, value);
});
test('request union carries its own grant/confirmation and never a CLI argv, path or body', () => {
  const submit = { protocol: 2, kind: 'submit', grant, id: outcome.id, proof: 'b'.repeat(64), confirmation: 'scale-exact-target-replicas' };
  assert.equal(scaleRequestSchema.safeParse(submit).success, true);
  for (const extra of [{ argv: ['scale'] }, { path: '/apis/apps/v1' }, { body: '{}' }, { confirmation: 'apply-exact-crd-version' }, { confirmation: 'create-exact-documents' }]) assert.equal(scaleRequestSchema.safeParse({ ...submit, ...extra }).success, false);
  assert.equal(scaleRequestSchema.safeParse({ protocol: 2, kind: 'prepare', grant, parameters }).success, true);
});
test('outcome ledger is metadata-only and accepted results cannot claim an error code', () => {
  const response = (value: unknown) => scaleResponseSchema.safeParse({ protocol: 2, kind: 'outcome', outcome: value }).success;
  assert.equal(response(outcome), true);
  assert.equal(scaleOutcomeSchema.safeParse({ ...outcome, phase: 'accepted', code: 'FORBIDDEN' }).success, false);
  assert.equal(response({ ...outcome, phase: 'accepted' }), true);
  assert.equal(response({ ...outcome, phase: 'unknown', code: 'OPERATION_UNKNOWN' }), true);
  assert.equal(response({ ...outcome, parameters: { ...parameters, replicas: 1 } }), true); // ledger keeps the original intent
  for (const extra of [{ body: 'x' }, { argv: [] }, { resultText: 'scaled' }]) assert.equal(scaleOutcomeSchema.safeParse({ ...outcome, ...extra }).success, false);
});
