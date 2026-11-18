import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { readConfigSelection, selectionFromLines } from '../../src/shared/configuration.ts';
import { createConfigReader, resolveConfigSelection } from '../../src/service/queries/config-source.ts';
import { parseConfigReadRequest } from '../../src/service/queries/config-request.ts';
import { projectConfigPage } from '../../src/service/queries/config-page.ts';
import { protocolVersion } from '../../src/shared/protocol.ts';

const code = (expected: string) => (error: unknown) => error instanceof BoundaryError && error.code === expected && error.message === expected;
const marker = 'SYNTHETIC_SECRET_ONLY', encoded = Buffer.from(marker).toString('base64');
const defaultPath = '/synthetic/default.yaml';

function config(name: string, user: Record<string, unknown> = { token: marker }, cluster: Record<string, unknown> = { server: 'https://synthetic.invalid' }) {
  return JSON.stringify({ 'current-context': name, clusters: [{ name: 'shared', cluster }], users: [{ name: 'shared-user', user }],
    contexts: [{ name, context: { cluster: 'shared', user: 'shared-user' } }] });
}

test('explicit source choices are strict, immutable and accept absolute Server paths only', () => {
  assert.deepEqual(selectionFromLines('default', marker), { mode: 'default' });
  assert.deepEqual(selectionFromLines('file', '/synthetic/file with spaces.yaml\n'), { mode: 'file', path: '/synthetic/file with spaces.yaml' });
  const selected = selectionFromLines('merge', '/synthetic/a.yaml\r\n\n/synthetic/b.yaml');
  assert.ok(Object.isFrozen(selected));
  if (selected.mode === 'merge') assert.ok(Object.isFrozen(selected.paths));
  for (const value of [{ mode: 'file', path: '~/.kube/config' }, { mode: 'file', path: '$HOME/.kube/config' }, { mode: 'file', path: 'relative' },
    { mode: 'file', path: '/bad\npath' }, { mode: 'file', path: 'https://synthetic.invalid' }, { mode: 'default', token: marker }, { mode: 'merge', paths: [] }]) {
    assert.throws(() => readConfigSelection(value), code('INVALID_INPUT'));
  }
  assert.throws(() => selectionFromLines('file', '/synthetic/a\n/synthetic/b'), code('INVALID_INPUT'));
  assert.throws(() => selectionFromLines('merge', 'x'.repeat(24_001)), code('BUDGET_EXCEEDED'));
});

test('ordered files are normalized/deduplicated without changing precedence or inspecting the filesystem', () => {
  assert.deepEqual(resolveConfigSelection({ mode: 'merge', paths: ['/synthetic/a.yaml', '/synthetic/dir/../a.yaml', '/synthetic/b.yaml'] }, defaultPath),
    { mode: 'merge', orderedPaths: ['/synthetic/a.yaml', '/synthetic/b.yaml'] });
  assert.deepEqual(resolveConfigSelection({ mode: 'default' }, defaultPath).orderedPaths, [defaultPath]);
});

test('the real config reader coordinator consumes only an injected pure reader in tests; selection is never global', async () => {
  const files = new Map([[defaultPath, config('default')], ['/synthetic/a.yaml', config('first')], ['/synthetic/b.yaml', config('second', { exec: { command: marker } })]]);
  const calls: string[] = [];
  const reader = createConfigReader(defaultPath, async path => { calls.push(path); const content = files.get(path); return content === undefined ? null : { sourcePath: path, content }; });
  assert.equal(calls.length, 0);
  const merged = await reader.read({ mode: 'merge', paths: ['/synthetic/a.yaml', '/synthetic/b.yaml'] });
  assert.deepEqual(merged.snapshot.contexts.map(context => context.name), ['first', 'second']);
  assert.equal(merged.snapshot.contexts[0]?.active, true);
  assert.ok(merged.snapshot.contexts.every(context => context.authentication.methods.join() === 'token' && !context.authentication.externalExecution), 'later exec stanza must not merge into the winning user');
  const single = await reader.read({ mode: 'file', path: '/synthetic/b.yaml' });
  assert.deepEqual(single.snapshot.contexts.map(context => context.name), ['second']);
  assert.equal(single.snapshot.contexts[0]?.authentication.externalExecution, true);
  const fallback = await reader.read({ mode: 'default' });
  assert.deepEqual(fallback.snapshot.contexts.map(context => context.name), ['default']);
  assert.deepEqual(calls, ['/synthetic/a.yaml', '/synthetic/b.yaml', '/synthetic/b.yaml', defaultPath]);
});

test('explicit single-file missing is an error; merge/default missing are disclosed and never a connected empty cluster', async () => {
  const reader = createConfigReader(defaultPath, async path => path === '/synthetic/found.yaml' ? { sourcePath: path, content: config('found') } : null);
  await assert.rejects(reader.read({ mode: 'file', path: '/synthetic/missing.yaml' }), code('CONFIG_NOT_FOUND'));
  const merged = await reader.read({ mode: 'merge', paths: ['/synthetic/missing.yaml', '/synthetic/found.yaml'] });
  assert.deepEqual(merged.sources, { mode: 'merge', selectedCount: 2, loadedCount: 1, missingCount: 1 });
  const empty = await reader.read({ mode: 'default' });
  assert.equal(empty.status, 'missing');
  assert.equal(empty.sources.missingCount, 1);
});

test('source order/content/missing positions and selection mode invalidate opaque identities and continuation', async () => {
  const files = new Map([['/synthetic/a', config('a')], ['/synthetic/b', config('b')]]);
  const reader = createConfigReader(defaultPath, async path => { const content = files.get(path); return content ? { sourcePath: path, content } : null; });
  const selection = readConfigSelection({ mode: 'merge', paths: ['/synthetic/a', '/synthetic/b'] });
  const a = await reader.read(selection), same = await reader.read(selection);
  assert.equal(a.snapshot.configIdentity, same.snapshot.configIdentity);
  assert.equal(reader.selectionKey(selection), reader.selectionKey(selection));
  const reversed = await reader.read({ mode: 'merge', paths: ['/synthetic/b', '/synthetic/a'] });
  assert.notEqual(a.snapshot.configIdentity, reversed.snapshot.configIdentity);
  files.delete('/synthetic/b');
  const missing = await reader.read(selection);
  assert.notEqual(a.snapshot.configIdentity, missing.snapshot.configIdentity);
  assert.throws(() => projectConfigPage(missing, 'service-1', { offset: 0, limit: 100, configIdentity: a.snapshot.configIdentity }), code('STALE_TARGET'));
  files.set('/synthetic/a', config('a', { token: 'SYNTHETIC_CHANGED' }));
  assert.notEqual((await reader.read(selection)).snapshot.configIdentity, missing.snapshot.configIdentity);
  assert.notEqual(reader.selectionKey({ mode: 'file', path: '/synthetic/a' }), reader.selectionKey({ mode: 'merge', paths: ['/synthetic/a'] }));
});

test('authentication method disclosure never executes exec/provider or reflects commands/env/files/tokens', async () => {
  const user = { exec: { command: marker, args: [encoded], env: [{ name: 'PRIVATE', value: marker }] }, 'auth-provider': { name: marker, config: { token: encoded } },
    token: marker, tokenFile: `/synthetic/${marker}`, 'client-key': `/synthetic/${encoded}`, 'client-certificate-data': encoded, username: marker, password: marker };
  const cluster = { server: `https://${marker}.invalid`, 'certificate-authority': `/synthetic/${marker}`, 'proxy-url': `https://user:${marker}@proxy.invalid` };
  const reader = createConfigReader(defaultPath, async path => ({ sourcePath: path, content: config('safe', user, cluster) }));
  const result = await reader.read({ mode: 'default' });
  const auth = result.snapshot.contexts[0]?.authentication;
  assert.deepEqual(auth?.methods, ['token', 'token-file', 'client-certificate', 'basic', 'exec', 'auth-provider']);
  assert.equal(auth?.externalExecution, true);
  assert.equal(auth?.referencedFiles, true);
  assert.equal(auth?.mayUpdateCredentials, true);
  assert.equal(auth?.proxyConfigured, true);
  assert.equal(auth?.evaluated, false);
  const page = projectConfigPage(result, 'service-1', { offset: 0, limit: 100 });
  const wire = JSON.stringify(page);
  for (const unsafe of [marker, encoded, 'command', 'args', 'sourcePath', 'client-key', 'PRIVATE', defaultPath]) assert.equal(wire.includes(unsafe), false);
});

test('unknown/missing user entries are not misclassified as safe anonymous authentication', async () => {
  const reader = createConfigReader(defaultPath, async path => ({ sourcePath: path, content: config('ctx', { unknown: { token: marker } }) }));
  const result = await reader.read({ mode: 'default' });
  assert.deepEqual(result.snapshot.contexts[0]?.authentication.methods, ['unknown']);
  assert.equal(result.snapshot.contexts[0]?.authentication.mayUpdateCredentials, true);
  const anonymous = createConfigReader(defaultPath, async path => ({ sourcePath: path, content: config('anonymous', {}) }));
  assert.deepEqual((await anonymous.read({ mode: 'default' })).snapshot.contexts[0]?.authentication.methods, ['anonymous']);
  const dangling = createConfigReader(defaultPath, async path => ({ sourcePath: path, content: JSON.stringify({ contexts: [{ name: 'missing', context: { cluster: 'absent', user: 'absent' } }] }) }));
  assert.deepEqual((await dangling.read({ mode: 'default' })).snapshot.contexts[0]?.authentication.methods, ['unknown']);
});

test('configuration requests enforce wire version, bounded JSON and a path-only selection whitelist', () => {
  const body = { protocol: protocolVersion, selection: { mode: 'file', path: '/synthetic/file.yaml' }, page: {} };
  assert.equal(parseConfigReadRequest(JSON.stringify(body)).selection.mode, 'file');
  for (const value of [{ ...body, protocol: 1 }, { ...body, token: marker }, { ...body, selection: { ...body.selection, content: marker } }, { ...body, page: { offset: 1 } }]) {
    assert.throws(() => parseConfigReadRequest(JSON.stringify(value)), code('INVALID_INPUT'));
  }
  assert.throws(() => parseConfigReadRequest(marker.repeat(2000)), code('BUDGET_EXCEEDED'));
  assert.throws(() => parseConfigReadRequest(`{"secret":"${marker}"`), code('INVALID_INPUT'));
});

test('read cancellation and total byte budgets stop the pure coordinator without any auth/file-reference fallback', async () => {
  let calls = 0;
  const pending = Promise.withResolvers<{ sourcePath: string; content: string }>();
  const controller = new AbortController();
  const reader = createConfigReader(defaultPath, async () => { calls++; return pending.promise; });
  const reading = reader.read({ mode: 'default' }, controller.signal);
  controller.abort(marker);
  pending.resolve({ sourcePath: defaultPath, content: config('a') });
  await assert.rejects(reading, code('QUERY_CANCELLED'));
  await assert.rejects(reader.read({ mode: 'default' }, AbortSignal.abort()), code('QUERY_CANCELLED'));
  assert.equal(calls, 1);
  const oversized = createConfigReader(defaultPath, async path => ({ sourcePath: path, content: 'x'.repeat(8_000_001) }));
  await assert.rejects(oversized.read({ mode: 'default' }), code('BUDGET_EXCEEDED'));
});
