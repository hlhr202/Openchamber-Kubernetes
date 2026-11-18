// Pure protocol/input values only. Never import/call any real or mock file-delete client/controller/adapter/operation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileDeleteParametersSchema, fileDeleteRequestSchema, fileDeleteResponseSchema, fileDeleteOutcomeSchema } from '../../src/shared/file-delete-protocol.ts';
const target = { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'default' };
const grant = { id: '00000000-0000-4000-8000-000000000001', capability: 'a'.repeat(64), serviceGeneration: '00000000-0000-4000-8000-000000000002', expiresAt: 120_001 };
const file = { root: '/synthetic/project', path: 'app.yaml', version: 'f'.repeat(64), identity: 'd'.repeat(64), format: 'yaml' as const };
const parameters = { file, sourceDigest: 'd'.repeat(64) };
const reference = { type: { group: '', version: 'v1', resource: 'configmaps', kind: 'ConfigMap', scope: 'namespace' as const }, name: 'app-config', namespace: 'default', uid: 'cm-uid', resourceVersion: '7' };
const outcome = { id: '00000000-0000-4000-8000-000000000003', owner: grant.id, step: 'file-delete-request' as const, dependencies: [] as const, target, parameters, reference, createdAt: 1, updatedAt: 1, phase: 'prepared' as const };
test('parameters bind exactly one original-read-proof file (never a Save receipt) and its digest', () => {
  assert.equal(fileDeleteParametersSchema.safeParse(parameters).success, true);
  const receipt = { ...parameters, file: { ...parameters.file, receipt: { id: '00000000-0000-4000-8000-000000000009', generation: '00000000-0000-4000-8000-00000000000a', root: '/synthetic/project', path: 'app.yaml', version: 'e'.repeat(64) } } };
  assert.equal(fileDeleteParametersSchema.safeParse(receipt).success, false);
  for (const bad of [{ ...parameters, sourceDigest: 'zz' }, { ...parameters, file: { ...parameters.file, identity: 'nothex' } }, { ...parameters, file: { ...parameters.file, path: '' } }]) assert.equal(fileDeleteParametersSchema.safeParse(bad).success === false, true);
});
test('request union carries the private file proof only at prepare and its own confirmation literal', () => {
  const submit = { protocol: 2, kind: 'submit', grant, id: outcome.id, proof: 'b'.repeat(64), confirmation: 'file-delete-exact-pinned-object' };
  assert.equal(fileDeleteRequestSchema.safeParse(submit).success, true);
  for (const extra of [{ argv: ['delete'] }, { body: '{}' }, { path: '/api/v1' }, { confirmation: 'config-file-delete-exact-key' }, { now: true }, { force: true }]) assert.equal(fileDeleteRequestSchema.safeParse({ ...submit, ...extra }).success, false);
});
test('outcome requires the pinned live reference from prepared onwards; accepted cannot carry code', () => {
  const response = (value: unknown) => fileDeleteResponseSchema.safeParse({ protocol: 2, kind: 'outcome', outcome: value }).success;
  assert.equal(response(outcome), true);
  assert.equal(response({ ...outcome, reference: undefined }), false); // no bare-name delete can be confirmed
  assert.equal(fileDeleteOutcomeSchema.safeParse({ ...outcome, phase: 'accepted', code: 'FORBIDDEN' }).success, false);
  assert.equal(response({ ...outcome, phase: 'accepted' }), true);
  assert.equal(response({ ...outcome, phase: 'unknown', code: 'OPERATION_UNKNOWN' }), true);
  for (const extra of [{ body: 'x' }, { text: 'x' }, { argv: [] }]) assert.equal(fileDeleteOutcomeSchema.safeParse({ ...outcome, ...extra }).success, false);
});
