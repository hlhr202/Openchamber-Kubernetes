// Pure protocol/projection/document-splitter values only. Never import/call the adapter, operation, client or route.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFileRequestSchema, applyFileResponseSchema, fileAction, verbParticiple, verbPast, fileActionArguments, notAFilePathMessage, failureMessage, successMessage } from '../../src/shared/apply-file-protocol.ts';
test('the request takes a canonical file location and one of the three actions', () => {
  assert.equal(applyFileRequestSchema.safeParse({ protocol: 2, kind: 'run', root: '/w/manifests', path: 'deploy.yaml', action: 'apply' }).success, true);
  assert.equal(applyFileRequestSchema.safeParse({ protocol: 2, kind: 'run', root: '/w/manifests', path: 'sub/svc.yaml', action: 'delete' }).success, true);
  const cases: unknown[] = [
    { protocol: 2, kind: 'run', root: 'relative', path: 'f.yaml', action: 'apply' },
    { protocol: 2, kind: 'run', root: '/w', path: '', action: 'apply' },
    { protocol: 2, kind: 'run', root: '/w', path: '../escape.yaml', action: 'apply' },
    { protocol: 2, kind: 'run', root: '/w', path: 'f.yaml', action: 'patch' },
    { protocol: 2, kind: 'read', root: '/w', path: 'f.yaml', action: 'apply' },
    { protocol: 2, kind: 'run', root: '/w', path: 'f.yaml', action: 'apply', extra: 1 },
  ];
  for (const bad of cases) assert.equal(applyFileRequestSchema.safeParse(bad).success === false, true, JSON.stringify(bad));
  assert.equal(fileAction.safeParse('create').success, true);
});
test('the verb triplets are upstream verbatim for all three actions', () => {
  assert.equal(verbParticiple('apply'), 'applying'); assert.equal(verbPast('apply'), 'applied');
  assert.equal(verbParticiple('create'), 'creating'); assert.equal(verbPast('create'), 'created');
  assert.equal(verbParticiple('delete'), 'deleting'); assert.equal(verbPast('delete'), 'deleted');
});
test('the invocation keeps the upstream `-f <relative path>` shape', () => {
  assert.deepEqual(fileActionArguments('apply', 'deploy.yaml'), ['apply', '-f', 'deploy.yaml']);
  assert.deepEqual(fileActionArguments('delete', 'sub/svc.yaml'), ['delete', '-f', 'sub/svc.yaml']);
});
test('the message shapes are upstream verbatim and the response is bounded', () => {
  assert.equal(notAFilePathMessage('untitled:Untitled-1'), 'untitled:Untitled-1 is not a file path.');
  assert.equal(failureMessage('create'), 'Error creating resource');
  assert.equal(successMessage('apply', 'deploy.yaml'), 'Resource deploy.yaml applied.');
  assert.equal(applyFileResponseSchema.safeParse({ protocol: 2, kind: 'file-action-completed', action: 'apply', path: 'deploy.yaml' }).success, true);
  assert.equal(applyFileResponseSchema.safeParse({ protocol: 2, kind: 'file-action-completed', action: 'patch', path: 'f' }).success, false);
  assert.equal(applyFileResponseSchema.safeParse({ protocol: 2, kind: 'file-action-completed', action: 'delete', path: 'f', stdout: 'leak' }).success, false);
  assert.equal(applyFileResponseSchema.safeParse({ protocol: 2, kind: 'file-action-unavailable', code: 'STATE_UNAVAILABLE' }).success, true);
  assert.equal(applyFileResponseSchema.safeParse({ protocol: 2, kind: 'file-action-unavailable', code: 'NOPE' }).success, false);
});

// ---- Approved D-02 G4 chain values ----
import { applyFileGateRequestSchema, applyFileGateResponseSchema, applyFilePlanSchema, applyFileOutcomeSchema, applyFileParametersSchema, applyFileDocuments } from '../../src/shared/apply-file-protocol.ts';
import { readApplyFileDocuments, applyFileMaxDocuments } from '../../src/parsing/apply-file-documents.ts';
const grant = { id: '00000000-0000-4000-8000-000000000001', capability: 'a'.repeat(64), serviceGeneration: '00000000-0000-4000-8000-000000000002', expiresAt: 120_001 };
const target = { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'default' };
const plan = (over: Record<string, unknown> = {}) => ({ index: 0, locator: { group: 'apps', version: 'v1', kind: 'Deployment', name: 'web' }, action: 'apply-merge', digest: 'c'.repeat(64), liveVersion: 'd'.repeat(64), ...over });
const file = { root: '/w', path: 'deploy.yaml', version: 'e'.repeat(64), identity: 'f'.repeat(64), format: 'yaml' as const };
test('the G4 request union keeps the fixed grant/confirmation shapes and never carries argv or body text', () => {
  assert.equal(applyFileGateRequestSchema.safeParse({ protocol: 2, kind: 'open', selection: { mode: 'default' }, target }).success, true);
  assert.equal(applyFileGateRequestSchema.safeParse({ protocol: 2, kind: 'prepare', grant, file, sourceDigest: 'a'.repeat(64), fileProof: 'wsp1.abcDEF_-xyz' }).success, true);
  assert.equal(applyFileGateRequestSchema.safeParse({ protocol: 2, kind: 'submit', grant, id: '00000000-0000-4000-8000-000000000003', proof: 'b'.repeat(64), confirmation: 'apply-file-exact-documents' }).success, true);
  for (const bad of [
    { protocol: 2, kind: 'submit', grant, id: '00000000-0000-4000-8000-000000000003', proof: 'b'.repeat(64), confirmation: 'other' },
    { protocol: 2, kind: 'prepare', grant, file, sourceDigest: 'a'.repeat(64) }, // fileProof required
    { protocol: 2, kind: 'open', selection: { mode: 'default' }, target, text: 'apiVersion: v1' },
  ]) assert.equal(applyFileGateRequestSchema.safeParse(bad).success, false, JSON.stringify(bad));
});
test('plan documents pin index order, action and live-proof consistency', () => {
  assert.equal(applyFilePlanSchema.safeParse(plan()).success, true);
  assert.equal(applyFilePlanSchema.safeParse(plan({ action: 'create', liveVersion: null })).success, true);
  assert.equal(applyFilePlanSchema.safeParse(plan({ action: 'create' })).success, false); // create cannot claim a live version
  assert.equal(applyFilePlanSchema.safeParse(plan({ action: 'apply-merge', liveVersion: null })).success, false);
  assert.equal(applyFilePlanSchema.safeParse(plan({ index: 16 })).success, false); // > 15
  assert.equal(applyFileDocuments, 16);
  assert.equal(applyFileParametersSchema.safeParse({ file, sourceDigest: 'a'.repeat(64), documents: [plan(), plan({ index: 1, locator: { group: '', version: 'v1', kind: 'ConfigMap', name: 'cm' } })] }).success, true);
  assert.equal(applyFileParametersSchema.safeParse({ file, sourceDigest: 'a'.repeat(64), documents: [plan(), plan()] }).success, false); // duplicate index 0
});
test('outcomes stay metadata-only; accepted requires every document accepted and never a code', () => {
  const outcome = { id: '00000000-0000-4000-8000-000000000004', owner: grant.id, step: 'apply-file', dependencies: [] as const, target, parameters: { file, sourceDigest: 'a'.repeat(64), documents: [plan()] }, createdAt: 1, updatedAt: 1 };
  const results = [{ index: 0, action: 'apply-merge', outcome: 'accepted', resourceVersion: '9' }];
  assert.equal(applyFileOutcomeSchema.safeParse({ ...outcome, phase: 'prepared' }).success, true);
  assert.equal(applyFileOutcomeSchema.safeParse({ ...outcome, phase: 'accepted', results: [{ index: 0, action: 'apply-merge', outcome: 'failed', code: 'CONFLICT' }] }).success, false);
  assert.equal(applyFileOutcomeSchema.safeParse({ ...outcome, phase: 'accepted', results, code: 'CONFLICT' }).success, false);
  assert.equal(applyFileOutcomeSchema.safeParse({ ...outcome, phase: 'failed', code: 'CONFLICT', results: [{ index: 0, action: 'apply-merge', outcome: 'failed', code: 'CONFLICT' }] }).success, true);
  assert.equal(applyFileOutcomeSchema.safeParse({ ...outcome, phase: 'prepared', results }).success, false); // results only after dispatch
  assert.equal(applyFileOutcomeSchema.safeParse({ ...outcome, phase: 'accepted', results, body: '{}' }).success, false);
});
test('the streaming splitter turns files into bounded digest-pinned documents', () => {
  const single = readApplyFileDocuments('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n  namespace: default\ndata:\n  k: v\n', 'yaml');
  assert.equal(single.length, 1);
  assert.equal(single[0]?.locator.kind, 'ConfigMap');
  assert.equal(single[0]?.locator.name, 'cm');
  assert.equal(single[0]?.locator.namespace, 'default');
  const multi = readApplyFileDocuments('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: b\n', 'yaml');
  assert.equal(multi.length, 2);
  assert.equal(multi[1]?.locator.name, 'b');
  for (const bad of [
    '', 'just text\n', // no documents / no identity
    'apiVersion: v1\nkind: ConfigMap\n', // no name
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\nkind: Pod\n', // duplicate keys rejected by strict composer
  ]) assert.throws(() => readApplyFileDocuments(bad, 'yaml'), /CONTENT_INVALID|BUDGET_EXCEEDED/);
  const listy = readApplyFileDocuments(JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'a' } }, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'b' } }] }), 'json');
  assert.equal(listy.length, 2); // typed List expands
  assert.equal(listy[1]?.locator.name, 'b');
  assert.throws(() => readApplyFileDocuments(JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [{ apiVersion: 'v1', kind: 'List', items: [] }] }), 'json'), /CONTENT_INVALID/); // nested List never expands
  assert.throws(() => readApplyFileDocuments('apiVersion: v1\nkind: List\nitems: []\n', 'yaml'), /CONTENT_INVALID/); // YAML List wrapper is a fixed rejection
  assert.equal(applyFileMaxDocuments, 16);
  const seventeen = Array.from({ length: 17 }, (_, index) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: n${index}\n`).join('---\n');
  assert.throws(() => readApplyFileDocuments(seventeen, 'yaml'), /BUDGET_EXCEEDED/);
});
test('the gate response union is bounded and closes cleanly', () => {
  assert.equal(applyFileGateResponseSchema.safeParse({ protocol: 2, kind: 'view', grant }).success, true);
  assert.equal(applyFileGateResponseSchema.safeParse({ protocol: 2, kind: 'closed' }).success, true);
  assert.equal(applyFileGateResponseSchema.safeParse({ protocol: 2, kind: 'view', grant, extra: 1 }).success, false);
});
