// Independent synthetic read backend/transport and buffer values ONLY. Never Save client/controller/writer/SDK/DOM/HTTP/real filesystem.
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { createWorkspaceReader } from '../../src/service/queries/workspace-reader.ts';
import { WorkspaceClient } from '../../src/host/workspace-client.ts';
import type { WorkspaceState } from '../../src/host/workspace-client.ts';
import { workspaceEntrySchema, workspaceRebindSchema, workspaceListSchema } from '../../src/shared/workspace-protocol.ts';
import type { WorkspaceEntry } from '../../src/shared/workspace-protocol.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
const root = '/synthetic/project', path = 'folder/sample.yaml', signal = () => new AbortController().signal;
function fixture() {
  let now = 1000, text = 'synthetic content\n', version = 'file1', topology = 'root1', listing = 'dir1', reads = 0, roots = 0, lists = 0;
  let entries: WorkspaceEntry[] = [{ name: 'folder', kind: 'directory' }, { name: 'sample.yaml', kind: 'file' }, { name: '.hidden', kind: 'file' }, { name: 'link', kind: 'blocked' }];
  let before: (() => Promise<void>) | undefined;
  const reader = createWorkspaceReader('service', {
    inspectRoot: async () => { roots++; return topology; },
    readFile: async (_root, original) => { reads++; await before?.(); if (original !== topology) throw new BoundaryError('STALE_TARGET'); return { text, version }; },
    listDirectory: async (_root, original) => { lists++; await before?.(); if (original !== topology) throw new BoundaryError('STALE_TARGET'); return { version: listing, entries }; },
  }, () => now);
  const states: WorkspaceState[] = [], requests: string[] = [];
  const client = new WorkspaceClient(async request => {
    requests.push(request.path); const input: unknown = JSON.parse(request.body);
    try {
      const value = request.path.endsWith('/open') ? await reader.open(input, signal()) : request.path.endsWith('/read') ? await reader.read(input, signal())
        : request.path.endsWith('/rebind') ? await reader.rebind(input, signal()) : request.path.endsWith('/list') ? await reader.list(input, signal()) : reader.release(input);
      return { status: 200, body: JSON.stringify(value) };
    } catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  }, state => states.push(state));
  return { reader, client, states, requests, last: () => { const value = states.at(-1); assert.ok(value); return value; },
    time(value: number) { now = value; }, text(value: string) { text = value; }, version(value: string) { version = value; }, topology(value: string) { topology = value; }, listing(value: string) { listing = value; }, entries(value: WorkspaceEntry[]) { entries = value; }, before(value: typeof before) { before = value; }, counts: () => ({ reads, roots, lists }),
    async origin() { const scope = await reader.open({ protocol: 2, root }, signal()); const page = await reader.read({ protocol: 2, scope: scope.scope, path }, signal()); return { scope, page }; },
    close() { client.dispose(); reader.close(); } };
}
describe('independent readonly workspace workflow', { timeout: 10_000 }, () => {
test('comparison proof contains no visible body/path, is service-bound and is not accepted as a read scope or writer grant', async () => {
  const f = fixture(), { page } = await f.origin(); assert.ok(page.proof.startsWith('wsp1.')); assert.ok(!page.proof.includes('synthetic content') && !page.proof.includes(root));
  await assert.rejects(f.reader.read({ protocol: 2, scope: page.proof, path }, signal()), /INVALID_INPUT/);
  assert.equal(workspaceRebindSchema.safeParse({ protocol: 2, root, path, proof: page.proof, grant: {} }).success, false); f.close();
});
test('explicit rebind after expiry creates a new fixed-sixty-second scope without extending the old scope or changing source identity/version/proof', async () => {
  const f = fixture(), { scope, page } = await f.origin(); f.time(62000);
  const value = await f.reader.rebind({ protocol: 2, root, path, proof: page.proof }, signal()); assert.equal(value.expiresAt, 122000); assert.notEqual(value.scope.id, scope.scope.id); assert.notEqual(value.scope.token, scope.scope.token);
  assert.equal(value.proof, page.proof); assert.equal(value.identity, page.identity); assert.equal(value.version, page.version); assert.equal('text' in value, false);
  await assert.rejects(f.reader.read({ protocol: 2, scope: scope.scope, path }, signal()), /VIEW_EXPIRED/);
  const read = await f.reader.read({ protocol: 2, scope: value.scope, path }, signal()); assert.equal(read.identity, page.identity); assert.equal(read.version, page.version); f.close();
});
test('rebound scope is a fresh explicitly selected original root, while original-file lineage does not alias peer file identities', async () => {
  const f = fixture(), { page } = await f.origin(), selected = await f.reader.rebind({ protocol: 2, root, path, proof: page.proof }, signal());
  const other = await f.reader.read({ protocol: 2, scope: selected.scope, path: 'peer.yaml' }, signal()); assert.notEqual(other.identity, page.identity);
  const list = await f.reader.list({ protocol: 2, scope: selected.scope, path: '', showHidden: false, offset: 0 }, signal()); assert.equal(list.root, root); f.close();
});
test('proof cannot be relocated to another root/path or decrypted by another service generation and never reaches a backend on rejection', async () => {
  const f = fixture(), { page } = await f.origin(), before = f.counts();
  for (const change of [{ root: '/other' }, { path: 'other.yaml' }, { proof: page.proof.slice(0, -1) + (page.proof.endsWith('A') ? 'B' : 'A') }]) await assert.rejects(f.reader.rebind({ protocol: 2, root, path, proof: page.proof, ...change }, signal()), /STALE_TARGET/);
  assert.deepEqual(f.counts(), before); const other = fixture(); await assert.rejects(other.reader.rebind({ protocol: 2, root, path, proof: page.proof }, signal()), /STALE_TARGET/); assert.equal(other.counts().reads, 0); other.close(); f.close();
});
for (const change of ['body', 'metadata', 'root'] as const) test(`rebind rejects changed original ${change} rather than adopting it as the edited buffer baseline`, async () => {
  const f = fixture(), { page } = await f.origin(); if (change === 'body') f.text('different content'); else if (change === 'metadata') f.version('new inode'); else f.topology('new root');
  await assert.rejects(f.reader.rebind({ protocol: 2, root, path, proof: page.proof }, signal()), /CONFLICT|STALE_TARGET/); f.close();
});
test('rebind does not renew original comparison proof horizon and service close invalidates it', async () => {
  const f = fixture(), { page } = await f.origin(); f.time(86_400_999); const value = await f.reader.rebind({ protocol: 2, root, path, proof: page.proof }, signal()); assert.equal(value.proof, page.proof);
  f.time(86_401_000); await assert.rejects(f.reader.rebind({ protocol: 2, root, path, proof: value.proof }, signal()), /VIEW_EXPIRED/); f.close(); await assert.rejects(f.reader.rebind({ protocol: 2, root, path, proof: value.proof }, signal()), /SERVICE_CLOSED/);
});
test('rebind preserves dirty text/revision/immutable origin and pure revert baseline, installing only a fresh readScope', async () => {
  const f = fixture(); await f.client.open(root); await f.client.read(path); f.client.edit('local dirty text'); const before = f.last().file; assert.ok(before); f.time(62000);
  await f.client.rebind(); const after = f.last().file; assert.ok(after); assert.equal(f.last().phase, 'ready'); assert.equal(after.text, before.text); assert.equal(after.dirty, true); assert.equal(after.revision, before.revision); assert.equal(after.origin, before.origin); assert.notEqual(after.readScope?.id, before.origin.scope.id);
  f.client.revert(); assert.equal(f.last().file?.text, 'synthetic content\n'); assert.equal(f.last().file?.dirty, false); f.close();
});
test('failed original-file rebind keeps dirty contents without silently rebasing to changed disk text', async () => {
  const f = fixture(); await f.client.open(root); await f.client.read(path); f.client.edit('do not lose'); const origin = f.last().file?.origin; f.text('external update'); await f.client.rebind(); assert.equal(f.last().error, 'CONFLICT'); assert.equal(f.last().stale, true); assert.equal(f.last().file?.text, 'do not lose'); assert.equal(f.last().file?.dirty, true); assert.equal(f.last().file?.origin, origin); f.close();
});
test('project changes/cancel during rebind reject late scope publication without losing or adopting another project buffer', async () => {
  for (const reset of ['project', 'cancel'] as const) {
    const f = fixture(); await f.client.open(root); await f.client.read(path); f.client.edit('dirty'); const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); f.before(async () => { entered.resolve(); await release.promise; }); const pending = f.client.rebind(); await entered.promise;
    if (reset === 'project') f.client.project('/other'); else f.client.cancel(); const count = f.states.length; release.resolve(); await pending; assert.equal(f.states.length, count); assert.equal(f.last().file?.text, reset === 'project' ? undefined : 'dirty'); f.close();
  }
});
test('directory listings expose bounded metadata only, sorted hidden-filtered pages with blocked entries and in-root parents', async () => {
  const f = fixture(), { scope } = await f.origin(); const value = await f.reader.list({ protocol: 2, scope: scope.scope, path: '', showHidden: false, offset: 0 }, signal());
  assert.deepEqual(value.entries.map(entry => entry.name), ['folder', 'link', 'sample.yaml']); assert.equal(value.entries[1]?.kind, 'blocked'); assert.equal(value.parent, null); assert.equal('text' in value, false);
  const nested = await f.reader.list({ protocol: 2, scope: scope.scope, path: 'folder/deeper', showHidden: true, offset: 0 }, signal()); assert.equal(nested.parent, 'folder'); assert.equal(nested.entries.length, 4); f.close();
});
test('directory pages bind original scope/path/hidden mode/metadata generation and reject shifted listings rather than merging', async () => {
  const f = fixture(), { scope } = await f.origin(); f.entries(Array.from({ length: 201 }, (_, i) => ({ name: `f${String(i).padStart(3, '0')}`, kind: 'file' })));
  const first = await f.reader.list({ protocol: 2, scope: scope.scope, path: '', showHidden: false, offset: 0 }, signal()); assert.equal(first.entries.length, 100); assert.equal(first.nextOffset, 100);
  const second = await f.reader.list({ protocol: 2, scope: scope.scope, path: '', showHidden: false, offset: 100, listingIdentity: first.listingIdentity }, signal()); assert.equal(second.offset, 100);
  for (const change of [{ path: 'folder' }, { showHidden: true }]) await assert.rejects(f.reader.list({ protocol: 2, scope: scope.scope, path: '', showHidden: false, offset: 100, listingIdentity: first.listingIdentity, ...change }, signal()), /STALE_TARGET/);
  f.listing('changed'); await assert.rejects(f.reader.list({ protocol: 2, scope: scope.scope, path: '', showHidden: false, offset: 100, listingIdentity: first.listingIdentity }, signal()), /STALE_TARGET/); f.close();
});
test('listing input and entries reject traversal/URLs/Unicode/control injection or excessive names and duplicate entries', async () => {
  for (const name of ['..', '.', 'a/b', 'a\\b', 'a\0b', '\ud800', 'a'.repeat(256)]) assert.equal(workspaceEntrySchema.safeParse({ name, kind: 'file' }).success, false);
  const f = fixture(), { scope } = await f.origin(); assert.equal(workspaceListSchema.safeParse({ protocol: 2, scope: scope.scope, path: '', showHidden: false, offset: 1 }).success, false);
  for (const path of ['../escape', '/outside', 'https://synthetic.invalid']) await assert.rejects(f.reader.list({ protocol: 2, scope: scope.scope, path, showHidden: false, offset: 0 }, signal()), /INVALID_INPUT/);
  f.entries([{ name: 'duplicate', kind: 'file' }, { name: 'duplicate', kind: 'directory' }]); await assert.rejects(f.reader.list({ protocol: 2, scope: scope.scope, path: '', showHidden: false, offset: 0 }, signal()), /CONTENT_INVALID/); f.close();
});
test('directory admission uses original scope fixed expiry and shared cumulative128 budget, never silently refreshes or scans another root', async () => {
  const f = fixture(), { scope } = await f.origin(); for (let i = 0; i < 127; i++) await f.reader.list({ protocol: 2, scope: scope.scope, path: '', showHidden: false, offset: 0 }, signal());
  await assert.rejects(f.reader.list({ protocol: 2, scope: scope.scope, path: '', showHidden: false, offset: 0 }, signal()), /BUDGET_EXCEEDED/); f.time(61000); await assert.rejects(f.reader.list({ protocol: 2, scope: scope.scope, path: '', showHidden: false, offset: 0 }, signal()), /VIEW_EXPIRED/); assert.equal(f.counts().lists, 127); f.close();
});
test('file/list/rebind tasks share two actual unsettled backend slots without an extra pool', { timeout: 5000 }, async () => {
  const f = fixture(), { scope, page } = await f.origin(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let active = 0, peak = 0, started = 0;
  f.before(async () => { active++; peak = Math.max(peak, active); if (++started === 2) entered.resolve(); try { await release.promise; } finally { active--; } });
  const tasks = [f.reader.read({ protocol: 2, scope: scope.scope, path }, signal()), f.reader.list({ protocol: 2, scope: scope.scope, path: '', showHidden: false, offset: 0 }, signal()), f.reader.rebind({ protocol: 2, root, path, proof: page.proof }, signal())];
  try { await entered.promise; assert.equal(started, 2); assert.equal(peak, 2); release.resolve(); await Promise.all(tasks); assert.equal(peak, 2); } finally { release.resolve(); f.close(); }
});
test('directory over2000 entries fails as a whole; no healthy partial list or file-body lookup', async () => {
  const f = fixture(), { scope } = await f.origin(); f.entries(Array.from({ length: 2001 }, (_, i) => ({ name: `n${i}`, kind: 'file' })));
  await assert.rejects(f.reader.list({ protocol: 2, scope: scope.scope, path: '', showHidden: false, offset: 0 }, signal()), /BUDGET_EXCEEDED/); assert.equal(f.counts().reads, 1); f.close();
});
test('client browse is explicit/nonrecursive, can keep dirty edits, and selecting a file does not bypass dirty replacement guard', async () => {
  const f = fixture(); await f.client.open(root); assert.equal(f.counts().lists, 0); await f.client.read(path); f.client.edit('dirty'); const origin = f.last().file?.origin;
  await f.client.browse(); assert.equal(f.counts().lists, 1); assert.equal(f.last().file?.text, 'dirty'); assert.equal(f.last().file?.origin, origin);
  const before = f.counts(); await f.client.pick('link'); await f.client.pick('unknown'); assert.deepEqual(f.counts(), before);
  await f.client.pick('sample.yaml'); assert.equal(f.last().error, 'DOCUMENT_DIRTY'); assert.deepEqual(f.counts(), before);
  await f.client.pick('folder'); assert.equal(f.last().listing?.path, 'folder'); assert.equal(f.last().file?.dirty, true); f.close();
});
test('client directory pagination is one bounded page and stale pagination clears selection without replacing the dirty buffer', async () => {
  const f = fixture(); f.entries(Array.from({ length: 150 }, (_, i) => ({ name: `f${String(i).padStart(3, '0')}`, kind: 'file' }))); await f.client.open(root); await f.client.read(path); f.client.edit('dirty'); await f.client.browse();
  assert.equal(f.last().listing?.entries.length, 100); f.listing('changed'); await f.client.browse('', false, true); assert.equal(f.last().error, 'STALE_TARGET'); assert.equal(f.last().listing, undefined); assert.equal(f.last().file?.text, 'dirty'); assert.equal(f.last().file?.dirty, true); f.close();
});
test('a pending directory response cannot repopulate another project or retain names after reset', async () => {
  const f = fixture(); await f.client.open(root); const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); f.before(async () => { entered.resolve(); await release.promise; }); const browse = f.client.browse(); await entered.promise; f.client.project('/other'); const count = f.states.length; release.resolve(); await browse; assert.equal(f.states.length, count); assert.equal(f.last().listing, undefined); f.close();
});
test('rebind respects max32 retained scopes and rejects pre-cancelled requests before backend work', async () => {
  const f = fixture(), { scope, page } = await f.origin(); for (let i = 1; i < 32; i++) await f.reader.open({ protocol: 2, root }, signal()); const before = f.counts();
  await assert.rejects(f.reader.rebind({ protocol: 2, root, path, proof: page.proof }, signal()), /QUERY_LIMIT/); await assert.rejects(f.reader.rebind({ protocol: 2, root, path, proof: page.proof }, AbortSignal.abort()), /QUERY_CANCELLED/); assert.deepEqual(f.counts(), before);
  f.reader.release({ protocol: 2, scope: scope.scope }); await f.reader.rebind({ protocol: 2, root, path, proof: page.proof }, signal()); f.close();
});
test('explicit conflict-draft choice preserves text/baseline/origin, increments intent revision and remains editable without any Save call', async () => {
  const f = fixture(); await f.client.open(root); await f.client.read(path); f.client.edit('retained'); const origin = f.last().file?.origin, revision = f.last().file?.revision ?? 0;
  f.version('external-replacement'); await f.client.rebind(); const before = f.counts(); f.client.keepDraft(); assert.equal(f.last().phase, 'ready'); assert.equal(f.last().file?.detached, true); assert.equal(f.last().file?.text, 'retained'); assert.equal(f.last().file?.origin, origin); assert.equal(f.last().file?.revision, revision + 1);
  f.client.edit('continue editing'); assert.equal(f.last().file?.text, 'continue editing'); f.client.revert(); assert.equal(f.last().file?.text, 'synthetic content\n'); assert.deepEqual(f.counts(), before); f.close();
});
test('keep-draft is not a background stale reset; only a complete preserved buffer in an explicit error state can detach', async () => {
  const f = fixture(); f.client.keepDraft(); assert.equal(f.states.length, 0); await f.client.open(root); await f.client.read(path); f.client.keepDraft(); assert.equal(f.last().file?.detached, undefined); f.close();
});
test('valid root-relative paths longer than scheduler key limits still use bounded keys for file and directory reads', async () => {
  const f = fixture(), { scope } = await f.origin(), long = Array.from({ length: 31 }, () => 'a'.repeat(80)).join('/');
  assert.ok(long.length > 1024); const page = await f.reader.read({ protocol: 2, scope: scope.scope, path: `${long}/file.yaml` }, signal()); assert.equal(page.text, 'synthetic content\n');
  const listing = await f.reader.list({ protocol: 2, scope: scope.scope, path: long, showHidden: false, offset: 0 }, signal()); assert.equal(listing.path, long); f.close();
});
test('a proof expiring while rebind is queued cannot start a new backend root/file inspection', { timeout: 5000 }, async () => {
  const f = fixture(), { scope, page } = await f.origin(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let pending = 0;
  f.before(async () => { if (++pending === 2) entered.resolve(); await release.promise; });
  const reads = [f.reader.read({ protocol: 2, scope: scope.scope, path }, signal()), f.reader.read({ protocol: 2, scope: scope.scope, path: 'peer' }, signal())];
  await entered.promise; const rebind = f.reader.rebind({ protocol: 2, root, path, proof: page.proof }, signal()), before = f.counts(); f.time(86_401_000); release.resolve();
  const results = await Promise.allSettled([...reads, rebind]); assert.ok(results.every(result => result.status === 'rejected')); assert.deepEqual(f.counts(), before); f.close();
});
});
