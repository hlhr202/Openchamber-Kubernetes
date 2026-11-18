// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeKubeconfigRequestSchema, mergeKubeconfigResponseSchema, wslUnsupportedMessage, errorFetchingKubeconfigMessage, duplicatePromptMessage, mergeCancelledMessage, mergedMessage, OVERWRITE_BUTTON, KEEP_BOTH_BUTTON, CANCEL_BUTTON, firstMergePath, collisionState, duplicateNamesDescription, findNextCounter, keepBothSuffix, applyKeepBothSuffix, mergeFirstStanzas, shouldSetCurrentContext } from '../../src/shared/merge-kubeconfig-protocol.ts';
test('the request is a bare merge and the response is a strict quintet', () => {
  assert.equal(mergeKubeconfigRequestSchema.safeParse({ protocol: 2, kind: 'merge' }).success, true);
  for (const bad of [{ kind: 'replace' }, { kind: 'merge', text: 'apiVersion: v1' }, { extra: 1 }]) assert.equal(mergeKubeconfigRequestSchema.safeParse({ protocol: 2, kind: 'merge', ...bad }).success === false, true, JSON.stringify(bad));
  for (const kind of ['wsl-unsupported', 'merge-cancelled', 'merge-completed']) assert.equal(mergeKubeconfigResponseSchema.safeParse({ protocol: 2, kind }).success, true, kind);
  assert.equal(mergeKubeconfigResponseSchema.safeParse({ protocol: 2, kind: 'merge-confirmed', renameWithSuffix: true }).success, true);
  assert.equal(mergeKubeconfigResponseSchema.safeParse({ protocol: 2, kind: 'merge-confirmed', renameWithSuffix: false }).success, true);
  assert.equal(mergeKubeconfigResponseSchema.safeParse({ protocol: 2, kind: 'merge-unavailable', code: 'CONFIG_UNREADABLE' }).success, true);
  for (const bad of [{ kind: 'merge-confirmed' }, { kind: 'merge-confirmed', renameWithSuffix: 'yes' }, { kind: 'merge-unavailable', code: 'NOPE' }, { kind: 'merge-unavailable' }, { kind: 'merge-completed', path: '/x' }, { kind: 'rolled-back' }]) assert.equal(mergeKubeconfigResponseSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
});
test('the messages, buttons and first-path rule are upstream verbatim', () => {
  assert.equal(wslUnsupportedMessage(), "You are on Windows, but are using WSL-based tools. We can't merge into your WSL kubeconfig. Consider running VS Code in WSL using the Remote Extensions.");
  assert.equal(errorFetchingKubeconfigMessage(), 'Error fetching kubeconfig.');
  assert.equal(duplicatePromptMessage("cluster 'a', user 'b'"), "cluster 'a', user 'b' already exist in kubeconfig. What would you like to do?");
  assert.equal(mergeCancelledMessage(), 'Merge cancelled.');
  assert.equal(mergedMessage('/home/u/.kube/config'), 'New configuration merged to /home/u/.kube/config');
  assert.equal(OVERWRITE_BUTTON, 'Overwrite');
  assert.equal(KEEP_BOTH_BUTTON, 'Keep Both');
  assert.equal(CANCEL_BUTTON, 'Cancel');
  assert.equal(firstMergePath('/a:/b:/c', ':'), '/a');
  assert.equal(firstMergePath('/a', ':'), '/a');
});
test('collision detection, duplicate list and counters are upstream verbatim', () => {
  const existing = { clusters: [{ name: 'c1' }], users: [{ name: 'u1' }], contexts: [{ name: 'k1' }] };
  const colliding = { clusters: [{ name: 'c1' }], users: [{ name: 'u2' }], contexts: [{ name: 'k1' }] };
  assert.deepEqual(collisionState(existing, colliding), { clusterExists: true, userExists: false, contextExists: true });
  assert.deepEqual(collisionState({}, { clusters: [{ name: 'x' }] }), { clusterExists: false, userExists: false, contextExists: false });
  assert.equal(duplicateNamesDescription(true, false, true, 'c1', 'u2', 'k1'), "cluster 'c1', context 'k1'");
  assert.equal(duplicateNamesDescription(false, true, false, 'c1', 'u2', 'k1'), "user 'u2'");
  assert.equal(duplicateNamesDescription(true, true, true, 'c1', 'u2', 'k1'), "cluster 'c1', user 'u2', context 'k1'");
  assert.equal(findNextCounter(['a', 'a (2)'], 'a'), 3);
  assert.equal(findNextCounter(['a'], 'a'), 2);
  assert.equal(findNextCounter([], 'a'), 2);
});
test('keep-both suffixes and rewrites follow the upstream AKS and counter patterns', () => {
  assert.equal(keepBothSuffix('clusterUser_rg1_cluster', 'aks', ['aks', 'other']), ' (rg1)');
  assert.equal(keepBothSuffix('clusterUser_rg1_cluster', 'aks', ['aks', 'aks (rg1)']), ' (rg1) (2)');
  assert.equal(keepBothSuffix('clusterUser_rg1_cluster', 'aks', ['aks', 'aks (rg1)', 'aks (rg1) (2)']), ' (rg1) (3)');
  assert.equal(keepBothSuffix('plain-user', 'aks', ['aks', 'aks (2)']), ' (3)');
  const renamed = applyKeepBothSuffix({ name: 'aks' }, { name: 'clusterUser_rg1_cluster' }, { name: 'k1', context: { cluster: 'aks', user: 'clusterUser_rg1_cluster' } }, ' (rg1)');
  assert.equal(renamed.cluster.name, 'aks (rg1)');
  assert.equal(renamed.user.name, 'clusterUser_rg1_cluster (rg1)');
  assert.equal(renamed.context.name, 'k1 (rg1)');
  assert.equal(renamed.context.context?.cluster, 'aks (rg1)');
  assert.equal(renamed.context.context?.user, 'clusterUser_rg1_cluster (rg1)');
  const noCtx = applyKeepBothSuffix({ name: 'a' }, { name: 'u' }, { name: 'k' }, ' (2)');
  assert.equal(noCtx.context.context, undefined);
});
test('the merge loop replaces exact matches in place and appends new names, current-context only for new files', () => {
  const existing = { clusters: [{ name: 'c1', cluster: { server: 'https://old' } }, { name: 'c2' }], 'current-context': 'keep-me' };
  const incoming = { clusters: [{ name: 'c1', cluster: { server: 'https://new' } }], users: [{ name: 'u1' }] };
  const merged = mergeFirstStanzas(existing, incoming);
  assert.deepEqual(merged.clusters?.map((c) => [c.name, c.context === undefined ? (c as { cluster?: { server?: string } }).cluster?.server : undefined]), [['c1', 'https://new'], ['c2', undefined]]);
  assert.deepEqual(merged.users?.map((u) => u.name), ['u1']);
  assert.equal(merged['current-context'], 'keep-me');
  assert.equal(shouldSetCurrentContext(false, { name: 'k1' }), true);
  assert.equal(shouldSetCurrentContext(true, { name: 'k1' }), false);
  assert.equal(shouldSetCurrentContext(false, undefined), false);
});

// ---- Approved batch-2 G4 chain values ----
import { mergeKubeconfigGateParametersSchema, mergeKubeconfigRequest2Schema, mergeKubeconfigOutcomeSchema, mergeKubeconfigPreviewSchema } from '../../src/shared/merge-kubeconfig-protocol.ts';
const mergeGrant = { id: '00000000-0000-4000-8000-000000000021', capability: 'a'.repeat(64), serviceGeneration: '00000000-0000-4000-8000-000000000022', expiresAt: 120_001 };
test('the G4 parameters carry exactly one strategy and bounded incoming text', () => {
  assert.equal(mergeKubeconfigGateParametersSchema.safeParse({ strategy: 'keep-both', incoming: 'apiVersion: v1\nkind: Config\n' }).success, true);
  assert.equal(mergeKubeconfigGateParametersSchema.safeParse({ strategy: 'overwrite', incoming: 'x'.repeat(1000) }).success, true);
  for (const bad of [
    { strategy: 'cancel', incoming: 'x' }, // Cancel is a decision, never a submitted strategy
    { strategy: 'overwrite' },
    { strategy: 'overwrite', incoming: '' },
    { strategy: 'overwrite', incoming: 'x', extra: 1 },
  ]) assert.equal(mergeKubeconfigGateParametersSchema.safeParse(bad).success, false, JSON.stringify(bad));
});
test('the gate requests keep the fixed confirmation and the preview stays bounded metadata', () => {
  assert.equal(mergeKubeconfigRequest2Schema.safeParse({ protocol: 2, kind: 'open', selection: { mode: 'default' } }).success, true);
  assert.equal(mergeKubeconfigRequest2Schema.safeParse({ protocol: 2, kind: 'submit', grant: mergeGrant, id: '00000000-0000-4000-8000-000000000023', proof: 'b'.repeat(64), confirmation: 'merge-kubeconfig-exact-first-path' }).success, true);
  assert.equal(mergeKubeconfigRequest2Schema.safeParse({ protocol: 2, kind: 'submit', grant: mergeGrant, id: '00000000-0000-4000-8000-000000000023', proof: 'b'.repeat(64), confirmation: 'other' }).success, false);
  const preview = { targetPath: '/home/node/.kube/config', creates: false, duplicates: "cluster 'c', context 'x'", keepBothSuffix: ' (2)', clusters: 3, users: 3, contexts: 3, setsCurrentContext: false };
  assert.equal(mergeKubeconfigPreviewSchema.safeParse(preview).success, true);
  assert.equal(mergeKubeconfigPreviewSchema.safeParse({ ...preview, duplicates: 'x'.repeat(2000) }).success, false);
  const outcome = { id: '00000000-0000-4000-8000-000000000024', owner: mergeGrant.id, step: 'merge-kubeconfig', dependencies: [] as const, createdAt: 1, updatedAt: 1, strategy: 'keep-both' as const };
  assert.equal(mergeKubeconfigOutcomeSchema.safeParse({ ...outcome, phase: 'prepared' }).success, true);
  assert.equal(mergeKubeconfigOutcomeSchema.safeParse({ ...outcome, phase: 'accepted', code: 'CONFLICT' }).success, false);
});
