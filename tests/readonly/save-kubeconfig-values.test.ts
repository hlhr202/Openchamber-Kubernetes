// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { saveKubeconfigRequestSchema, saveKubeconfigResponseSchema, requiresClusterMessage, onlyFileSystemMessage, fileExistsMessage, configurationSavedMessage, mayWriteTarget } from '../../src/shared/save-kubeconfig-protocol.ts';
test('the request takes optional bounded provider/cluster and the response is a strict sextet', () => {
  assert.equal(saveKubeconfigRequestSchema.safeParse({ protocol: 2, kind: 'save' }).success, true);
  assert.equal(saveKubeconfigRequestSchema.safeParse({ protocol: 2, kind: 'save', provider: 'aks', cluster: 'my-aks' }).success, true);
  for (const bad of [{ provider: '' }, { provider: 'a b' }, { provider: '-lead' }, { cluster: '' }, { cluster: 'a b' }, { cluster: 'a'.repeat(254) }, { kind: 'overwrite' }, { fsPath: '/tmp/x' }, { extra: 1 }]) assert.equal(saveKubeconfigRequestSchema.safeParse({ protocol: 2, kind: 'save', ...bad }).success === false, true, JSON.stringify(bad));
  for (const kind of ['cluster-required', 'save-cancelled', 'non-file-target', 'target-already-exists', 'kubeconfig-saved']) assert.equal(saveKubeconfigResponseSchema.safeParse({ protocol: 2, kind }).success, true, kind);
  assert.equal(saveKubeconfigResponseSchema.safeParse({ protocol: 2, kind: 'save-unavailable', code: 'CONFIG_UNREADABLE' }).success, true);
  for (const bad of [{ kind: 'save-unavailable', code: 'NOPE' }, { kind: 'save-unavailable' }, { kind: 'kubeconfig-saved', path: '/tmp/x' }, { kind: 'kubeconfig-overwritten' }, { kind: 'merged-and-activated' }]) assert.equal(saveKubeconfigResponseSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
});
test('all four messages are upstream verbatim', () => {
  assert.equal(requiresClusterMessage(), 'This command requires a cluster to be selected in Cloud Explorer');
  assert.equal(onlyFileSystemMessage(), 'Can only save to the file system');
  assert.equal(fileExistsMessage(), 'File already exists');
  assert.equal(configurationSavedMessage('/home/u/aks.yaml'), 'Configuration saved to /home/u/aks.yaml');
});
test('the write gate is refuse-before-write: an existing target is never overwritten', () => {
  assert.equal(mayWriteTarget(false, true, false), true);
  assert.equal(mayWriteTarget(true, true, false), false);
  assert.equal(mayWriteTarget(false, false, false), false);
  assert.equal(mayWriteTarget(false, true, true), false);
  assert.equal(mayWriteTarget(true, false, true), false);
});
