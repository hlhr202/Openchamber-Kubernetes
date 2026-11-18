// Pure local syntax, detached buffers and synthetic read DTOs only. No filesystem, SDK or operation handlers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { analyseManifestBundle } from '../../src/host/manifest-bundle.ts';
import { DocumentBuffer as DetachedBuffer, bufferDocumentText } from '../../src/shared/document-buffer.ts';
import { readManifestBundle } from '../../src/shared/manifest-bundle.ts';
import { documentFields, explanationRequest } from '../../src/host/document-fields.ts';
import { DocumentClient } from '../../src/host/document-client.ts';
import type { DocumentState } from '../../src/host/document-client.ts';
const secret = 'SYNTHETIC_PRIVATE_VALUE';
const first = `apiVersion: v1\nkind: Pod\nmetadata: {name: first, namespace: default}\nspec: {containers: [{name: app, image: ${secret}}]}\n`;
const second = 'apiVersion: v1\nkind: Pod\nmetadata: {name: second}\nspec: {restartPolicy: Never}\n';
const stream = first + '---\n' + second;
// Pure local convenience, not an executor/controller mock: parser output enters the portable detached buffer.
class DocumentBuffer extends DetachedBuffer {
  override analyse(): void { super.analyse(analyseManifestBundle(this.state.text, this.state.origin.format)); }
}
const origin = { target: { serviceGeneration: 's', projectId: 'p', configIdentity: 'c', context: 'active', namespace: 'default' },
  reference: { type: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' as const }, name: 'first', namespace: 'default', uid: 'u', resourceVersion: 'r' }, format: 'yaml' as const, contentIdentity: 'a'.repeat(64) };
function state(buffer: DocumentBuffer): DocumentState {
  const page = { ...origin, protocol: 2 as const, kind: 'resource-document' as const, text: first, offset: 0, end: first.length, totalBytes: Buffer.byteLength(first), totalCharacters: first.length, nextCursor: null };
  return { phase: 'ready', stale: false, text: first, complete: true, source: { ...origin, protocol: 2, selection: { mode: 'default' } }, page, editor: buffer.state };
}
test('YAML stream produces ordered bounded source spans and only root identity metadata', () => {
  const bundle = analyseManifestBundle(stream, 'yaml'); assert.equal(bundle.documents.length, 2); assert.deepEqual(bundle.documents.map(doc => doc.name), ['first', 'second']); assert.equal(bundle.documents[0]?.namespace, 'default'); assert.equal(JSON.stringify(bundle).includes(secret), false); assert.equal(bundle.characters, stream.length);
});
test('source document slices preserve comments/CRLF and select the actual second document without reserialization', () => {
  const text = '# start\r\n' + stream.replaceAll('\n', '\r\n'), bundle = analyseManifestBundle(text, 'yaml'), secondDoc = bundle.documents[1]; assert.ok(secondDoc);
  const slice = text.slice(secondDoc.start, secondDoc.end); assert.ok(slice.includes('name: second')); assert.equal(slice.includes('name: first'), false); assert.ok(slice.includes('\r\n'));
});
test('document markers inside literal/folded strings and quoted scalars do not split the stream', () => {
  const text = 'data:\n  script: |\n    ---\n    ...\n  quoted: "---"\n'; assert.equal(analyseManifestBundle(text, 'yaml').documents.length, 1);
});
test('empty documents, scalar/sequence roots and missing resource identity remain explicit syntax shapes, not fake resources', () => {
  const bundle = analyseManifestBundle('---\n---\n42\n---\n- item\n---\n{}\n', 'yaml'); assert.deepEqual(bundle.documents.map(doc => doc.shape), ['empty', 'scalar', 'sequence', 'mapping']); assert.ok(bundle.documents.every(doc => doc.kind === undefined));
});
test('JSON is one strict document; large number lexemes and text are not rounded or rewritten', () => {
  const text = '{"apiVersion":"v1","kind":"Pod","count":9007199254740993,"fraction":1e400,"negative":-0}'; const bundle = analyseManifestBundle(text, 'json'); assert.equal(bundle.documents.length, 1); const buffer = new DocumentBuffer(text, { ...origin, format: 'json' }); buffer.analyse(); assert.equal(buffer.state.text, text); assert.equal(bufferDocumentText(buffer.state), text);
});
test('JSON format rejects YAML syntax, multiple JSON roots, duplicate decoded keys and non-JSON trailing commas', () => {
  for (const text of ['kind: Pod', '{}\n---\n{}', '{} {}', '{"a":1,"\\u0061":2}', '{"a":1,}', '{"a":NaN}']) assert.throws(() => analyseManifestBundle(text, 'json'), /CONTENT_INVALID/);
});
test('malformed/duplicate YAML or unsafe map keys fail whole with fixed errors, never a partial admitted bundle', () => {
  for (const text of [stream + 'bad: [', first + 'kind: Pod\n', '1: value\n', '? [a,b]\n: value\n', '"bad\\nkey": x\n']) assert.throws(() => analyseManifestBundle(text, 'yaml'), /CONTENT_INVALID/);
});
test('aliases, even unused anchors, custom/explicit tags and YAML1.1 directives do not execute or resolve', () => {
  for (const text of ['a: &x {a: 1}\nb: *x\n', 'a: &unused 1\n', 'a: !private value\n', 'a: !!binary SGVsbG8=\n', '%YAML 1.1\n---\na: yes\n']) assert.throws(() => analyseManifestBundle(text, 'yaml'), /CONTENT_INVALID/);
});
test('non-BMP source offsets use UTF-16 consistently and analysis does not expose scalar values', () => {
  const text = first + 'data: {x: "😀"}\n---\n' + second, bundle = analyseManifestBundle(text, 'yaml'); assert.equal(JSON.stringify(bundle).includes('😀'), false); const selected = bundle.documents[1]; assert.ok(selected); assert.ok(text.slice(selected.start, selected.end).includes('name: second'));
});
test('bad raw/escaped Unicode fails fixed, not through parser exception text or replacement characters', () => {
  for (const text of ['x: "\ud800"', 'x: "\\uD800"']) assert.throws(() => analyseManifestBundle(text, 'yaml'), /CONTENT_INVALID/);
  assert.throws(() => analyseManifestBundle('{"x":"\\ud800"}', 'json'), /CONTENT_INVALID/);
});
test('one-MiB input budget is checked before parsing and no format auto-detection bypasses it', () => {
  assert.throws(() => analyseManifestBundle('x: ' + 'a'.repeat(1_048_576), 'yaml'), /BUDGET_EXCEEDED/);
});
test('lazy composition admits 32 documents and rejects a 33rd without returning a truncated success', () => {
  assert.equal(analyseManifestBundle(Array(32).fill('{}\n').join('---\n'), 'yaml').documents.length, 32); assert.throws(() => analyseManifestBundle(Array(33).fill('{}\n').join('---\n'), 'yaml'), /BUDGET_EXCEEDED/);
});
test('AST depth and aggregate node/key budgets are shared across the whole stream', () => {
  const nested = Array.from({ length: 35 }, (_, i) => ' '.repeat(i * 2) + 'key:').join('\n') + ' value\n'; assert.throws(() => analyseManifestBundle(nested, 'yaml'), /BUDGET_EXCEEDED/);
  const text = Array.from({ length: 10001 }, (_, i) => `key${i}: value`).join('\n'); assert.throws(() => analyseManifestBundle(text, 'yaml'), /BUDGET_EXCEEDED/);
});
test('analysis summaries and documents are immutable and never retain AST nodes or data/spec output', () => {
  const bundle = analyseManifestBundle(stream, 'yaml'); assert.ok(Object.isFrozen(bundle)); assert.ok(Object.isFrozen(bundle.documents)); assert.ok(bundle.documents.every(Object.isFrozen)); assert.ok(bundle.documents.every(doc => !('contents' in doc) && !('spec' in doc) && !('data' in doc)));
});
test('buffer construction and ordinary editing do not analyse automatically; explicit analysis is local and clean', () => {
  const buffer = new DocumentBuffer(first, origin), initial = buffer.state; assert.equal(initial.analysis, undefined); buffer.analyse(); assert.equal(buffer.state.dirty, false); assert.equal(buffer.state.revision, 1); assert.equal(buffer.state.analysis?.documents.length, 1);
});
test('document selection changes revision but neither text, dirty nor immutable original resource/target identity', () => {
  const buffer = new DocumentBuffer(stream, origin); buffer.analyse(); const before = buffer.state; buffer.selectDocument(1); assert.equal(buffer.state.revision, before.revision + 1); assert.equal(buffer.state.text, stream); assert.equal(buffer.state.dirty, false); assert.equal(buffer.state.origin, before.origin); assert.equal(buffer.state.origin.reference.name, 'first'); assert.ok(bufferDocumentText(buffer.state).includes('name: second'));
});
test('same-document selection is a no-op and malformed/out-of-range or unanalysed selection cannot mutate state', () => {
  const buffer = new DocumentBuffer(stream, origin); assert.throws(() => buffer.selectDocument(1), /INVALID_INPUT/); buffer.analyse(); const revision = buffer.state.revision;
  buffer.selectDocument(0); assert.equal(buffer.state.revision, revision); for (const index of [-1, 2, 1.5, NaN, Infinity]) assert.throws(() => buffer.selectDocument(index), /INVALID_INPUT/); assert.equal(buffer.state.revision, revision);
});
test('editing invalidates the entire parsed inventory and active selection; revert restores baseline without network or serialization', () => {
  const buffer = new DocumentBuffer(first, origin); buffer.edit(stream); buffer.analyse(); buffer.selectDocument(1); buffer.edit(stream + '\n'); assert.equal(buffer.state.analysis, undefined); assert.equal(buffer.state.activeDocument, 0); assert.equal(buffer.state.dirty, true); buffer.revert(); assert.equal(buffer.state.text, first); assert.equal(buffer.state.dirty, false);
});
test('failed analysis preserves exact edited bytes and never substitutes an older valid parsed document', () => {
  const buffer = new DocumentBuffer(first, origin); buffer.analyse(); buffer.edit('bad: ['); const before = buffer.state; assert.throws(() => buffer.analyse(), /CONTENT_INVALID/); assert.equal(buffer.state.text, before.text); assert.equal(buffer.state.revision, before.revision); assert.equal(buffer.state.analysis, undefined);
});
test('selected matching-GVK document feeds its own field inventory and only metadata goes to Explain', () => {
  const buffer = new DocumentBuffer(first, origin); buffer.edit(stream); buffer.analyse(); buffer.selectDocument(1); const fields = documentFields(bufferDocumentText(buffer.state), origin.reference.type), selected = fields.find(field => field.path.join('.') === 'spec.restartPolicy'); assert.ok(selected); const request = explanationRequest(state(buffer), selected.id, buffer.state.revision); assert.deepEqual(request.fieldPath, ['spec', 'restartPolicy']); assert.equal(request.target.namespace, 'default'); assert.equal(JSON.stringify(request).includes(secret), false); assert.equal('text' in request, false);
});
test('old field IDs/revisions cannot survive document switching, even when two documents have identical GVKs', () => {
  const buffer = new DocumentBuffer(stream, origin); buffer.analyse(); const previous = buffer.state.revision; buffer.selectDocument(1); assert.throws(() => explanationRequest(state(buffer), '0', previous), /STALE_TARGET/);
});
test('other-GVK, empty or nonmapping selected documents do not guess a new Explain target or schema', () => {
  for (const document of [second.replace('kind: Pod', 'kind: Service'), 'null\n', '- item\n']) { const buffer = new DocumentBuffer(first + '---\n' + document, origin); buffer.analyse(); buffer.selectDocument(1); assert.throws(() => explanationRequest(state(buffer), '0', buffer.state.revision), /CONTENT_INVALID/); }
});
test('legacy single-document Explain stays supported while unsplit multi-document input is still refused', () => {
  const buffer = new DocumentBuffer(first, origin); assert.deepEqual(explanationRequest(state(buffer), '0', 0).fieldPath, []); assert.throws(() => documentFields(stream, origin.reference.type), /CONTENT_INVALID/);
});
test('synthetic document client analysis/selection uses zero transport calls beyond the original explicit read', async () => {
  let calls = 0; const states: DocumentState[] = [], page = { ...origin, protocol: 2, kind: 'resource-document', text: first, totalBytes: Buffer.byteLength(first), totalCharacters: first.length, offset: 0, end: first.length, nextCursor: null };
  const client = new DocumentClient(async () => { calls++; return { status: 200, body: JSON.stringify(page) }; }, value => states.push(value));
  try { await client.read({ target: origin.target, reference: origin.reference, format: origin.format, protocol: 2, selection: { mode: 'default' } }); client.edit(stream); client.analyse(); client.selectDocument(1); assert.equal(calls, 1); assert.equal(states.at(-1)?.editor?.activeDocument, 1); assert.equal(states.at(-1)?.editor?.analysis?.documents.length, 2); assert.equal(states.at(-1)?.editor?.dirty, true); client.close(); assert.equal(states.at(-1)?.error, 'DOCUMENT_DIRTY'); client.close(true); assert.equal(states.at(-1)?.editor, undefined); } finally { client.dispose(); }
});
test('empty syntax documents are distinct from explicit YAML null and scalar strings', () => {
  assert.equal(analyseManifestBundle('# only comment\n', 'yaml').documents[0]?.shape, 'empty'); assert.equal(analyseManifestBundle('null\n', 'yaml').documents[0]?.shape, 'scalar'); assert.equal(analyseManifestBundle("''\n", 'yaml').documents[0]?.shape, 'scalar');
});
test('explicit reanalysis resets local selection and invalidates requests without making unchanged text dirty', () => {
  const buffer = new DocumentBuffer(stream, origin); buffer.analyse(); buffer.selectDocument(1); const revision = buffer.state.revision; buffer.analyse(); assert.equal(buffer.state.activeDocument, 0); assert.equal(buffer.state.revision, revision + 1); assert.equal(buffer.state.dirty, false); assert.equal(buffer.state.text, stream);
});
test('portable summary contract rejects forged spans, unknown body fields and incompatible format/length before buffer admission', () => {
  const bundle = analyseManifestBundle(first, 'yaml');
  for (const change of [{ text: secret }, { documents: [{ ...bundle.documents[0], end: first.length + 1 }] }, { documents: [{ ...bundle.documents[0], index: 1 }] }]) assert.throws(() => readManifestBundle({ ...bundle, ...change }), /CONTENT_INVALID/);
  const buffer = new DetachedBuffer(first, origin); assert.throws(() => buffer.analyse({ ...bundle, format: 'json' }), /STALE_TARGET/); assert.throws(() => buffer.analyse({ ...bundle, characters: first.length + 1 }), /STALE_TARGET/); assert.equal(buffer.state.revision, 0);
});
