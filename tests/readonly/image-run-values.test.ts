// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { imageRunRequestSchema, imageRunResponseSchema, sanitiseTag, runImageReference, buildCommand, pushCommand, kubectlRunArguments, diagnosePushError } from '../../src/shared/image-run-protocol.ts';
test('the request takes a canonical workspace location, a bounded version and an optional token user', () => {
  assert.equal(imageRunRequestSchema.safeParse({ protocol: 2, kind: 'run', root: '/w/proj', path: '', version: '0.1.0' }).success, true);
  assert.equal(imageRunRequestSchema.safeParse({ protocol: 2, kind: 'run', root: '/w/proj', path: 'sub', version: 'v1', user: 'myuser' }).success, true);
  const cases: unknown[] = [
    { protocol: 2, kind: 'run', root: 'relative', path: '', version: 'v1' },
    { protocol: 2, kind: 'run', root: '/w', path: '../escape', version: 'v1' },
    { protocol: 2, kind: 'run', root: '/w', path: '', version: '' },
    { protocol: 2, kind: 'run', root: '/w', path: '', version: 'a b' },
    { protocol: 2, kind: 'run', root: '/w', path: '', version: 'x'.repeat(129) },
    { protocol: 2, kind: 'run', root: '/w', path: '', version: 'v1', user: '-lead' },
    { protocol: 2, kind: 'run', root: '/w', path: '', version: 'v1', user: 'a'.repeat(129) },
    { protocol: 2, kind: 'read', root: '/w', path: '', version: 'v1' },
    { protocol: 2, kind: 'run', root: '/w', path: '', version: 'v1', extra: 1 },
  ];
  for (const bad of cases) assert.equal(imageRunRequestSchema.safeParse(bad).success === false, true, JSON.stringify(bad));
});
test('docker tag sanitisation is upstream verbatim (lowercase, non-component runes to dash)', () => {
  assert.equal(sanitiseTag('My_Project.2-x'), 'my_project.2-x');
  assert.equal(sanitiseTag('App Name!'), 'app-name-'); // quirk preserved: no leading/trailing separator trim
  assert.equal(sanitiseTag('Ünïcode'), '-n-code');
});
test('the image reference keeps the upstream name/image derivation verbatim', () => {
  assert.deepEqual(runImageReference('My App', '0.1.0', undefined), { name: 'my-app', image: 'my-app:0.1.0' });
  assert.deepEqual(runImageReference('myapp', 'v1', 'myuser'), { name: 'myapp', image: 'myuser/myapp:v1' });
});
test('build/push/kubectl-run command shapes are verbatim and push errors keep the three branches', () => {
  assert.equal(buildCommand('Docker', 'docker', 'my-app:0.1.0'), 'docker build -t my-app:0.1.0 .');
  assert.equal(buildCommand('Buildah', 'buildah', 'my-app:0.1.0'), 'buildah bud -t my-app:0.1.0 .');
  assert.equal(pushCommand('docker', 'my-app:0.1.0'), 'docker push my-app:0.1.0');
  assert.deepEqual(kubectlRunArguments('my-app', 'my-app:0.1.0'), ['run', 'my-app', '--image=my-app:0.1.0']);
  assert.equal(diagnosePushError(1, 'authorization denied', true), 'Failed pushing the image to remote registry. Try to login to an image registry.');
  assert.equal(diagnosePushError(1, 'requested access to the resource is denied', false), 'Failed pushing the image to remote registry. Try setting vsdocker.imageUser.');
  assert.equal(diagnosePushError(1, 'network timeout', true), 'Image push failed.');
  assert.equal(imageRunResponseSchema.safeParse({ protocol: 2, kind: 'image-run', name: 'my-app', image: 'my-app:0.1.0', built: true, pushed: true, ran: true }).success, true);
  assert.equal(imageRunResponseSchema.safeParse({ protocol: 2, kind: 'image-run', name: 'x'.repeat(1025), image: 'i', built: false, pushed: false, ran: false }).success, false);
  assert.equal(imageRunResponseSchema.safeParse({ protocol: 2, kind: 'image-run-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(imageRunResponseSchema.safeParse({ protocol: 2, kind: 'image-run-unavailable', code: 'NOPE' }).success, false);
});

// ---- Approved batch-2 G4 chain values ----
import { imageRunGateRequestSchema, imageRunParametersSchema, imageRunOutcomeSchema } from '../../src/shared/image-run-protocol.ts';
const runGrant = { id: '00000000-0000-4000-8000-000000000001', capability: 'a'.repeat(64), serviceGeneration: '00000000-0000-4000-8000-000000000002', expiresAt: 120_001 };
const runTarget = { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'default' };
const runParameters = { root: '/workspace/my-app', contextPath: '', version: 'v1', image: 'my-app:v1', name: 'my-app' };
test('run parameters pin the derived image exactly (folder sanitisation + version + optional user)', () => {
  assert.equal(imageRunParametersSchema.safeParse(runParameters).success, true);
  assert.equal(imageRunParametersSchema.safeParse({ ...runParameters, user: 'team', image: 'team/my-app:v1' }).success, true);
  for (const bad of [
    { ...runParameters, image: 'other:v1' }, // mismatched derivation
    { ...runParameters, version: '' },
    { ...runParameters, name: 'My App' },
  ]) assert.equal(imageRunParametersSchema.safeParse(bad).success, false, JSON.stringify(bad));
});
test('the run outcome discloses build/push/pod progress only after dispatch and never a code on accepted', () => {
  const base = { id: '00000000-0000-4000-8000-000000000003', owner: runGrant.id, step: 'image-run', dependencies: [] as const, target: runTarget, parameters: runParameters, createdAt: 1, updatedAt: 1 };
  assert.equal(imageRunOutcomeSchema.safeParse({ ...base, phase: 'prepared' }).success, true);
  assert.equal(imageRunOutcomeSchema.safeParse({ ...base, phase: 'accepted', built: true, pushed: true, podUid: 'u', podResourceVersion: '1' }).success, true);
  assert.equal(imageRunOutcomeSchema.safeParse({ ...base, phase: 'accepted', built: true, pushed: true, podUid: 'u', podResourceVersion: '1', code: 'NOT_FOUND' }).success, false);
  assert.equal(imageRunOutcomeSchema.safeParse({ ...base, phase: 'accepted' }).success, false); // accepted requires the full chain
  assert.equal(imageRunOutcomeSchema.safeParse({ ...base, phase: 'failed', code: 'CLI_NOT_FOUND', built: false, pushed: false }).success, true);
  assert.equal(imageRunOutcomeSchema.safeParse({ ...base, phase: 'failed', code: 'CLI_NOT_FOUND', built: false, pushed: false, podUid: 'u' }).success, false); // pod never claimed without chain
  assert.equal(imageRunGateRequestSchema.safeParse({ protocol: 2, kind: 'submit', grant: runGrant, id: '00000000-0000-4000-8000-000000000004', proof: 'b'.repeat(64), confirmation: 'image-run-exact-build-push-pod' }).success, true);
  assert.equal(imageRunGateRequestSchema.safeParse({ protocol: 2, kind: 'submit', grant: runGrant, id: '00000000-0000-4000-8000-000000000004', proof: 'b'.repeat(64), confirmation: 'other' }).success, false);
});
