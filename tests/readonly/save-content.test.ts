// PURE content/DTO/buffer values only. No Save client/controller/transport/adapter/hook or operation execution.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { saveContentSnapshot, saveContentChunk } from '../../src/shared/save-content.ts';
import { fileSaveRequestSchema, fileSaveOutcomeSchema, fileSaveResponseSchema, fileSaveSourceSchema, fileSaveTargetSchema, fileSaveLocation, sameFileSave } from '../../src/shared/file-save-protocol.ts';
import type { FileSaveOutcome } from '../../src/shared/file-save-protocol.ts';
import { DocumentBuffer } from '../../src/shared/document-buffer.ts';
import { savedFileForSnapshot } from '../../src/shared/saved-buffer.ts';
import { workspaceBytes } from '../../src/shared/workspace-protocol.ts';
import { WorkspaceClient } from '../../src/host/workspace-client.ts';
import type { WorkspaceState } from '../../src/host/workspace-client.ts';
const id = 'a1111111-1111-4111-8111-111111111111', generation = 'b2222222-2222-4222-8222-222222222222', identity = '1'.repeat(64), version = '2'.repeat(64);
const source = { kind: 'live' as const, identity, revision: 1 }, target = { root: '/synthetic/project', path: 'saved.yaml' };
function outcome(text = 'edited\n'): FileSaveOutcome {
  const bytes = Buffer.from(text); return { id, generation, source, target, bytes: bytes.length, received: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'),
    action: 'create', version: null, mode: 0o600, createdAt: 1, updatedAt: 3, expiresAt: 60001, phase: 'succeeded', cleanup: 'none', result: 'created', versionAfter: version };
}
function buffer() {
  return new DocumentBuffer('loaded\n', { target: { serviceGeneration: 's', projectId: 'p', configIdentity: 'c', context: 'ctx', namespace: 'default' },
    reference: { type: { group: '', version: 'v1', resource: 'configmaps', kind: 'ConfigMap', scope: 'namespace' }, name: 'sample', namespace: 'default', uid: 'original-uid', resourceVersion: 'original-rv' }, format: 'yaml', contentIdentity: identity });
}
for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), '\ufeffkind: ConfigMap\r\nlarge: 9007199254740993\r\n', '😀目录é\n'.repeat(5000), 'x'.repeat(workspaceBytes)]) {
  test(`portable SHA-256 and UTF-8 equal independent Node digest for ${Buffer.byteLength(text)} bytes`, () => {
    const snapshot = saveContentSnapshot(text); assert.deepEqual(Buffer.from(snapshot.bytes), Buffer.from(text)); assert.equal(snapshot.digest, createHash('sha256').update(text).digest('hex')); snapshot.bytes.fill(0);
  });
}
test('portable SHA-256 known empty/abc vectors match published digests', () => { assert.equal(saveContentSnapshot('').digest, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'); assert.equal(saveContentSnapshot('abc').digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); });
test('pure encoder rejects malformed Unicode/NUL and byte/character overflow without changing input', () => { for (const text of ['\ud800', '\udc00', 'a\0b']) assert.throws(() => saveContentSnapshot(text), /CONTENT_INVALID/); for (const text of ['x'.repeat(workspaceBytes + 1), '😀'.repeat(workspaceBytes / 4 + 1)]) assert.throws(() => saveContentSnapshot(text), /BUDGET_EXCEEDED/); });
for (const size of [1, 2, 3, 24575, 24576, 24577, workspaceBytes]) {
  test(`pure base64 chunk assembly preserves ${size} bytes with ≤32768 JSON-safe characters per chunk`, () => {
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 37) % 256), chunks: Buffer[] = [];
    for (let offset = 0; offset < size;) {
      const chunk = saveContentChunk(bytes, offset); assert.ok(chunk.data.length <= 32768); assert.equal(chunk.data, Buffer.from(bytes.subarray(offset, chunk.end)).toString('base64'));
      assert.ok(/^[A-Za-z0-9+/=]+$/.test(chunk.data)); assert.ok(Buffer.byteLength(JSON.stringify({ data: chunk.data })) < 48_000); chunks.push(Buffer.from(chunk.data, 'base64')); offset = chunk.end;
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes));
  });
}
test('empty byte snapshots need no chunk; invalid offsets/oversized bytes are refused by pure chunk helper', () => { for (const offset of [-1, 1, NaN, 0.5]) assert.throws(() => saveContentChunk(new Uint8Array(1), offset), /INVALID_INPUT/); assert.throws(() => saveContentChunk(new Uint8Array(), 0), /INVALID_INPUT/); assert.throws(() => saveContentChunk(new Uint8Array(workspaceBytes + 1), 0), /INVALID_INPUT/); });
test('Save source DTO distinguishes original file proof from live source, refuses fabricated cluster or owner authentication', () => {
  assert.equal(fileSaveSourceSchema.safeParse(source).success, true);
  assert.equal(fileSaveSourceSchema.safeParse({ ...source, projectId: 'trusted' }).success, false);
  assert.equal(fileSaveSourceSchema.safeParse({ ...source, kind: 'file' }).success, false);
  const file = { ...target, version, scope: { generation, id, token: identity } };
  assert.equal(fileSaveSourceSchema.safeParse({ ...source, kind: 'file', file }).success, true); assert.equal(fileSaveSourceSchema.safeParse({ ...source, file }).success, false);
});
test('isolated Save request schema requires explicit confirmation and a fresh write grant, not a read scope', () => {
  const grant = { id, generation, capability: identity, expiresAt: 60001 };
  assert.equal(fileSaveRequestSchema.safeParse({ protocol: 2, kind: 'submit', grant, confirmation: 'save-exact-snapshot' }).success, true);
  assert.equal(fileSaveRequestSchema.safeParse({ protocol: 2, kind: 'submit', grant }).success, false);
  assert.equal(fileSaveRequestSchema.safeParse({ protocol: 2, kind: 'submit', grant: { id, generation, token: identity }, confirmation: 'save-exact-snapshot' }).success, false);
});
test('Save request schema bounds canonical alphabet shape/offset and disallows hidden body/argv or target traversal', () => {
  const value = { protocol: 2, kind: 'begin', requestId: id, target, source, bytes: 1, digest: identity };
  assert.equal(fileSaveRequestSchema.safeParse(value).success, true);
  for (const change of [{ content: 'synthetic' }, { argv: ['anything'] }, { bytes: workspaceBytes + 1 }, { target: { ...target, path: '../escape' } }, { target: { ...target, path: `.oc-k8s-save-${id}.tmp` } }]) assert.equal(fileSaveRequestSchema.safeParse({ ...value, ...change }).success, false);
  const upload = { protocol: 2, kind: 'upload', grant: { id, generation, capability: identity, expiresAt: 60001 }, offset: 0, data: 'YQ==' };
  assert.equal(fileSaveRequestSchema.safeParse(upload).success, true); for (const data of ['a', '-_==', 'a\n==', 'a'.repeat(32772)]) assert.equal(fileSaveRequestSchema.safeParse({ ...upload, data }).success, false);
});
test('public Save outcome DTO never admits plaintext, capabilities, read tokens or source file scope', () => {
  for (const key of ['text', 'content', 'data', 'capability', 'token', 'scope']) assert.equal(fileSaveOutcomeSchema.safeParse({ ...outcome(), [key]: 'SYNTHETIC_ONLY' }).success, false);
  assert.equal(fileSaveOutcomeSchema.safeParse({ ...outcome(), source: { ...source, file: target } }).success, false);
});
test('outcome shape refuses success without definite version/receipt or after incomplete upload/manual cleanup', () => {
  for (const change of [{ versionAfter: undefined }, { result: undefined }, { cleanup: 'manual-check' }, { received: 0 }, { action: 'replace' }, { mode: 0o666 }]) assert.equal(fileSaveOutcomeSchema.safeParse({ ...outcome(), ...change }).success, false);
  assert.equal(fileSaveResponseSchema.safeParse({ protocol: 2, kind: 'outcomes', generation, outcomes: Array.from({ length: 17 }, () => outcome()), next: null }).success, false);
});
test('pure success receipt rejects contradictory error codes or an action/result mismatch', () => {
  for (const change of [{ code: 'CONFLICT' }, { result: 'replaced' }]) {
    assert.equal(fileSaveOutcomeSchema.safeParse({ ...outcome(), ...change }).success, false);
    assert.equal(savedFileForSnapshot({ ...outcome(), ...change }, source, 'edited\n'), undefined);
  }
});
test('same Save comparison binds original identity/path/digest/mode/version/deadline but permits phase progress only', () => {
  const value = outcome(); assert.equal(sameFileSave(value, { ...value, phase: 'unknown', updatedAt: 4, code: 'OPERATION_UNKNOWN' }), true);
  for (const change of [{ id: generation }, { generation: id }, { target: { ...target, path: 'other' } }, { source: { ...source, revision: 2 } }, { digest: version }, { expiresAt: 2 }, { createdAt: 0 }, { mode: 0o400 }]) assert.equal(sameFileSave(value, { ...value, ...change }), false);
});
test('pure successful acknowledgement clears dirty only for exact revision/text and preserves original Load UID/RV/Explain origin', () => {
  const value = buffer(), origin = value.state.origin; value.edit('edited\n'); assert.equal(value.acknowledgeSaved(outcome(), 'edited\n', 1), true);
  assert.equal(value.state.dirty, false); assert.equal(value.state.origin, origin); assert.equal(value.state.origin.reference.uid, 'original-uid'); assert.equal(value.state.origin.reference.resourceVersion, 'original-rv'); assert.equal(value.state.revision, 1);
  assert.equal(value.state.savedFile?.path, target.path); value.edit('later'); value.revert(); assert.equal(value.state.text, 'edited\n'); assert.equal(value.state.dirty, false);
});
test('late success for an edited/renavigated/reloaded or different buffer cannot clear current dirty text', () => {
  const value = buffer(); value.edit('edited\n'); value.edit('later'); assert.equal(value.acknowledgeSaved(outcome(), 'edited\n', 1), false); assert.equal(value.state.dirty, true);
  const other = buffer(); other.edit('edited\n'); assert.equal(other.acknowledgeSaved({ ...outcome(), source: { ...source, identity: version } }, 'edited\n', 1), false);
});
test('unknown/failed/cancelled/mismatched-byte/digest acknowledgements do not change pure buffer baseline', () => {
  for (const phase of ['unknown', 'failed', 'cancelled'] as const) { const value = buffer(); value.edit('edited\n'); assert.equal(value.acknowledgeSaved({ ...outcome(), phase, code: phase === 'unknown' ? 'OPERATION_UNKNOWN' : 'CONFLICT', result: undefined, versionAfter: undefined }, 'edited\n', 1), false); assert.equal(value.state.dirty, true); }
  for (const change of [{ bytes: 6, received: 6 }, { digest: identity }]) assert.equal(savedFileForSnapshot({ ...outcome(), ...change }, source, 'edited\n'), undefined);
});
test('pure file acknowledgement creates only a file receipt and cannot turn a file source into a cluster target', () => {
  const value = { ...outcome(), source: { ...source, kind: 'file' as const } }, receipt = savedFileForSnapshot(value, value.source, 'edited\n'); assert.ok(receipt); assert.equal('target' in receipt, false); assert.equal('scope' in receipt, false); assert.equal('text' in receipt, false); assert.equal(Object.isFrozen(receipt), true);
});
test('canonical location keys unify different safe root/path splits without treating a peer file as the original', () => {
  const a = fileSaveTargetSchema.parse({ root: '/synthetic/project', path: 'subdir/sample.yaml' }), b = fileSaveTargetSchema.parse({ root: '/synthetic/project/subdir', path: 'sample.yaml' });
  assert.equal(fileSaveLocation(a), fileSaveLocation(b)); assert.notEqual(fileSaveLocation(a), fileSaveLocation({ ...a, path: 'subdir/peer.yaml' }));
});
test('synthetic read-only file buffer accepts exact value acknowledgement without invoking any Save transport or operation', async () => {
  const states: WorkspaceState[] = []; let reads = 0;
  const scope = { generation, id, token: identity };
  const client = new WorkspaceClient(async request => {
    const input = JSON.parse(request.body) as { path?: string }; assert.ok(request.path.startsWith('/v2/workspace-files/'));
    const value = request.path.endsWith('/open') ? { protocol: 2, kind: 'workspace-scope', scope, root: target.root, expiresAt: 60001 }
      : request.path.endsWith('/read') ? { protocol: 2, kind: 'workspace-file', scope, root: target.root, path: input.path, version, identity, proof: 'wsp1.synthetic', totalBytes: 7, totalCharacters: 7, offset: 0, end: 7, text: 'loaded\n', nextCursor: null }
      : { protocol: 2, released: true };
    if (request.path.endsWith('/read')) reads++; return { status: 200, body: JSON.stringify(value) };
  }, state => states.push(state));
  await client.open(target.root); await client.read(target.path); client.edit('edited\n');
  const value = { ...outcome(), source: { ...source, kind: 'file' as const } }, origin = states.at(-1)?.file?.origin;
  assert.equal(client.acknowledgeSaved(value, 'edited\n', 1), true); assert.equal(states.at(-1)?.file?.dirty, false); assert.equal(states.at(-1)?.file?.origin, origin); assert.equal(reads, 1);
  client.edit('later'); assert.equal(client.acknowledgeSaved(value, 'edited\n', 1), false); assert.equal(states.at(-1)?.file?.dirty, true); client.revert(); assert.equal(states.at(-1)?.file?.text, 'edited\n'); client.dispose();
});
