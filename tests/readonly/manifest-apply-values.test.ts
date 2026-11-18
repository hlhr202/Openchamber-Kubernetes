// Independent synthetic GET proof and protocol values only. Never import/call any real or mock Apply/Save/Create control plane, patch writer, adapter or client.
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readManifestApplySnapshot } from '../../src/service/queries/manifest-apply-snapshot.ts';
import type { ResourceReadRequest, ResourceReadTransport } from '../../src/service/queries/resource-reader.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
import { manifestApplyRequestSchema, manifestApplyResponseSchema, sameApplyIntent, applyComparisonReference } from '../../src/shared/manifest-apply-protocol.ts';
import { manifestComparisonReferenceSchema, manifestComparisonPath } from '../../src/shared/manifest-diff-protocol.ts';
const target = { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'default' };
const reference = { type: { group: 'example.io', version: 'v1', resource: 'widgets', kind: 'Widget', scope: 'namespace' as const }, name: 'sample', namespace: 'default', uid: 'object-uid', resourceVersion: '5', definition: { name: 'widgets.example.io', uid: 'definition-uid', resourceVersion: '2' } };
const signal = () => new AbortController().signal;
function fixture() {
  let rv = '5', uid = 'object-uid', definitionRv = '2', served = true, verbs = ['get', 'patch'], ns = 'default', status = 200, malformed = false, changeDefinition = false, closes = 0, verified = 0, iteratedError = false;
  const requests: ResourceReadRequest[] = [];
  const read: ResourceReadTransport = async request => {
    requests.push(request); kubectlReadArguments(request, '/synthetic/configuration.pipe');
    const definition = request.path.includes('/customresourcedefinitions/'), discovery = request.purpose === 'api-version';
    const body = definition ? JSON.stringify({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: reference.definition.name, uid: reference.definition.uid, resourceVersion: changeDefinition && requests.length > 3 ? '3' : definitionRv }, spec: { group: 'example.io', scope: 'Namespaced', names: { plural: 'widgets', kind: 'Widget' }, versions: [{ name: 'v1', served, storage: true }] } })
      : discovery ? JSON.stringify({ groupVersion: 'example.io/v1', resources: [{ name: 'widgets', namespaced: true, kind: 'Widget', verbs }] })
      : malformed ? '{' : `{"apiVersion":"example.io/v1","kind":"Widget","metadata":{"name":"sample","namespace":"${ns}","uid":"${uid}","resourceVersion":"${rv}"},"spec":{"n":9007199254740993}}`;
    const code = definition || discovery ? 200 : status;
    return { status: code, body: { async *[Symbol.asyncIterator]() { if (code !== 200) { iteratedError = true; throw new Error('Never consume API error body'); } yield Buffer.from(body); } }, close: async () => { closes++; } };
  };
  return { read, requests, verify: async () => { verified++; }, verified: () => verified, closes: () => closes, iteratedError: () => iteratedError,
    rv(value: string) { rv = value; }, uid(value: string) { uid = value; }, definitionRv(value: string) { definitionRv = value; }, served(value: boolean) { served = value; }, verbs(value: string[]) { verbs = value; }, ns(value: string) { ns = value; }, status(value: number) { status = value; }, malformed() { malformed = true; }, drift() { changeDefinition = true; } };
}
describe('independent fresh CRD snapshot', { timeout: 10_000 }, () => {
test('uses exact CRD/discovery/instance/discovery/CRD GETs and retains original UID/RV without patching', async () => {
  const f = fixture(), value = await readManifestApplySnapshot(target, reference, signal(), f.read, f.verify, 'live');
  assert.equal(value.reference.uid, reference.uid); assert.ok(value.text.includes('9007199254740993'));
  assert.deepEqual(f.requests.map(request => request.purpose), ['resource-object', 'api-version', 'custom-document', 'api-version', 'resource-object']); assert.equal(f.closes(), 5); assert.equal(f.verified(), 2);
});
test('exact original resourceVersion is required, not same-UID refreshing a write intent', async () => {
  const f = fixture(); f.rv('6'); await assert.rejects(readManifestApplySnapshot(target, reference, signal(), f.read, f.verify, 'live'), /CONFLICT/);
});
test('same-name replacement is refused before accepting any body as the original instance', async () => {
  const f = fixture(); f.uid('replacement'); await assert.rejects(readManifestApplySnapshot(target, reference, signal(), f.read, f.verify, 'live'), /STALE_TARGET/);
});
test('changed/deleted CRD definition version or unserved original API cannot be silently rebound', async () => {
  const first = fixture(); first.definitionRv('3'); await assert.rejects(readManifestApplySnapshot(target, reference, signal(), first.read, first.verify, 'live'), /STALE_TARGET/); assert.equal(first.requests.length, 2);
  const second = fixture(); second.served(false); await assert.rejects(readManifestApplySnapshot(target, reference, signal(), second.read, second.verify, 'live'), /STALE_TARGET/);
});
test('get+patch discovery is required but is not treated as RBAC permission or strategic capability', async () => {
  const f = fixture(); f.verbs(['get']); await assert.rejects(readManifestApplySnapshot(target, reference, signal(), f.read, f.verify, 'live'), /RESOURCE_INVALID/); assert.equal(f.requests.some(request => request.purpose === 'custom-document'), false);
});
test('a CRD change after the exact instance read invalidates the entire snapshot', async () => {
  const f = fixture(); f.drift(); await assert.rejects(readManifestApplySnapshot(target, reference, signal(), f.read, f.verify, 'live'), /STALE_TARGET/); assert.equal(f.closes(), 5);
});
test('wrong namespace, malformed response or query errors are failures, never missing/Create or no-change success', async () => {
  const first = fixture(); first.ns('other'); await assert.rejects(readManifestApplySnapshot(target, reference, signal(), first.read, first.verify, 'live'), /STALE_TARGET/);
  const second = fixture(); second.malformed(); await assert.rejects(readManifestApplySnapshot(target, reference, signal(), second.read, second.verify, 'live'), /CONTENT_INVALID/);
  for (const status of [403, 404]) { const f = fixture(); f.status(status); await assert.rejects(readManifestApplySnapshot(target, reference, signal(), f.read, f.verify, 'live'), /FORBIDDEN|NOT_FOUND/); assert.equal(f.iteratedError(), false); }
});
test('builtin or malformed references and namespace switching are rejected without broadening the existing private GET admission', async () => {
  const f = fixture(); await assert.rejects(readManifestApplySnapshot(target, { ...reference, definition: undefined }, signal(), f.read, f.verify, 'live'), /INVALID_INPUT/); assert.equal(f.requests.length, 0);
  await assert.rejects(readManifestApplySnapshot({ ...target, namespace: 'other' }, reference, signal(), f.read, f.verify, 'live'), /STALE_TARGET/); assert.equal(f.requests.length, 0);
});
test('configuration proof failure at the initial or final gate cannot return a captured snapshot', async () => {
  for (const at of [1, 2]) { const f = fixture(); let count = 0; await assert.rejects(readManifestApplySnapshot(target, reference, signal(), f.read, async () => { if (++count === at) throw new BoundaryError('CONFIG_CHANGED'); }, 'live'), /CONFIG_CHANGED/); }
});
test('missing proof is a separate fresh five-GET snapshot requiring get+create and an exact 404', async () => {
  const f = fixture(); f.status(404); f.verbs(['get', 'create', 'patch']);
  const value = await readManifestApplySnapshot(target, reference, signal(), f.read, f.verify, 'missing');
  assert.equal(value.missing, true); assert.deepEqual(f.requests.map(request => request.purpose), ['resource-object', 'api-version', 'custom-document', 'api-version', 'resource-object']);
  assert.equal(f.closes(), 5); assert.equal(f.verified(), 2); assert.equal(f.iteratedError(), false);
});
test('a reappeared object is a conflict for the missing proof, never silently applied or recreated', async () => {
  const f = fixture(); f.verbs(['get', 'create']); await assert.rejects(readManifestApplySnapshot(target, reference, signal(), f.read, f.verify, 'missing'), /CONFLICT/);
});
test('missing proof requires the create verb before any instance GET and never implies RBAC or strategic support', async () => {
  const f = fixture(); f.status(404); await assert.rejects(readManifestApplySnapshot(target, reference, signal(), f.read, f.verify, 'missing'), /RESOURCE_INVALID/);
  assert.equal(f.requests.some(request => request.purpose === 'custom-document'), false);
});
test('live proof still surfaces fresh 404 so the control plane, not the reader, owns the explicit Create branch', async () => {
  const f = fixture(); f.status(404); f.verbs(['get', 'create', 'patch']); await assert.rejects(readManifestApplySnapshot(target, reference, signal(), f.read, f.verify, 'live'), /NOT_FOUND/);
});
test('definition drift or unserved API invalidates the missing snapshot too', async () => {
  const first = fixture(); first.status(404); first.verbs(['get', 'create']); first.drift(); await assert.rejects(readManifestApplySnapshot(target, reference, signal(), first.read, first.verify, 'missing'), /STALE_TARGET/);
  const second = fixture(); second.status(404); second.verbs(['get', 'create']); second.served(false); await assert.rejects(readManifestApplySnapshot(target, reference, signal(), second.read, second.verify, 'missing'), /STALE_TARGET/);
});
});
const grant = { id: '00000000-0000-4000-8000-000000000001', generation: '00000000-0000-4000-8000-000000000002', capability: 'a'.repeat(64), expiresAt: 60_001 };
const outcome = { id: grant.id, generation: grant.generation, requestId: '00000000-0000-4000-8000-000000000003', target, reference, source: { revision: 1, identity: 'b'.repeat(64), format: 'yaml' as const }, bytes: 100, received: 0, phase: 'uploading' as const, createdAt: 1, updatedAt: 1, expiresAt: grant.expiresAt };
test('Apply protocol uses independent grants/confirmation and cannot accept a Diff cursor or Create confirmation', () => {
  assert.equal(manifestApplyRequestSchema.safeParse({ protocol: 2, kind: 'submit', grant, patchDigest: 'c'.repeat(64), confirmation: 'apply-exact-crd-version' }).success, true);
  for (const extra of [{ confirmation: 'create-exact-documents' }, { cursor: 'diff' }, { argv: ['patch'] }, { body: 'unconfirmed' }]) assert.equal(manifestApplyRequestSchema.safeParse({ protocol: 2, kind: 'submit', grant, patchDigest: 'c'.repeat(64), confirmation: 'apply-exact-crd-version', ...extra }).success, false);
});
test('begin protocol carries metadata only and requires a versioned actual CRD reference', () => {
  const value = { protocol: 2, kind: 'begin', requestId: outcome.requestId, target, selection: { mode: 'default' }, reference, source: outcome.source, bytes: 100 };
  assert.equal(manifestApplyRequestSchema.safeParse(value).success, true);
  for (const extra of [{ text: 'anything' }, { file: '/real' }, { reference: { ...reference, uid: '' } }, { reference: { ...reference, definition: undefined } }]) assert.equal(manifestApplyRequestSchema.safeParse({ ...value, ...extra }).success, false);
});
test('response metadata never accepts patch/body text, and immutable intent comparisons include the original reference and revision', () => {
  const parsed = manifestApplyResponseSchema.parse({ protocol: 2, kind: 'upload', grant, outcome }); if (parsed.kind !== 'upload') throw new Error('Wrong branch');
  assert.equal(sameApplyIntent(parsed.outcome, { ...parsed.outcome, phase: 'prepared', updatedAt: 2 }), true);
  for (const value of [{ ...parsed.outcome, source: { ...parsed.outcome.source, revision: 2 } }, { ...parsed.outcome, reference: { ...reference, resourceVersion: '6' } }]) assert.equal(sameApplyIntent(parsed.outcome, value), false);
  assert.equal(manifestApplyResponseSchema.safeParse({ protocol: 2, kind: 'outcome', outcome: { ...outcome, body: 'SECRET' } }).success, false);
});
test('full versioned intent reference projects to strict routing without leaking UID/RV/definition into comparison/path DTOs', () => {
  assert.equal(manifestComparisonReferenceSchema.safeParse(reference).success, false);
  const projected = applyComparisonReference(reference); assert.equal(manifestComparisonReferenceSchema.safeParse(projected).success, true);
  assert.deepEqual(Object.keys(projected).sort(), ['name', 'namespace', 'type']); assert.equal(manifestComparisonPath(projected), '/apis/example.io/v1/namespaces/default/widgets/sample');
  assert.equal(reference.uid, 'object-uid'); assert.equal(reference.definition.resourceVersion, '2');
});
test('prepared/succeeded outcome DTOs require complete frozen patch metadata (incl. missing flag) and a real version result', () => {
  const response = (value: unknown) => manifestApplyResponseSchema.safeParse({ protocol: 2, kind: 'outcome', outcome: value }).success;
  assert.equal(response({ ...outcome, phase: 'prepared', received: 100 }), false);
  const prepared = { ...outcome, phase: 'prepared', received: 100, patchDigest: 'c'.repeat(64), patchBytes: 50, baseline: 'absent', unchanged: false, missing: false };
  assert.equal(response(prepared), true); assert.equal(response({ ...prepared, phase: 'succeeded' }), false);
  assert.equal(response({ ...prepared, phase: 'succeeded', resourceVersionAfter: '6' }), true);
  assert.equal(response({ ...prepared, phase: 'succeeded', unchanged: true, resourceVersionAfter: '6' }), false);
  assert.equal(response({ ...outcome, received: 101 }), false);
});
test('missing Create branch carries its own explicit confirmation literal and a distinct new-UID success', () => {
  const response = (value: unknown) => manifestApplyResponseSchema.safeParse({ protocol: 2, kind: 'outcome', outcome: value }).success;
  assert.equal(manifestApplyRequestSchema.safeParse({ protocol: 2, kind: 'submit', grant, patchDigest: 'c'.repeat(64), confirmation: 'create-missing-crd-object' }).success, true);
  const prepared = { ...outcome, phase: 'prepared', received: 100, patchDigest: 'c'.repeat(64), patchBytes: 60, baseline: 'absent', unchanged: false, missing: true };
  assert.equal(response(prepared), true); assert.equal(response({ ...prepared, missing: undefined }), false);
  assert.equal(response({ ...prepared, phase: 'succeeded', resourceVersionAfter: '7' }), false); // Create success must record the new UID.
  assert.equal(response({ ...prepared, phase: 'succeeded', resourceVersionAfter: '7', uidAfter: reference.uid }), false); // Same-name replacement never counts.
  assert.equal(response({ ...prepared, phase: 'succeeded', resourceVersionAfter: '7', uidAfter: 'new-object-uid' }), true);
  assert.equal(response({ ...prepared, phase: 'succeeded', resourceVersionAfter: '7', uidAfter: 'new-object-uid', unchanged: true }), false);
});
