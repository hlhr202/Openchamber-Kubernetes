// Independent synthetic read backend/transport and local edit buffer only. No real filesystem/SDK/HTTP/bridge/writer/operations/sessions.
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { createWorkspaceReader } from '../../src/service/queries/workspace-reader.ts';
import { WorkspaceClient } from '../../src/host/workspace-client.ts';
import type { WorkspaceState } from '../../src/host/workspace-client.ts';
import { workspaceRootSchema, workspaceRelativeSchema, workspaceBytes } from '../../src/shared/workspace-protocol.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
const root = '/synthetic/workspace', marker = 'SYNTHETIC_PRIVATE_VALUE', signal = () => new AbortController().signal;
function fixture() {
  let text = 'apiVersion: v1\nkind: ConfigMap\n# '+marker+'\n', version = 'v1', rootVersion = 'root1', now = 1000, reads = 0, roots = 0;
  let before: (() => void | Promise<void>) | undefined;
  const backend = { inspectRoot: async (_root: string, sig: AbortSignal) => { roots++; if (sig.aborted) throw new BoundaryError('QUERY_CANCELLED'); return rootVersion; },
    readFile: async (_root: string, original: string, path: string, sig: AbortSignal) => { reads++; await before?.(); if (sig.aborted) throw new BoundaryError('QUERY_CANCELLED'); if (original !== rootVersion) throw new BoundaryError('STALE_TARGET'); if (path === 'missing') throw new BoundaryError('NOT_FOUND'); return { text, version }; } };
  const reader = createWorkspaceReader('s', backend, () => now), states: WorkspaceState[] = [];
  const request = async (request: { path: string; body: string }) => {
    const body: unknown = JSON.parse(request.body);
    try { const result = request.path.endsWith('/open') ? await reader.open(body, signal()) : request.path.endsWith('/read') ? await reader.read(body, signal()) : reader.release(body); return { status: 200, body: JSON.stringify(result) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  };
  const client = new WorkspaceClient(request, state => states.push(state));
  return { reader, client, states, counts: () => ({ reads, roots }), text: () => text, setText(value: string) { text = value; }, setVersion(value: string) { version = value; }, setRoot(value: string) { rootVersion = value; }, time(value: number) { now = value; }, before(callback: typeof before) { before = callback; },
    open: () => reader.open({ protocol: 2, root }, signal()), read: (scope: unknown, cursor?: string) => reader.read({ protocol: 2, scope, path: 'sample.yaml', ...(cursor ? { cursor } : {}) }, signal()),
    last: () => { const value = states.at(-1); assert.ok(value); return value; }, close: () => { client.dispose(); reader.close(); } };
}
describe('independent scoped workspace reads and local buffers', { timeout: 10_000 }, () => {
test('workspace root/relative path admission rejects traversal/absolute tails/UNC/control/backslash and accepts Unicode literal filenames', () => {
  for (const path of ['/', '//host/path', '/a/../b', '/a/./b', '/a//b', '/a/', '/a\0b', '/a\\b', '/a\ud800']) assert.equal(workspaceRootSchema.safeParse(path).success, false, path);
  for (const path of ['/etc/file', '../file', 'a/../b', './file', '~/../a', 'a//b', 'a\\b', 'a\0b']) assert.equal(workspaceRelativeSchema.safeParse(path).success, false, path);
  assert.equal(workspaceRelativeSchema.safeParse('目录/文件%20.yaml').success, true); assert.equal(workspaceRootSchema.safeParse(root).success, true);
  assert.equal(workspaceRootSchema.safeParse('/' + Array.from({ length: 65 }, () => 'a').join('/')).success, false);
  assert.equal(workspaceRelativeSchema.safeParse(Array.from({ length: 33 }, () => 'a').join('/')).success, false);
});
test('constructing workspace reader/client touches no backend and scopes contain only pinned root metadata, not file bodies', async () => { const f = fixture(); assert.deepEqual(f.counts(), { reads: 0, roots: 0 }); const page = await f.open(); assert.equal(page.root, root); assert.equal(page.scope.generation, 's'); assert.equal(page.expiresAt, 61000); assert.equal(JSON.stringify(page).includes(marker), false); f.close(); });
test('strict workspace input does not accept a writer/body/URL/cluster target or a client-supplied scope version', async () => { const f = fixture(); for (const extra of [{ text: marker }, { url: 'https://synthetic.invalid' }, { target: {} }, { version: 'mine' }]) await assert.rejects(f.reader.open({ protocol: 2, root, ...extra }, signal()), /INVALID_INPUT/); assert.equal(f.counts().roots, 0); f.close(); });
test('workspace file pages preserve original UTF-8/BOM/newlines/large numeric text without parsing YAML or Kubernetes identity', async () => { const f = fixture(); const text = '\ufeffkind: Other\r\nvalue: 9007199254740993\r\n'; f.setText(text); const scope = await f.open(), page = await f.read(scope.scope); assert.equal(page.text, text); assert.equal(page.totalBytes, Buffer.byteLength(text)); assert.equal('target' in page, false); f.close(); });
test('file reading never escapes the issued scope or adopts a new root from read JSON', async () => { const f = fixture(), scope = await f.open(); await assert.rejects(f.reader.read({ protocol: 2, scope: scope.scope, root: '/other', path: 'sample.yaml' }, signal()), /INVALID_INPUT/); assert.equal(f.counts().reads, 0); f.close(); });
test('forged token/generation/id and released scopes cannot read or cancel another issued root', async () => { const f = fixture(), first = await f.open(), peer = await f.open(); for (const change of [{ token: '0'.repeat(64) }, { generation: 'other' }, { id: peer.scope.id }]) await assert.rejects(f.read({ ...first.scope, ...change }), /VIEW_EXPIRED|STALE_TARGET/); f.reader.release({ protocol: 2, scope: first.scope }); await assert.rejects(f.read(first.scope), /VIEW_EXPIRED/); assert.equal((await f.read(peer.scope)).text, f.text()); f.close(); });
test('scope fixed sixty-second expiry is not extended by reads, and restarting service rejects old handles', async () => { const f = fixture(), scope = await f.open(); f.time(60999); await f.read(scope.scope); f.time(61000); await assert.rejects(f.read(scope.scope), /VIEW_EXPIRED/); f.close(); });
test('root topology version changes reject file reads without rebinding or scanning another root', async () => { const f = fixture(), scope = await f.open(); f.setRoot('replacement'); await assert.rejects(f.read(scope.scope), /STALE_TARGET/); assert.equal(f.counts().reads, 1); f.close(); });
test('chunked workspace reads are surrogate-safe and keep the same file identity/version across all pages', async () => { const f = fixture(); f.setText('a'.repeat(16383) + '😀' + 'b'.repeat(20000)); const scope = await f.open(), first = await f.read(scope.scope); assert.equal(first.text.length, 16383); assert.ok(first.nextCursor); const second = await f.read(scope.scope, first.nextCursor); assert.equal(second.identity, first.identity); assert.equal(second.version, first.version); assert.equal(second.offset, 16383); assert.ok(second.text.startsWith('😀')); f.close(); });
test('continuation binds the exact scope/path and detects changed content even when metadata version remains equal', async () => { const f = fixture(); f.setText('a'.repeat(20000)); const scope = await f.open(), first = await f.read(scope.scope); assert.ok(first.nextCursor); await assert.rejects(f.reader.read({ protocol: 2, scope: scope.scope, path: 'other.yaml', cursor: first.nextCursor }, signal()), /STALE_TARGET/); f.setText('b'.repeat(20000)); await assert.rejects(f.read(scope.scope, first.nextCursor), /STALE_TARGET/); f.close(); });
test('same text with changed inode/metadata version invalidates an old file continuation', async () => { const f = fixture(); f.setText('a'.repeat(20000)); const scope = await f.open(), first = await f.read(scope.scope); assert.ok(first.nextCursor); f.setVersion('replaced'); await assert.rejects(f.read(scope.scope, first.nextCursor), /STALE_TARGET/); f.close(); });
test('empty files are complete, while oversized/NUL/malformed Unicode snapshots fail without partial editor success', async () => { for (const text of ['', 'x'.repeat(workspaceBytes + 1), '\ud800', 'a\0b']) { const f = fixture(); f.setText(text); const scope = await f.open(); if (!text) assert.equal((await f.read(scope.scope)).nextCursor, null); else await assert.rejects(f.read(scope.scope), /CONTENT_INVALID|BUDGET_EXCEEDED/); f.close(); } });
test('already cancelled scope creation/file reads never touch a synthetic backend', async () => { const f = fixture(); await assert.rejects(f.reader.open({ protocol: 2, root }, AbortSignal.abort()), /QUERY_CANCELLED/); const scope = await f.open(); await assert.rejects(f.reader.read({ protocol: 2, scope: scope.scope, path: 'sample.yaml' }, AbortSignal.abort()), /QUERY_CANCELLED/); assert.equal(f.counts().reads, 0); f.close(); });
test('scope admission bounds retained metadata to 32 and expired entries can be replaced without deleting files', async () => { const f = fixture(); for (let i = 0; i < 32; i++) await f.open(); await assert.rejects(f.open(), /QUERY_LIMIT/); f.time(61000); await f.open(); assert.equal(f.counts().roots, 33); f.close(); });
test('scope openings and file reads use the same two actually unsettled finite slots', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let active = 0, peak = 0, started = 0;
  const touch = async () => { active++; started++; peak = Math.max(peak, active); if (started === 2) entered.resolve(); try { await release.promise; } finally { active--; } };
  const reader = createWorkspaceReader('s', { inspectRoot: async () => { await touch(); return 'root'; }, readFile: async () => { await touch(); return { text: '', version: 'file' }; } });
  const one = reader.open({ protocol: 2, root }, signal()), two = reader.open({ protocol: 2, root }, signal());
  try { await entered.promise; await assert.rejects(reader.open({ protocol: 2, root }, signal()), /QUERY_LIMIT/); assert.equal(peak, 2); release.resolve(); const scope = await one; await two; await reader.read({ protocol: 2, scope: scope.scope, path: 'file.yaml' }, signal()); assert.equal(peak, 2); } finally { release.resolve(); reader.close(); }
});
test('releasing a scope during its pending read prevents late body publication', async () => { const f = fixture(), scope = await f.open(), wait = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); f.before(async () => { entered.resolve(); await wait.promise; }); const read = f.read(scope.scope); await entered.promise; f.reader.release({ protocol: 2, scope: scope.scope }); wait.resolve(); await assert.rejects(read, /VIEW_EXPIRED/); f.close(); });
test('client completes all validated chunks before exposing an independent non-cluster edit buffer', async () => { const f = fixture(); f.setText('x'.repeat(40000)); await f.client.open(root); await f.client.read('sample.yaml'); const file = f.last().file; assert.ok(file); assert.equal(file.text, f.text()); assert.equal(file.dirty, false); assert.equal(f.counts().reads, 3); assert.equal('text' in file.origin, false); assert.equal('target' in file.origin, false); f.close(); });
test('editing/reverting file buffers remains local and never invokes even a mocked file writer', async () => { const f = fixture(); await f.client.open(root); await f.client.read('sample.yaml'); const before = f.counts(); f.client.edit('local changes'); assert.equal(f.last().file?.dirty, true); assert.equal(f.last().file?.revision, 1); f.client.revert(); assert.equal(f.last().file?.text, f.text()); assert.equal(f.last().file?.dirty, false); assert.deepEqual(f.counts(), before); f.close(); });
test('dirty files block implicit replacement/close/new-root selection and preserve edits until explicit discard', async () => { const f = fixture(); await f.client.open(root); await f.client.read('sample.yaml'); f.client.edit('dirty'); const before = f.counts(); await f.client.open('/other'); await f.client.read('other.yaml'); f.client.close(); assert.equal(f.last().error, 'DOCUMENT_DIRTY'); assert.equal(f.last().file?.text, 'dirty'); assert.deepEqual(f.counts(), before); await f.client.read('sample.yaml', true); assert.equal(f.last().file?.dirty, false); f.close(); });
test('invalid/oversized local edits preserve the previous buffer and do not call the backend', async () => { const f = fixture(); await f.client.open(root); await f.client.read('sample.yaml'); const before = f.counts(); for (const text of ['\ud800', 'a\0b', 'x'.repeat(workspaceBytes + 1)]) { f.client.edit(text); assert.equal(f.last().file?.text, f.text()); assert.ok(f.last().error); } assert.deepEqual(f.counts(), before); f.close(); });
test('project change clears file body and scope without selecting a new root or reading from the new project', async () => { const f = fixture(); await f.client.open(root); await f.client.read('sample.yaml'); f.client.edit('dirty'); const before = f.counts(); f.client.project('/new-project'); assert.equal(f.last().phase, 'idle'); assert.equal(f.last().file, undefined); assert.equal(f.last().scope, undefined); assert.deepEqual(f.counts(), before); f.close(); });
test('cancelled client read rejects late body/editor delivery and leaves no partial new file', async () => { const f = fixture(), entered = Promise.withResolvers<void>(), wait = Promise.withResolvers<void>(); await f.client.open(root); f.before(async () => { entered.resolve(); await wait.promise; }); const read = f.client.read('sample.yaml'); await entered.promise; f.client.cancel(); const count = f.states.length; wait.resolve(); await read; assert.equal(f.states.length, count); assert.equal(f.last().error, 'QUERY_CANCELLED'); assert.equal(f.last().file, undefined); f.close(); });
test('root drift during reload preserves the old file as stale and blocks local edits, not silently replacing it', async () => { const f = fixture(); await f.client.open(root); await f.client.read('sample.yaml'); f.setRoot('replacement'); await f.client.read('sample.yaml'); assert.equal(f.last().stale, true); const text = f.last().file?.text; f.client.edit('should-not-edit'); assert.equal(f.last().file?.text, text); f.close(); });
test('independent workspace reads do not parse kubeconfig or depend on active namespace/resource GVK', async () => { const f = fixture(); f.setText('not: [valid Kubernetes metadata]\n'+marker); await f.client.open(root); await f.client.read('plain.txt'); assert.equal(f.last().file?.text, f.text()); assert.equal(f.last().phase, 'ready'); f.close(); });
test('bad root/offset/byte counts in synthetic read replies cannot create a complete editable file', async () => {
  for (const change of [{ root: '/other' }, { offset: 1, end: 2, text: 'x' }, { totalBytes: 0 }]) {
    const f = fixture(), states: WorkspaceState[] = [], client = new WorkspaceClient(async request => {
      const input: unknown = JSON.parse(request.body), result = request.path.endsWith('/open') ? await f.reader.open(input, signal()) : request.path.endsWith('/read') ? { ...await f.reader.read(input, signal()), ...change } : f.reader.release(input);
      return { status: 200, body: JSON.stringify(result) };
    }, state => states.push(state));
    await client.open(root); await client.read('file.yaml'); assert.equal(states.at(-1)?.phase, 'error'); assert.equal(states.at(-1)?.file, undefined); client.dispose(); f.close();
  }
});
test('a pending root reply arriving after project change is released, not installed as the new project scope', async () => {
  const f = fixture(), wait = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), states: WorkspaceState[] = [], paths: string[] = [];
  const client = new WorkspaceClient(async request => {
    paths.push(request.path); const input: unknown = JSON.parse(request.body);
    if (request.path.endsWith('/open')) { entered.resolve(); await wait.promise; return { status: 200, body: JSON.stringify(await f.reader.open(input, signal())) }; }
    return { status: 200, body: JSON.stringify(f.reader.release(input)) };
  }, state => states.push(state));
  const open = client.open(root); await entered.promise; client.project('/other'); const count = states.length; wait.resolve(); await open;
  assert.equal(states.length, count); assert.equal(states.at(-1)?.scope, undefined); assert.ok(paths.includes('/v2/workspace-files/release')); client.dispose(); f.close();
});
test('workspace client bounds two actual unsettled RPCs across rapid root replacement, without queueing an unbounded retry', async () => {
  const f = fixture(), wait = Promise.withResolvers<void>(); let calls = 0, active = 0, peak = 0;
  const client = new WorkspaceClient(async request => {
    active++; peak = Math.max(peak, active); const input: unknown = JSON.parse(request.body);
    try { if (request.path.endsWith('/open')) { calls++; await wait.promise; return { status: 200, body: JSON.stringify(await f.reader.open(input, signal())) }; }
      return { status: 200, body: JSON.stringify(f.reader.release(input)) };
    } finally { active--; }
  }, () => {});
  const a = client.open(root), b = client.open('/synthetic/second'), c = client.open('/synthetic/third');
  assert.equal(calls, 2); assert.equal(peak, 2); wait.resolve(); await Promise.all([a, b, c]); assert.equal(calls, 2); assert.equal(peak, 2); client.dispose(); f.close();
});
test('refused dirty replacement cannot turn a stale file editable after root drift', async () => { const f = fixture(); await f.client.open(root); await f.client.read('file.yaml'); f.client.edit('dirty'); f.setRoot('changed'); await f.client.read('file.yaml', true); assert.equal(f.last().stale, true); f.client.close(); assert.equal(f.last().stale, true); f.client.edit('must-not-adopt'); assert.equal(f.last().file?.text, 'dirty'); f.close(); });
test('per-scope file read quota survives reload/continuation and rejects the 129th admission before any backend read', async () => { const f = fixture(), scope = await f.open(); for (let i = 0; i < 128; i++) await f.read(scope.scope); await assert.rejects(f.read(scope.scope), /BUDGET_EXCEEDED/); assert.equal(f.counts().reads, 128); f.close(); });
});
