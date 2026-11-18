// Pure protocol/input values only. Never import/call any real or mock Delete File client/controller/adapter/operation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { configFileDeleteParametersSchema, configFileDeleteRequestSchema, configFileDeleteResponseSchema, configFileDeleteOutcomeSchema, configDataKeySchema } from '../../src/shared/config-file-protocol.ts';
const target = { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'default' };
const grant = { id: '00000000-0000-4000-8000-000000000001', capability: 'a'.repeat(64), serviceGeneration: '00000000-0000-4000-8000-000000000002', expiresAt: 120_001 };
const configMap = { type: { group: '', version: 'v1', resource: 'configmaps', kind: 'ConfigMap', scope: 'namespace' as const }, name: 'app-config', namespace: 'default', uid: 'cm-uid', resourceVersion: '7' };
const secret = { type: { group: '', version: 'v1', resource: 'secrets', kind: 'Secret', scope: 'namespace' as const }, name: 'app-secret', namespace: 'default', uid: 's-uid', resourceVersion: '8' };
const parameters = { reference: configMap, key: 'settings.json' };
const outcome = { id: '00000000-0000-4000-8000-000000000003', owner: grant.id, step: 'config-file-delete' as const, dependencies: [] as const, target, parameters, createdAt: 1, updatedAt: 1, phase: 'prepared' as const };
test('parameters admit core/v1 ConfigMap/Secret parents with exactly one printable data key', () => {
  assert.equal(configFileDeleteParametersSchema.safeParse(parameters).success, true);
  assert.equal(configFileDeleteParametersSchema.safeParse({ reference: secret, key: 'tls.crt' }).success, true);
  for (const bad of [
    { reference: { ...configMap, type: { ...configMap.type, resource: 'pods', kind: 'Pod' } }, key: 'x' },
    { reference: { ...configMap, namespace: undefined }, key: 'x' }, // original namespace only
    { reference: configMap, key: '' }, { reference: configMap, key: 'a/b' }, { reference: configMap, key: 'a\\b' },
    { reference: configMap, key: 'a b' }, { reference: configMap, key: 'x'.repeat(512) }, { reference: configMap, key: 'a\0b' },
  ]) assert.equal(configFileDeleteParametersSchema.safeParse(bad).success === false, true, JSON.stringify(bad).slice(0, 90));
});
test('data keys stay opaque printable basenames, never paths or control text', () => {
  for (const key of ['settings.json', 'tls.crt', 'key-1_2', 'A', 'x'.repeat(511)]) assert.equal(configDataKeySchema.safeParse(key).success, true, key);
  for (const key of ['', '/abs', '../up', 'a/b', 'a\\b', 'a b', 'a\nb', 'a\0b', 'x'.repeat(512), '键']) assert.equal(configDataKeySchema.safeParse(key).success, false, JSON.stringify(key));
});
test('request union carries its own grant/confirmation and never a CLI argv, path or body', () => {
  const submit = { protocol: 2, kind: 'submit', grant, id: outcome.id, proof: 'b'.repeat(64), confirmation: 'config-file-delete-exact-key' };
  assert.equal(configFileDeleteRequestSchema.safeParse(submit).success, true);
  for (const extra of [{ argv: ['replace'] }, { path: '/api/v1/namespaces' }, { body: '{}' }, { confirmation: 'expose-exact-origin' }, { keys: ['a', 'b'] }]) assert.equal(configFileDeleteRequestSchema.safeParse({ ...submit, ...extra }).success, false);
});
test('outcome ledger is metadata-only and accepted results cannot claim an error code', () => {
  const response = (value: unknown) => configFileDeleteResponseSchema.safeParse({ protocol: 2, kind: 'outcome', outcome: value }).success;
  assert.equal(response(outcome), true);
  assert.equal(configFileDeleteOutcomeSchema.safeParse({ ...outcome, phase: 'accepted', code: 'FORBIDDEN' }).success, false);
  assert.equal(response({ ...outcome, phase: 'accepted' }), true);
  assert.equal(response({ ...outcome, phase: 'unknown', code: 'OPERATION_UNKNOWN' }), true);
  for (const extra of [{ body: 'x' }, { data: {} }, { argv: [] }]) assert.equal(configFileDeleteOutcomeSchema.safeParse({ ...outcome, ...extra }).success, false);
});
