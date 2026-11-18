// Synthetic strings and injected config reads only. Never reads process.env/cwd/HOME/files, imports runtime/bridge, or calls a write adapter/planner/client.
import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverDefaultConfig, defaultConfigPaths } from '../../src/service/queries/config-discovery.ts';
import { createConfigReader, resolveConfigSelection } from '../../src/service/queries/config-source.ts';
import { configSourcesSchema } from '../../src/shared/configuration.ts';
import { projectConfigPage } from '../../src/service/queries/config-page.ts';

const base = { home: '/synthetic/home', cwd: '/synthetic/package' };
const contents = (name: string) => JSON.stringify({ 'current-context': name, contexts: [{ name, context: { cluster: 'missing' } }] });

test('absent or empty injected KUBECONFIG uses only HOME config; discovery performs no IO or ambient environment lookup', () => {
  for (const input of [base, { ...base, kubeconfig: '' }]) assert.deepEqual(discoverDefaultConfig(input), { basis: 'home', paths: ['/synthetic/home/.kube/config'] });
  const result = discoverDefaultConfig(base); assert.ok(Object.isFrozen(result) && Object.isFrozen(result.paths));
});
test('POSIX environment list preserves first precedence, ignores empty entries and deduplicates normalized paths without trimming names', () => {
  assert.deepEqual(discoverDefaultConfig({ ...base, kubeconfig: ':/synthetic/b::/synthetic/dir/../b:/synthetic/a: /literal name :/synthetic/b:' }),
    { basis: 'service-kubeconfig', paths: ['/synthetic/b', '/synthetic/a', '/synthetic/package/ /literal name '] });
});
test('nonempty separator-only environment is an intentional empty precedence, not implicit HOME or cwd fallback', () => {
  assert.deepEqual(discoverDefaultConfig({ ...base, kubeconfig: ':::' }), { basis: 'service-kubeconfig', paths: [] });
  assert.deepEqual(resolveConfigSelection({ mode: 'default' }, []).orderedPaths, []);
});
test('relative injected environment paths use explicit service cwd, never selected project or shell expansion', () => {
  assert.deepEqual(discoverDefaultConfig({ ...base, kubeconfig: './first:../other:~/.kube/config:$HOME/config:"quoted":one;two' }).paths,
    ['/synthetic/package/first', '/synthetic/other', '/synthetic/package/~/.kube/config', '/synthetic/package/$HOME/config', '/synthetic/package/"quoted"', '/synthetic/package/one;two']);
});
test('invalid or over-budget defaults fail with fixed errors instead of silently using another file', () => {
  for (const input of [{ ...base, home: 'relative' }, { ...base, cwd: 'relative' }, { ...base, kubeconfig: '/bad\npath' }, { ...base, kubeconfig: '//double' }, { ...base, kubeconfig: 'a\\b' },
    { ...base, kubeconfig: 'a'.repeat(24_001) }, { ...base, kubeconfig: Array.from({ length: 65 }, (_, n) => `/synthetic/${n}`).join(':') }, { ...base, kubeconfig: `/${'x'.repeat(4096)}` }]) assert.throws(() => discoverDefaultConfig(input));
  assert.throws(() => defaultConfigPaths(Array.from({ length: 64 }, () => `/${'中'.repeat(200)}`)), /BUDGET_EXCEEDED/);
});
test('one immutable default precedence serves read requests while explicit single/merge overrides remain independent', async () => {
  const paths = ['/synthetic/a', '/synthetic/b'], calls: string[] = [];
  const reader = createConfigReader(paths, async path => { calls.push(path); return { sourcePath: path, content: contents(path) }; });
  paths.reverse(); // External caller mutation must not retarget this service reader.
  const result = await reader.read({ mode: 'default' }); assert.equal(result.snapshot.currentContext, '/synthetic/a'); assert.equal(result.sources.selectedCount, 2);
  await reader.read({ mode: 'file', path: '/synthetic/explicit' }); await reader.read({ mode: 'merge', paths: ['/synthetic/b'] });
  assert.deepEqual(calls, ['/synthetic/a', '/synthetic/b', '/synthetic/explicit', '/synthetic/b']);
});
test('default merge reports missing paths and does not append HOME after all supplied files are missing', async () => {
  const calls: string[] = [], defaults = discoverDefaultConfig({ ...base, kubeconfig: '/synthetic/a:/synthetic/b' });
  const reader = createConfigReader(defaults.paths, async path => { calls.push(path); return path === '/synthetic/b' ? { sourcePath: path, content: contents('b') } : null; });
  assert.deepEqual((await reader.read({ mode: 'default' })).sources, { mode: 'default', selectedCount: 2, loadedCount: 1, missingCount: 1 });
  assert.deepEqual(calls, ['/synthetic/a', '/synthetic/b']);
});
test('zero default paths produce a missing public page with zero counts and no file reads, and explicit empty merge stays invalid', async () => {
  let calls = 0; const reader = createConfigReader([], async () => { calls++; throw new Error('must not read'); });
  const value = await reader.read({ mode: 'default' }), page = projectConfigPage(value, 'synthetic-service', { offset: 0, limit: 100 });
  assert.equal(calls, 0); assert.equal(page.status, 'missing'); assert.equal(page.total, 0); assert.deepEqual(page.sources, { mode: 'default', selectedCount: 0, loadedCount: 0, missingCount: 0 });
  assert.equal(configSourcesSchema.safeParse({ ...page.sources, mode: 'merge' }).success, false); assert.equal(configSourcesSchema.safeParse({ ...page.sources, mode: 'file' }).success, false);
  await assert.rejects(reader.read({ mode: 'merge', paths: [] }), /INVALID_INPUT/);
});
test('default identity binds complete normalized source order and missing membership without exposing paths/body in DTO', async () => {
  const paths = ['/synthetic/a', '/synthetic/b'], files = new Map(paths.map(path => [path, contents(path)]));
  const reader = createConfigReader(paths, async path => { const content = files.get(path); return content === undefined ? null : { sourcePath: path, content }; });
  const first = await reader.read({ mode: 'default' });
  assert.notEqual(reader.selectionKey({ mode: 'default' }), reader.selectionKey({ mode: 'merge', paths }));
  assert.notEqual((await reader.read({ mode: 'merge', paths: [...paths].reverse() })).snapshot.configIdentity, first.snapshot.configIdentity);
  files.delete(paths[1] ?? ''); assert.notEqual((await reader.read({ mode: 'default' })).snapshot.configIdentity, first.snapshot.configIdentity);
  // Context names above deliberately equal synthetic paths; use an empty projection to check the source descriptor itself.
  assert.deepEqual(Object.keys(first.sources).sort(), ['loadedCount', 'missingCount', 'mode', 'selectedCount']);
});
test('default reading never bypasses original parsing/cancellation or per-read byte budgets', async () => {
  let calls = 0; const reader = createConfigReader(['/synthetic/a', '/synthetic/b'], async path => { calls++; return { sourcePath: path, content: 'invalid: [' }; });
  await assert.rejects(reader.read({ mode: 'default' }, AbortSignal.abort()), /QUERY_CANCELLED/); assert.equal(calls, 0);
  await assert.rejects(reader.read({ mode: 'default' }), /CONFIG_INVALID/);
});
