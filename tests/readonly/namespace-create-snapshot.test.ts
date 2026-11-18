// Only synthetic public DTOs, independent read-only parsing and YAML AST facts.
// Never import/call a write planner/client/controller/adapter/confirmation/hook, including no-op paths.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { namespaceOutcomeSchema } from '../../src/shared/namespace-protocol.ts';
import { mergeConfigSources, publicConfigSnapshot } from '../../src/service/queries/kubeconfig.ts';
const generation = '00000000-0000-4000-8000-000000000001';
const value = () => ({ id: generation, serviceGeneration: generation, configuration: { serviceGeneration: generation, projectId: 'synthetic-view', configIdentity: 'synthetic-identity' },
  context: 'missing-current', contextAction: 'create', step: 'set-namespace', dependencies: [], path: '/synthetic/first', contextOrigin: '/synthetic/first', version: 'v-first', previous: 'default', namespace: 'next',
  sources: [{ path: '/synthetic/missing', status: 'missing', version: null, currentContext: '', definesContext: false },
    { path: '/synthetic/first', status: 'present', version: 'v-first', currentContext: '', definesContext: false },
    { path: '/synthetic/later', status: 'present', version: 'v-later', currentContext: 'missing-current', definesContext: false }],
  createdAt: 1, updatedAt: 2, phase: 'prepared', cleanup: 'none' });

test('missing-current namespace confirmation DTO explicitly identifies create in the first existing source, independent of current scalar location', () => {
  const parsed = namespaceOutcomeSchema.parse(value()); assert.equal(parsed.contextAction, 'create'); assert.equal(parsed.path, '/synthetic/first'); assert.equal(parsed.sources[2]?.currentContext, parsed.context);
});
test('create DTO rejects a missing or later destination and any existing definition/shadow', () => {
  const original = value();
  for (const fields of [{ path: '/synthetic/missing', contextOrigin: '/synthetic/missing' }, { path: '/synthetic/later', contextOrigin: '/synthetic/later', version: 'v-later' },
    { sources: original.sources.map((source, index) => index === 2 ? { ...source, definesContext: true } : source) }]) assert.equal(namespaceOutcomeSchema.safeParse({ ...original, ...fields }).success, false);
});
test('create namespace default is valid but cannot be reported unchanged; an old DTO cannot silently omit the action', () => {
  assert.equal(namespaceOutcomeSchema.safeParse({ ...value(), namespace: 'default' }).success, true);
  for (const fields of [{ previous: 'old' }, { result: 'unchanged' }, { contextAction: undefined }, { contextAction: 'update' }]) assert.equal(namespaceOutcomeSchema.safeParse({ ...value(), ...fields }).success, false);
});
test('creation metadata remains strict, source-version/configuration bound and rejects all-body/credential extensions', () => {
  const original = value();
  for (const fields of [{ version: 'stale' }, { context: 'different' }, { configuration: { ...original.configuration, serviceGeneration: 'different' } },
    { content: 'SYNTHETIC_SECRET' }, { token: 'SYNTHETIC_SECRET' }, { sources: original.sources.map(source => ({ ...source, content: 'SYNTHETIC_SECRET' })) }]) assert.equal(namespaceOutcomeSchema.safeParse({ ...original, ...fields }).success, false);
});
test('independent read snapshot distinguishes nonempty dangling current from unset current without fabricating an available row', () => {
  for (const current of ['missing-current', '']) {
    const merged = mergeConfigSources([{ sourcePath: '/synthetic/first', content: '{}' }, { sourcePath: '/synthetic/later', content: JSON.stringify({ 'current-context': current }) }]);
    const snapshot = publicConfigSnapshot(merged, 'synthetic-identity'); assert.equal(snapshot.currentContext, current); assert.equal(snapshot.currentContextMissing, !!current); assert.deepEqual(snapshot.contexts, []);
  }
});
test('reading an existing namespace-only stanza preserves it as unavailable rather than inferring a cluster/user', () => {
  const merged = mergeConfigSources([{ sourcePath: '/synthetic/file', content: JSON.stringify({ 'current-context': 'current', contexts: [{ name: 'current', context: { namespace: 'default' } }] }) }]);
  const row = publicConfigSnapshot(merged, 'synthetic-identity').contexts[0]; assert.equal(row?.active, true); assert.equal(row?.available, false); assert.equal(row?.clusterName, ''); assert.equal(row?.namespace, 'default');
});
test('fixed YAML parser exposes exclusive value-end boundaries at flow brackets for pure inspection only', () => {
  for (const source of ['{}', '{"contexts": []}', 'contexts: [{name: existing, context: {}}]\n']) {
    const doc = parseDocument(source, { intAsBigInt: true }); assert.equal(doc.errors.length, 0); assert.ok(isMap(doc.contents));
    const contexts = doc.contents.get('contexts', true), node = isSeq(contexts) ? contexts : doc.contents;
    assert.ok(node.range); assert.equal(source[node.range[1] - 1], isSeq(node) ? ']' : '}');
  }
});
test('fixed YAML parser distinguishes explicit/implicit null collections and comments-only documents without running any source editor', () => {
  for (const source of ['contexts: null\n', 'contexts:\n', 'contexts: ~ # comment\n']) {
    const doc = parseDocument(source); assert.ok(isMap(doc.contents)); const node = doc.contents.get('contexts', true); assert.ok(isScalar(node)); assert.equal(node.value, null); assert.ok(node.range);
  }
  const empty = parseDocument('# synthetic comment only\n'); assert.equal(empty.contents, null);
});
