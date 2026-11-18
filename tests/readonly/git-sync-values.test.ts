// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { gitSyncRequestSchema, gitSyncResponseSchema, imageTagCommit, syncVersionMessage, gitWhenCreatedArguments, gitCheckoutArguments, imageReference } from '../../src/shared/git-sync-protocol.ts';
test('the request takes a canonical repo location and a bounded single-line image reference', () => {
  assert.equal(gitSyncRequestSchema.safeParse({ protocol: 2, kind: 'run', root: '/w/repo', path: '', image: 'myapp:abc123' }).success, true);
  const cases: unknown[] = [
    { protocol: 2, kind: 'run', root: 'relative', path: '', image: 'myapp:abc123' },
    { protocol: 2, kind: 'run', root: '/w', path: '../escape', image: 'myapp:abc123' },
    { protocol: 2, kind: 'run', root: '/w', path: '', image: '' },
    { protocol: 2, kind: 'run', root: '/w', path: '', image: 'a\nb' },
    { protocol: 2, kind: 'run', root: '/w', path: '', image: 'x'.repeat(513) },
    { protocol: 2, kind: 'read', root: '/w', path: '', image: 'myapp:abc123' },
    { protocol: 2, kind: 'run', root: '/w', path: '', image: 'myapp:abc123', extra: 1 },
  ];
  for (const bad of cases) assert.equal(gitSyncRequestSchema.safeParse(bad).success === false, true, JSON.stringify(bad));
  assert.equal(imageReference.safeParse('registry:5000/nested/app:v1').success, true); // colons allowed in the reference; only the SPLIT rule constrains
});
test('the tag rule is upstream verbatim: exactly two pieces, second is the commit id', () => {
  assert.equal(imageTagCommit('myapp:abc123def'), 'abc123def');
  // Upstream quirk preserved VERBATIM: 'registry:5000/app' splits into two pieces and '5000/app'
  // is returned as the "commit id"; a full 'registry:5000/app:v1' has THREE pieces and upstream
  // REJECTS it (disclosed naivety — the split rule is exactly this naive).
  assert.equal(imageTagCommit('registry:5000/app'), '5000/app');
  assert.equal(imageTagCommit('registry:5000/app:v1'), null);
  assert.equal(imageTagCommit('a:b:c'), null); // more than one colon
  assert.equal(imageTagCommit('myapp:'), null); // empty tag
});
test('the version message keeps both upstream branches verbatim', () => {
  assert.ok(syncVersionMessage('abc123', '2 hours ago').includes('The Git commit deployed to the cluster is  abc123'));
  // Upstream quirk preserved: the template appends ' ago' AFTER the relative time, so a relative
  // time already ending in 'ago' reads '2 hours ago ago' — verbatim, disclosed.
  assert.ok(syncVersionMessage('abc123', '2 hours ago').includes('(created 2 hours ago ago)'));
  assert.equal(syncVersionMessage('abc123', null), 'The image version deployed to the cluster is abc123. This will look for a Git commit with that name/ID and check it out.');
  const trimmed = syncVersionMessage('abc123', '  3 days  ');
  assert.ok(trimmed.includes('(created 3 days ago)')); // whenCreated.trim()
});
test('the git command projections are verbatim and the response is bounded', () => {
  assert.deepEqual(gitWhenCreatedArguments('abc123'), ['log', '--pretty=%ar', '-n', '1', 'abc123']);
  assert.deepEqual(gitCheckoutArguments('abc123'), ['checkout', 'abc123']);
  assert.equal(gitSyncResponseSchema.safeParse({ protocol: 2, kind: 'git-synced', commitId: 'abc123', whenCreated: '2 hours ago' }).success, true);
  assert.equal(gitSyncResponseSchema.safeParse({ protocol: 2, kind: 'git-synced', commitId: 'abc123', whenCreated: null }).success, true);
  assert.equal(gitSyncResponseSchema.safeParse({ protocol: 2, kind: 'git-synced', commitId: 'x'.repeat(129), whenCreated: null }).success, false);
  assert.equal(gitSyncResponseSchema.safeParse({ protocol: 2, kind: 'git-sync-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(gitSyncResponseSchema.safeParse({ protocol: 2, kind: 'git-sync-unavailable', code: 'NOPE' }).success, false);
});

// ---- Approved batch-2 G4 chain values ----
import { gitSyncGateRequestSchema, gitSyncParametersSchema, gitSyncOutcomeSchema } from '../../src/shared/git-sync-protocol.ts';
const syncGrant = { id: '00000000-0000-4000-8000-000000000001', capability: 'a'.repeat(64), serviceGeneration: '00000000-0000-4000-8000-000000000002', expiresAt: 120_001 };
const syncTarget = { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'default' };
const syncParameters = { root: '/workspace/repo', path: '', image: 'app:1a2b3c4', commitId: '1a2b3c4', whenCreated: '2 hours ago' };
test('sync parameters derive the commit only from the upstream tag rule', () => {
  assert.equal(gitSyncParametersSchema.safeParse(syncParameters).success, true);
  assert.equal(gitSyncParametersSchema.safeParse({ ...syncParameters, whenCreated: null }).success, true);
  for (const bad of [
    { ...syncParameters, commitId: 'other' }, // not the tag
    { ...syncParameters, commitId: '-bad' }, // can never become a git option
  ]) assert.equal(gitSyncParametersSchema.safeParse(bad).success, false, JSON.stringify(bad));
});
test('the sync gate keeps the fixed grant/confirmation shapes and metadata-only outcomes', () => {
  const base = { id: '00000000-0000-4000-8000-000000000003', owner: syncGrant.id, step: 'git-sync', dependencies: [] as const, target: syncTarget, parameters: syncParameters, createdAt: 1, updatedAt: 1 };
  assert.equal(gitSyncOutcomeSchema.safeParse({ ...base, phase: 'prepared' }).success, true);
  assert.equal(gitSyncOutcomeSchema.safeParse({ ...base, phase: 'accepted', code: 'X' as never }).success, false);
  assert.equal(gitSyncGateRequestSchema.safeParse({ protocol: 2, kind: 'submit', grant: syncGrant, id: '00000000-0000-4000-8000-000000000004', proof: 'b'.repeat(64), confirmation: 'git-sync-exact-checkout' }).success, true);
  assert.equal(gitSyncGateRequestSchema.safeParse({ protocol: 2, kind: 'prepare', grant: syncGrant, parameters: syncParameters }).success, true);
});
