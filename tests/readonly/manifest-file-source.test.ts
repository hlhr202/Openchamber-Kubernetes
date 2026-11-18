// Pure metadata/source/payload and independent synthetic read/capture only. No real FS/SDK/Create/Save handler imports or mock execution.
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { createWorkspaceReader } from '../../src/service/queries/workspace-reader.ts';
import { WorkspaceClient } from '../../src/host/workspace-client.ts';
import type { WorkspaceState } from '../../src/host/workspace-client.ts';
import { manifestFileInput } from '../../src/host/manifest-file-source.ts';
import { manifestCreateRequestSchema, createSourceSchema } from '../../src/shared/manifest-create-protocol.ts';
import { encodeCreateSource } from '../../src/parsing/manifest-create-source.ts';
import { verifiedManifestFilePayload } from '../../src/parsing/manifest-file-check.ts';
import { saveContentSnapshot } from '../../src/shared/save-content.ts';
const root = '/synthetic/project', initial = 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: first}\n', other = 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: other}\n';
const signal = () => new AbortController().signal;
async function fixture() {
  let now = 1, topology = 'root-original', reads = 0; const files = new Map([['first.yaml', { text: initial, version: 'v1' }], ['other.yaml', { text: other, version: 'v1' }]]);
  let before: (() => Promise<void>) | undefined;
  const reader = createWorkspaceReader('service', { inspectRoot: async () => topology, readFile: async (_root, version, path) => {
    reads++; await before?.(); if (version !== topology) throw new BoundaryError('STALE_TARGET'); const file = files.get(path); if (!file) throw new BoundaryError('NOT_FOUND'); return { ...file };
  } }, () => now);
  const states: WorkspaceState[] = [], paths: string[] = [], client = new WorkspaceClient(async request => {
    paths.push(request.path); const input: unknown = JSON.parse(request.body);
    const page = request.path.endsWith('/open') ? await reader.open(input, signal()) : request.path.endsWith('/read') ? await reader.read(input, signal()) : request.path.endsWith('/rebind') ? await reader.rebind(input, signal()) : reader.release(input);
    return { status: 200, body: JSON.stringify(page) };
  }, state => states.push(state));
  await client.open(root); await client.read('first.yaml');
  const editor = () => { const value = states.at(-1)?.file; assert.ok(value); return value; };
  return { reader, client, states, paths, editor, reads: () => reads, file(path: string, text: string, version = 'v2') { files.set(path, { text, version }); }, now(value: number) { now = value; }, topology(value: string) { topology = value; }, before(value: typeof before) { before = value; }, close() { client.dispose(); reader.close(); } };
}
describe('independent manifest file sources', { timeout: 10_000 }, () => {
test('full internal capture uses the original scope/path/identity/version but returns one complete read-only snapshot', async () => {
  const f = await fixture(), editor = f.editor(); const captured = await f.reader.capture({ protocol: 2, scope: editor.origin.scope, path: editor.origin.path }, signal());
  assert.equal(captured.text, initial); assert.equal(captured.root, root); assert.equal(captured.path, editor.origin.path); assert.equal(captured.identity, editor.origin.identity); assert.equal(captured.version, editor.origin.version); f.close();
});
test('capture is not an arbitrary root/cursor/write grant and rejects malformed targets before backend access', async () => {
  const f = await fixture(), scope = f.editor().origin.scope, before = f.reads();
  for (const extra of [{ path: '../escape' }, { root: '/other' }, { cursor: 'cursor' }, { body: 'anything' }]) await assert.rejects(f.reader.capture({ protocol: 2, scope, path: 'first.yaml', ...extra }, signal()), /INVALID_INPUT/);
  assert.equal(f.reads(), before); f.close();
});
test('internal capture preserves complete BOM/CRLF/large numeric text without parsing or modifying the source', async () => {
  const f = await fixture(); const text = '\ufeff# comment\r\nvalue: 9007199254740993\r\n' + 'x'.repeat(100_000); f.file('first.yaml', text);
  const captured = await f.reader.capture({ protocol: 2, scope: f.editor().origin.scope, path: 'first.yaml' }, signal()); assert.equal(captured.text, text); assert.notEqual(captured.version, f.editor().origin.version); f.close();
});
test('capture shares fixed scope expiry and cumulative128 admission rather than opening a second unbounded file-read pool', async () => {
  const f = await fixture(), scope = f.editor().origin.scope;
  for (let i = 1; i < 128; i++) await f.reader.capture({ protocol: 2, scope, path: 'first.yaml' }, signal());
  const before = f.reads(); await assert.rejects(f.reader.capture({ protocol: 2, scope, path: 'first.yaml' }, signal()), /BUDGET_EXCEEDED/); assert.equal(f.reads(), before);
  f.now(60_001); await assert.rejects(f.reader.capture({ protocol: 2, scope, path: 'first.yaml' }, signal()), /VIEW_EXPIRED/); f.close();
});
test('capture rejects cancelled/released/topology-drifted sources and cannot publish a late snapshot after release', async () => {
  const f = await fixture(), scope = f.editor().origin.scope, controller = new AbortController(); controller.abort();
  await assert.rejects(f.reader.capture({ protocol: 2, scope, path: 'first.yaml' }, controller.signal), /QUERY_CANCELLED/);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); f.before(async () => { entered.resolve(); await release.promise; });
  const pending = f.reader.capture({ protocol: 2, scope, path: 'first.yaml' }, signal()), rejected = assert.rejects(pending, /VIEW_EXPIRED/); await entered.promise; f.reader.release({ protocol: 2, scope }); release.resolve(); await rejected; f.close();
});
test('independent picked-file capture never replaces an active dirty editor, baseline, revision, origin or displayed state', async () => {
  const f = await fixture(); f.client.edit(initial + '# dirty\n'); const before = f.editor(), count = f.states.length;
  const picked = await f.client.captureFile('other.yaml'); assert.equal(picked.text, other); assert.equal(picked.dirty, false); assert.equal(picked.origin.path, 'other.yaml');
  assert.equal(f.editor(), before); assert.equal(f.states.length, count); assert.equal(f.editor().dirty, true); f.close();
});
test('picked-file capture completes all original validated chunks while preserving an unrelated dirty buffer', async () => {
  const f = await fixture(); f.client.edit(initial + '# dirty\n'); const before = f.editor(), text = other + '#'.repeat(100_000); f.file('other.yaml', text);
  const picked = await f.client.captureFile('other.yaml'); assert.equal(picked.text, text); assert.equal(f.editor(), before); assert.ok(f.paths.filter(path => path.endsWith('/read')).length > 4); f.close();
});
test('root/project changes refuse a late independent capture without installing it in the new project', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.before(async () => { entered.resolve(); await release.promise; }); const pending = f.client.captureFile('other.yaml'), rejected = assert.rejects(pending, /QUERY_CANCELLED|VIEW_EXPIRED/);
  await entered.promise; f.client.project('/different'); release.resolve(); await rejected; assert.equal(f.states.at(-1)?.file, undefined); f.close();
});
test('ordinary dirty/detached file sources are refused as pure local gates, never auto-Save or silently upload edits as disk contents', async () => {
  const f = await fixture(), before = f.paths.length, editor = f.editor();
  assert.throws(() => manifestFileInput({ ...editor, dirty: true }, 'yaml'), /DOCUMENT_DIRTY/); assert.throws(() => manifestFileInput({ ...editor, detached: true }, 'yaml'), /CONFLICT/);
  assert.equal(f.paths.length, before); f.close();
});
test('clean ordinary file projection carries original proof privately and public exact location/version, not a read token as write authority', async () => {
  const f = await fixture(), editor = f.editor(), value = manifestFileInput(editor, 'yaml'); assert.equal(value.source.kind, 'file'); assert.equal(value.source.fileProof, editor.origin.proof);
  assert.equal(value.source.file.version, editor.origin.version); assert.equal(value.source.file.identity, editor.origin.identity); assert.equal('scope' in value.source.file, false); f.close();
});
test('a succeeded Save receipt projects only the same canonical ordinary file; Save As never silently relocates source', async () => {
  const f = await fixture(), editor = f.editor(), receipt = { id: '00000000-0000-4000-8000-000000000001', generation: '00000000-0000-4000-8000-000000000002', root, path: editor.origin.path, version: 'a'.repeat(64) };
  const source = manifestFileInput({ ...editor, savedFile: receipt }, 'yaml'); assert.equal(source.source.fileProof, undefined); assert.equal(source.source.file.version, receipt.version); assert.deepEqual(source.source.file.receipt, receipt);
  assert.throws(() => manifestFileInput({ ...editor, savedFile: { ...receipt, path: 'elsewhere.yaml' } }, 'yaml'), /CONFLICT/); f.close();
});
test('Create File projection uses an independent read snapshot, not an active editor Save receipt or dirty text', async () => {
  const f = await fixture(), picked = await f.client.captureFile('other.yaml'), source = manifestFileInput(picked, 'yaml', true);
  assert.equal(source.source.kind, 'file-command'); assert.equal(source.source.file.path, 'other.yaml'); assert.equal(source.text, other); assert.equal(source.source.file.receipt, undefined); f.close();
});
test('file Create begin DTO separates private source proof from public outcome metadata and requires original proof or a same-file Save receipt', async () => {
  const f = await fixture(), value = manifestFileInput(f.editor(), 'yaml'), identity = saveContentSnapshot(initial).digest;
  const { fileProof, ...source } = value.source;
  const begin = { protocol: 2, kind: 'begin', requestId: '00000000-0000-4000-8000-000000000001', target: { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'default' }, selection: { mode: 'default' }, source: { ...source, identity }, bytes: 10, digest: 'a'.repeat(64), fileProof };
  assert.equal(manifestCreateRequestSchema.safeParse(begin).success, true); assert.equal(manifestCreateRequestSchema.safeParse({ ...begin, fileProof: undefined }).success, false);
  assert.equal(createSourceSchema.safeParse({ ...begin.source, fileProof }).success, false);
  assert.equal(manifestCreateRequestSchema.safeParse({ ...begin, readScope: f.editor().origin.scope }).success, false); f.close();
});
test('actual file canonical payload must match both original source digest and final payload hash/bytes, not merely semantic YAML equality', () => {
  const payload = encodeCreateSource(initial, 'yaml'), source = saveContentSnapshot(initial), encoded = saveContentSnapshot(payload), expected = { sourceDigest: source.digest, payloadDigest: encoded.digest, payloadBytes: encoded.bytes.length };
  assert.equal(verifiedManifestFilePayload(initial, 'yaml', expected), payload);
  for (const text of [initial + '# external comment\n', initial.replace('first', 'other')]) assert.throws(() => verifiedManifestFilePayload(text, 'yaml', expected), /CONFLICT/);
  assert.throws(() => verifiedManifestFilePayload(initial, 'yaml', { ...expected, payloadDigest: 'f'.repeat(64) }), /CONFLICT/);
  assert.throws(() => verifiedManifestFilePayload(initial, 'yaml', { ...expected, payloadBytes: expected.payloadBytes + 1 }), /CONFLICT/); source.bytes.fill(0); encoded.bytes.fill(0);
});
test('file source proof rebind remains read-only/fixed lineage: changed body or same-body metadata version rejects before any consumption', async () => {
  const f = await fixture(), editor = f.editor(); f.now(60_001); const rebound = await f.reader.rebind({ protocol: 2, root, path: editor.origin.path, proof: editor.origin.proof }, signal());
  const actual = await f.reader.capture({ protocol: 2, scope: rebound.scope, path: editor.origin.path }, signal()); assert.equal(actual.identity, editor.origin.identity); assert.equal(actual.version, editor.origin.version);
  f.file('first.yaml', initial, 'same-text-new-inode'); await assert.rejects(f.reader.rebind({ protocol: 2, root, path: editor.origin.path, proof: editor.origin.proof }, signal()), /CONFLICT/); f.close();
});
test('independent captures retain actual two RPC slots across pending reads and do not create an extra client pool', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let entries = 0;
  f.before(async () => { if (++entries === 2) entered.resolve(); await release.promise; });
  const one = f.client.captureFile('first.yaml'), two = f.client.captureFile('other.yaml'); await entered.promise;
  await assert.rejects(f.client.captureFile('other.yaml'), /QUERY_LIMIT/); release.resolve(); await Promise.all([one, two]); assert.equal(entries, 2); f.close();
});
});
