// Source text only. Never import/run namespaceDocument or any write/no-op/confirmation/client/adapter.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (text: string, ...parts: string[]) => { let offset = -1; for (const part of parts) { const at = text.indexOf(part, offset + 1); assert.ok(at > offset, part); offset = at; } };
test('flow namespace insertion only targets the selected existing context map after original identity/previous validation and alias inspection', async () => {
  const code = await file('src/service/operations/namespace-document.ts');
  ordered(code, 'config.contexts?.find(value => value.name === contextName)', "(context.context.namespace || 'default') !== previous", 'inspect(doc.contents, 0)', 'entry.get(\'context\')', 'if (namespace === previous) return source', 'else if (mapping.flow)');
});
test('missing namespace in an empty flow map inserts one quoted namespace property without requiring a preexisting first key', async () => {
  const code = await file('src/service/operations/namespace-document.ts'), branch = code.slice(code.indexOf('else if (mapping.flow)'), code.indexOf('const key = mapping.items[0]'));
  ordered(branch, 'mapping.range[1] - 1', "source[end] !== '}'", "let separator = ''", 'if (mapping.items.length)', 'JSON.stringify(namespace)', 'source.slice(end)');
  assert.ok(!branch.includes('items[0]') && !branch.includes('JSON.stringify(context'));
});
test('nonempty flow maps preserve comments and an existing trailing comma while rejecting ambiguous tail syntax', async () => {
  const code = await file('src/service/operations/namespace-document.ts');
  ordered(code, 'const last = mapping.items.at(-1)?.value', '!isNode(last) || !last.range', 'source.slice(last.range[1], end)', "tail !== '' && tail !== ','", "separator = tail === ',' ? '' : ','");
  assert.ok(code.includes('.replace(/#[^\\r\\n]*/g, \'\').trim()'));
});
test('namespace scalars are replaced by source range first, block insertion remains guarded, and no document is reserialized', async () => {
  const code = await file('src/service/operations/namespace-document.ts');
  ordered(code, "if (mapping.has('namespace'))", 'source.slice(0, value.range[0])', 'else if (mapping.flow)', 'const key = mapping.items[0]?.key', '!mapping.range || !isScalar(key)', 'const start = key.range[0]');
  assert.ok(!/toJS\(|toString\(|stringify\(doc|writeFile|spawn\(|console\./.test(code));
});
test('post-edit checks preserve context count, original current scalar and cluster/user references in addition to target namespace', async () => {
  const code = await file('src/service/operations/namespace-document.ts');
  for (const part of ["after['current-context'] !== config['current-context']", 'changed?.context.namespace !== namespace', 'after.contexts?.length !== config.contexts?.length', 'changed.context.cluster !== context.context.cluster', 'changed.context.user !== context.context.user']) assert.ok(code.includes(part));
});
test('flow edits still pass the same source-bound plan hash, stage hook, metadata/expiry gate and single rename', async () => {
  const adapter = await file('src/service/adapters/namespace-file.ts'); const commit = adapter.slice(adapter.indexOf('async commit('));
  ordered(commit, 'value.version !== plan.version', 'namespaceDocument(value.body', 'hash(next) !== plan.intended', 'beforeStage();', 'await staged.sync()', 'if (recheckSources) await recheckSources()', 'stage.ino !== owned.ino', 'beforeCommit(); attempted = true', 'await rename(');
  assert.equal(adapter.match(/await rename\(/g)?.length, 1);
});
test('flow support does not broaden null/alias/merge/tag/AST budgets or bypass destructive resource target authentication', async () => {
  const planner = await file('src/service/operations/namespace-document.ts'), deletion = await file('src/service/operations/namespace-delete.ts');
  for (const part of ['parseConfig(source)', 'isAlias(node)', 'node.tag || node.anchor', "pair.key.value === '<<'", 'nodes > 50_000', 'depth > 64']) assert.ok(planner.includes(part));
  assert.ok(deletion.includes('bindResourceTarget(') && deletion.includes('privateKubectlConfiguration(config.merged, target).fill(0)'));
});
test('new readonly parser facts cannot import an editor/writer or execute source surgery, and test scope remains explicitly allowlisted', async () => {
  const code = await file('tests/readonly/namespace-flow-snapshot.test.ts'), allowlist = await file('scripts/readonly-tests.ts');
  assert.ok(!/from ['"].*(?:operations\/|adapters\/|runtime\/|bridge|namespace-client)/.test(code) && !/namespaceDocument\(/.test(code));
  assert.ok(allowlist.includes("'tests/readonly/namespace-flow-snapshot.test.ts'"));
});
