// Independent read-only parser/projection and AST boundary facts only. No source editor/planner/client/writer/bridge invocation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isMap, isNode, isSeq, parseDocument } from 'yaml';
import { mergeConfigSources, publicConfigSnapshot } from '../../src/service/queries/kubeconfig.ts';

const samples = [
  '{"current-context":"current","contexts":[{"name":"current","context":{}}]}',
  'current-context: current\ncontexts:\n- name: current\n  context: {cluster: missing, user: missing-user}\n',
  'current-context: current\ncontexts: [{name: current, context: {cluster: missing,}}]\n',
  'current-context: current\ncontexts: [{name: current, context: {cluster: missing, # synthetic trailing comment\n  }}]\n',
];
test('independent parsing retains existing empty/flow namespace-default stanzas and never fabricates connectivity', () => {
  for (const content of samples) {
    const merged = mergeConfigSources([{ sourcePath: '/synthetic/file', content }]), snapshot = publicConfigSnapshot(merged, 'synthetic-identity');
    assert.equal(snapshot.contexts.length, 1); assert.equal(snapshot.contexts[0]?.namespace, 'default'); assert.equal(snapshot.contexts[0]?.available, false); assert.equal(snapshot.currentContextMissing, false);
  }
});
test('locked YAML parser flow mapping value-end identifies the closing brace independently of root/sequence formatting', () => {
  for (const source of samples) {
    const doc = parseDocument(source, { intAsBigInt: true }); assert.equal(doc.errors.length, 0); assert.equal(doc.warnings.length, 0); assert.ok(isMap(doc.contents)); const contexts = doc.contents.get('contexts'); assert.ok(isSeq(contexts)); const entry = contexts.items[0]; assert.ok(isMap(entry)); const mapping = entry.get('context'); assert.ok(isMap(mapping));
    assert.equal(mapping.flow, true); assert.ok(mapping.range); assert.equal(source[mapping.range[1] - 1], '}');
    if (mapping.items.length) { const last = mapping.items.at(-1)?.value; assert.ok(isNode(last) && last.range); assert.ok(last.range[1] < mapping.range[1]); }
  }
});
test('read-only namespace projection distinguishes explicit empty strings from invalid null instead of coercing arbitrary YAML', () => {
  const empty = mergeConfigSources([{ sourcePath: '/synthetic/file', content: '{"current-context":"current","contexts":[{"name":"current","context":{"namespace":""}}]}' }]);
  assert.equal(publicConfigSnapshot(empty, 'synthetic-identity').contexts[0]?.namespace, 'default');
  for (const value of [null, 42, true]) assert.throws(() => mergeConfigSources([{ sourcePath: '/synthetic/file', content: JSON.stringify({ contexts: [{ name: 'current', context: { namespace: value } }] }) }]), /CONFIG_INVALID/);
});
test('existing named stanza in a later source retains that origin, its empty mapping and unexecuted authentication disclosure', () => {
  const merged = mergeConfigSources([{ sourcePath: '/synthetic/first', content: '{"current-context":"current"}' }, { sourcePath: '/synthetic/origin', content: '{"contexts":[{"name":"current","context":{}}]}' }]);
  assert.equal(merged.contexts.get('current')?.sourcePath, '/synthetic/origin'); assert.deepEqual(merged.contexts.get('current')?.value, {});
  assert.equal(publicConfigSnapshot(merged, 'synthetic-identity').contexts[0]?.authentication.evaluated, false);
});
