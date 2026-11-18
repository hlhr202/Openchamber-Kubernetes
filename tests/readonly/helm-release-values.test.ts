// Pure protocol/decoder values with SYNTHETIC fixtures only (self-built gzip payloads).
// Never import/call any real adapter, operation, client or route.
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { helmReleaseRequestSchema, helmReleaseResponseSchema, helmReleaseEntrySchema, groupHelmReleases } from '../../src/shared/helm-release-protocol.ts';
import { decodeHelmReleaseSecret, helmReleaseSecretName, helmReleaseSecretLabelsSchema } from '../../src/service/queries/helm-release-secret.ts';
const target = { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'default' };
const grantUid = 'secret-uid-1', rv = '5';
function syntheticReleasePayload(name: string, revision: number, status: string, chartName = 'nginx', chartVersion = '1.0.0') {
  return JSON.stringify({ name, namespace: 'default', version: revision, info: { first_deployed: '2026-11-16T00:00:00Z', last_deployed: '2026-11-16T01:00:00Z', status, description: 'Install complete' },
    chart: { metadata: { name: chartName, version: chartVersion, appVersion: '1.2.3' } } });
}
function syntheticSecret(name: string, revision: number, status: string, chartName?: string, chartVersion?: string) {
  const inner = Buffer.from(gzipSync(Buffer.from(syntheticReleasePayload(name, revision, status, chartName, chartVersion)))).toString('base64');
  return { labels: { owner: 'helm', name, version: String(revision), status }, namespace: 'default',
    dataRelease: Buffer.from(inner).toString('base64'), uid: grantUid, resourceVersion: rv };
}
test('the request is one explicit namespace read bound to a target and selection', () => {
  assert.equal(helmReleaseRequestSchema.safeParse({ protocol: 2, kind: 'read', selection: { mode: 'default' }, target, namespace: 'default' }).success, true);
  for (const bad of [
    { protocol: 2, kind: 'read', selection: { mode: 'default' }, target, namespace: 'Default' },
    { protocol: 2, kind: 'read', selection: { mode: 'default' }, target, namespace: 'default', text: 'x' },
    { protocol: 2, kind: 'read', target, namespace: 'default' },
  ]) assert.equal(helmReleaseRequestSchema.safeParse(bad).success, false, JSON.stringify(bad));
});
test('the decoder turns the pinned double-base64+gzip storage format into bounded metadata', () => {
  const decoded = decodeHelmReleaseSecret(syntheticSecret('web', 2, 'deployed'));
  assert.equal(decoded.name, 'web'); assert.equal(decoded.namespace, 'default');
  assert.equal(decoded.revision, 2); assert.equal(decoded.status, 'deployed');
  assert.equal(decoded.chartName, 'nginx'); assert.equal(decoded.chartVersion, '1.0.0');
  assert.equal(decoded.appVersion, '1.2.3'); assert.equal(decoded.uid, grantUid); assert.equal(decoded.resourceVersion, rv);
  assert.equal(helmReleaseSecretName('web', 2), 'sh.helm.release.v1.web.v2');
  for (const bad of [
    { ...syntheticSecret('web', 2, 'deployed'), labels: { owner: 'tiller', name: 'web', version: '2', status: 'deployed' } },
    { ...syntheticSecret('web', 2, 'deployed'), dataRelease: Buffer.from('not-base64-!!!').toString('base64') },
    { ...syntheticSecret('web', 2, 'deployed'), labels: { owner: 'helm', name: 'other', version: '2', status: 'deployed' } }, // label/name mismatch
  ]) assert.throws(() => decodeHelmReleaseSecret(bad), /CONTENT_INVALID/);
  assert.equal(helmReleaseSecretLabelsSchema.safeParse({ owner: 'helm', name: 'web', version: '2', status: 'pending-install' }).success, true);
});
test('grouping orders releases and caps revisions at the newest 16 with disclosure', () => {
  const revisions = [
    { name: 'web', namespace: 'default', revision: 1, status: 'superseded' as const, chartName: 'nginx', chartVersion: '1.0.0', uid: 'u1', resourceVersion: '1' },
    { name: 'web', namespace: 'default', revision: 2, status: 'deployed' as const, chartName: 'nginx', chartVersion: '1.1.0', uid: 'u2', resourceVersion: '2' },
    { name: 'api', namespace: 'default', revision: 1, status: 'failed' as const, chartName: 'app', chartVersion: '0.1.0', uid: 'u3', resourceVersion: '3' },
  ];
  const grouped = groupHelmReleases(revisions);
  assert.deepEqual(grouped.releases.map(release => release.name), ['api', 'web']);
  assert.equal(grouped.releases[1]?.currentRevision, 2);
  assert.equal(grouped.releases[1]?.currentStatus, 'deployed');
  assert.deepEqual(grouped.releases[1]?.revisions.map(revision => revision.revision), [2, 1]);
  assert.equal(grouped.truncated, false);
  const many = Array.from({ length: 20 }, (_, index) => ({ name: 'web', namespace: 'default', revision: index + 1, status: 'deployed' as const, chartName: 'nginx', chartVersion: '1.0.0', uid: `u${index}`, resourceVersion: String(index) }));
  const capped = groupHelmReleases(many);
  assert.equal(capped.releases[0]?.revisions.length, 16);
  assert.equal(capped.truncated, true);
  assert.equal(capped.releases[0]?.revisions[0]?.revision, 20);
  assert.equal(helmReleaseEntrySchema.safeParse(capped.releases[0]).success, true);
});
test('the response is metadata-only: no release payload, manifest or credentials', () => {
  const releases = groupHelmReleases([{ name: 'web', namespace: 'default', revision: 1, status: 'deployed', chartName: 'nginx', chartVersion: '1.0.0', uid: 'u', resourceVersion: '1' }]).releases;
  const response = { protocol: 2, kind: 'releases', target, namespace: 'default', releases, truncated: false };
  assert.equal(helmReleaseResponseSchema.safeParse(response).success, true);
  const many = Array.from({ length: 101 }, () => releases[0]);
  for (const bad of [{ ...response, manifest: 'x' }, { ...response, releases: many }]) assert.equal(helmReleaseResponseSchema.safeParse(bad).success, false);
});

// ---- Approved D-01 write half: install/rollback/uninstall G4 protocol values ----
import { helmWriteParametersSchema, helmWriteRequestSchema, helmWriteOutcomeSchema } from '../../src/shared/helm-release-protocol.ts';
const writeGrant = { id: '00000000-0000-4000-8000-000000000009', capability: 'a'.repeat(64), serviceGeneration: '00000000-0000-4000-8000-000000000002', expiresAt: 120_001 };
const writeTarget = { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'default' };
const install = { action: 'install' as const, namespace: 'default', release: 'web', chart: 'ingress-nginx/ingress-nginx' };
const rollback = { action: 'rollback' as const, namespace: 'default', release: 'web', revision: 3, provenanceUid: 'secret-uid', provenanceResourceVersion: '77' };
test('write parameters pin exact actions with provenance on rollback/uninstall only', () => {
  assert.equal(helmWriteParametersSchema.safeParse(install).success, true);
  assert.equal(helmWriteParametersSchema.safeParse({ ...install, chartVersion: '4.11.0', values: 'replicaCount: 2\n' }).success, true);
  assert.equal(helmWriteParametersSchema.safeParse(rollback).success, true);
  assert.equal(helmWriteParametersSchema.safeParse({ action: 'uninstall', namespace: 'default', release: 'web', provenanceUid: 'secret-uid', provenanceResourceVersion: '77' }).success, true);
  for (const bad of [
    { action: 'rollback', namespace: 'default', release: 'web', revision: 0, provenanceUid: 'u', provenanceResourceVersion: '1' }, // revision >= 1
    { action: 'rollback', namespace: 'default', release: 'web', revision: 2 }, // no provenance
    { action: 'install', namespace: 'default', release: 'web', chart: '' },
    { action: 'install', namespace: 'default', release: 'web', chart: 'a b' }, // spaces never reach argv
    { action: 'delete', namespace: 'default', release: 'web' },
  ]) assert.equal(helmWriteParametersSchema.safeParse(bad).success, false, JSON.stringify(bad));
});
test('the write gate keeps the fixed confirmation and metadata-only outcomes', () => {
  const base = { id: '00000000-0000-4000-8000-000000000010', owner: writeGrant.id, step: 'helm-cluster-write', dependencies: [] as const, target: writeTarget, parameters: rollback, createdAt: 1, updatedAt: 1 };
  assert.equal(helmWriteOutcomeSchema.safeParse({ ...base, phase: 'prepared' }).success, true);
  assert.equal(helmWriteOutcomeSchema.safeParse({ ...base, phase: 'accepted', stdoutTail: 'rolled back' }).success, true);
  assert.equal(helmWriteOutcomeSchema.safeParse({ ...base, phase: 'accepted', code: 'CONFLICT' }).success, false);
  assert.equal(helmWriteRequestSchema.safeParse({ protocol: 2, kind: 'submit', grant: writeGrant, id: '00000000-0000-4000-8000-000000000011', proof: 'b'.repeat(64), confirmation: 'helm-cluster-write-exact-release' }).success, true);
  assert.equal(helmWriteRequestSchema.safeParse({ protocol: 2, kind: 'prepare', grant: writeGrant, parameters: install }).success, true);
});
