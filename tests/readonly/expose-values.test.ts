// Pure protocol/input values only. Never import/call any real or mock Expose client/controller/adapter/operation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { exposeParametersSchema, exposeRequestSchema, exposeResponseSchema, exposeOutcomeSchema, parseExposePortInput } from '../../src/shared/expose-protocol.ts';
const target = { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'default' };
const grant = { id: '00000000-0000-4000-8000-000000000001', capability: 'a'.repeat(64), serviceGeneration: '00000000-0000-4000-8000-000000000002', expiresAt: 120_001 };
const deployment = { type: { group: 'apps', version: 'v1', resource: 'deployments', kind: 'Deployment', scope: 'namespace' as const }, name: 'web', namespace: 'default', uid: 'd-uid', resourceVersion: '3' };
const pod = { type: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' as const }, name: 'web-xyz', namespace: 'default', uid: 'p-uid', resourceVersion: '4' };
const service = { type: { group: '', version: 'v1', resource: 'services', kind: 'Service', scope: 'namespace' as const }, name: 'web', namespace: 'default', uid: 's-uid', resourceVersion: '5' };
const outcome = (parameters: unknown) => ({ id: '00000000-0000-4000-8000-000000000003', owner: grant.id, step: 'expose-request' as const, dependencies: [] as const, target, parameters, createdAt: 1, updatedAt: 1, phase: 'prepared' as const });
test('parameters admit exactly the reachable exposable kinds with explicit original namespace', () => {
  assert.equal(exposeParametersSchema.safeParse({ reference: deployment, name: 'web' }).success, true);
  assert.equal(exposeParametersSchema.safeParse({ reference: pod, name: 'web', port: 80, targetPort: 8080, type: 'NodePort', protocol: 'UDP' }).success, true);
  assert.equal(exposeParametersSchema.safeParse({ reference: service, name: 'web-copy' }).success, true);
  for (const bad of [
    { reference: { ...deployment, type: { ...deployment.type, resource: 'statefulsets', kind: 'StatefulSet' } }, name: 'x' }, // not in upstream exposableKinds
    { reference: { ...pod, namespace: undefined }, name: 'x' }, // never the current global namespace
    { reference: deployment, name: 'Bad_Name' }, { reference: deployment, name: '' },
    { reference: deployment, name: 'x', port: 0 }, { reference: deployment, name: 'x', port: 65536 }, { reference: deployment, name: 'x', port: 1.5 },
    { reference: deployment, name: 'x', type: 'ExternalName' }, { reference: deployment, name: 'x', protocol: 'HTTP' },
  ]) assert.equal(exposeParametersSchema.safeParse(bad).success === false, true, JSON.stringify(bad).slice(0, 90));
});
test('pure port input parse mirrors the numeric 1-65535 rule before any request exists', () => {
  assert.deepEqual(['1', '80', '65535'].map(parseExposePortInput), [1, 80, 65535]);
  for (const value of ['', '0', '65536', '80/http', '-1', '1e2', ' 80', '0x50']) assert.equal(parseExposePortInput(value), undefined, value);
});
test('request union carries its own grant/confirmation and never a CLI argv, path or body', () => {
  const submit = { protocol: 2, kind: 'submit', grant, id: outcome({ reference: deployment, name: 'web' }).id, proof: 'b'.repeat(64), confirmation: 'expose-exact-origin' };
  assert.equal(exposeRequestSchema.safeParse(submit).success, true);
  for (const extra of [{ argv: ['expose'] }, { path: '/api/v1/services' }, { body: '{}' }, { confirmation: 'scale-exact-target-replicas' }]) assert.equal(exposeRequestSchema.safeParse({ ...submit, ...extra }).success, false);
});
test('outcome ledger is metadata-only, optional fields stay explicit-or-absent, accepted cannot carry code', () => {
  const response = (value: unknown) => exposeResponseSchema.safeParse({ protocol: 2, kind: 'outcome', outcome: value }).success;
  assert.equal(response(outcome({ reference: deployment, name: 'web' })), true);
  assert.equal(response(outcome({ reference: deployment, name: 'web', port: 80 })), true);
  assert.equal(exposeOutcomeSchema.safeParse({ ...outcome({ reference: deployment, name: 'web' }), phase: 'accepted', code: 'FORBIDDEN' }).success, false);
  assert.equal(response({ ...outcome({ reference: deployment, name: 'web' }), phase: 'accepted' }), true);
  for (const extra of [{ body: 'x' }, { selector: {} }, { argv: [] }]) assert.equal(exposeOutcomeSchema.safeParse({ ...outcome({ reference: deployment, name: 'web' }), ...extra }).success, false);
});
