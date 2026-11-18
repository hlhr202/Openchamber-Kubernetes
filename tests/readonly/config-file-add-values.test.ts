// Pure protocol/input values only. Never import/call any real or mock Add File client/controller/adapter/operation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { configFileAddParametersSchema, configFileAddRequestSchema, configFileAddResponseSchema, configFileAddOutcomeSchema } from '../../src/shared/config-file-add-protocol.ts';
const target = { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'default' };
const grant = { id: '00000000-0000-4000-8000-000000000001', capability: 'a'.repeat(64), serviceGeneration: '00000000-0000-4000-8000-000000000002', expiresAt: 120_001 };
const configMap = { type: { group: '', version: 'v1', resource: 'configmaps', kind: 'ConfigMap', scope: 'namespace' as const }, name: 'app-config', namespace: 'default', uid: 'cm-uid', resourceVersion: '7' };
const secret = { type: { group: '', version: 'v1', resource: 'secrets', kind: 'Secret', scope: 'namespace' as const }, name: 'app-secret', namespace: 'default', uid: 's-uid', resourceVersion: '8' };
const file = (path: string) => ({ root: '/synthetic/project', path, version: 'f'.repeat(64), identity: 'd'.repeat(64), format: 'yaml' as const });
const parameters = { reference: configMap, key: 'app.yaml', file: file('app.yaml'), sourceDigest: 'd'.repeat(64) };
const outcome = { id: '00000000-0000-4000-8000-000000000003', owner: grant.id, step: 'config-file-add' as const, dependencies: [] as const, target, parameters, createdAt: 1, updatedAt: 1, encodedBytes: 120, phase: 'prepared' as const };
test('parameters bind one core/v1 parent, one key, and one original-read-proof file (never a Save receipt)', () => {
  assert.equal(configFileAddParametersSchema.safeParse(parameters).success, true);
  assert.equal(configFileAddParametersSchema.safeParse({ ...parameters, reference: secret, key: 'tls.crt' }).success, true);
  const receipt = { ...parameters, file: { ...parameters.file, receipt: { id: '00000000-0000-4000-8000-000000000009', generation: '00000000-0000-4000-8000-00000000000a', root: '/synthetic/project', path: 'app.yaml', version: 'e'.repeat(64) } } };
  assert.equal(configFileAddParametersSchema.safeParse(receipt).success, false); // a Save receipt never authorizes Add
  for (const bad of [
    { ...parameters, reference: { ...configMap, namespace: undefined } },
    { ...parameters, key: 'a/b' }, { ...parameters, key: '' },
    { ...parameters, sourceDigest: 'zz' }, { ...parameters, file: { ...parameters.file, identity: 'nothex' } },
  ]) assert.equal(configFileAddParametersSchema.safeParse(bad).success === false, true, JSON.stringify(bad).slice(0, 90));
});
test('request union carries the private file proof only at prepare and its own confirmation literal', () => {
  const submit = { protocol: 2, kind: 'submit', grant, id: outcome.id, proof: 'b'.repeat(64), confirmation: 'config-file-add-exact-key' };
  assert.equal(configFileAddRequestSchema.safeParse(submit).success, true);
  for (const extra of [{ argv: ['replace'] }, { body: '{}' }, { fileProof: 'legacy' }, { confirmation: 'config-file-delete-exact-key' }]) assert.equal(configFileAddRequestSchema.safeParse({ ...submit, ...extra }).success, false);
  const prepare = { protocol: 2, kind: 'prepare', grant, parameters, fileProof: 'p'.repeat(24) };
  assert.equal(configFileAddRequestSchema.safeParse(prepare).success === false, true); // proof must be a real workspace proof, validated by schema
});
test('outcome ledger is metadata-only; prepared carries the verified encoded size and accepted cannot carry code', () => {
  const response = (value: unknown) => configFileAddResponseSchema.safeParse({ protocol: 2, kind: 'outcome', outcome: value }).success;
  assert.equal(response(outcome), true);
  assert.equal(response({ ...outcome, phase: 'prepared', encodedBytes: undefined }), false);
  assert.equal(configFileAddOutcomeSchema.safeParse({ ...outcome, phase: 'accepted', code: 'FORBIDDEN' }).success, false);
  assert.equal(response({ ...outcome, phase: 'accepted' }), true);
  for (const extra of [{ body: 'x' }, { value: 'x' }, { argv: [] }]) assert.equal(configFileAddOutcomeSchema.safeParse({ ...outcome, ...extra }).success, false);
});
