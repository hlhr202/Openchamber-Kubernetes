// Pure parsing/value models and an independent synthetic GET client only. No operation/adapter/SDK/FS or mock write lifecycle.
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { compareThreeWayJson } from '../../src/shared/json-merge-comparison.ts';
import { parseDocumentJson, documentProperty, documentString } from '../../src/shared/document-json.ts';
import { parseManifestValues } from '../../src/parsing/manifest-values.ts';
import { reviewManifestJsonMerge } from '../../src/parsing/manifest-merge-review.ts';
import { ManifestDiffClient } from '../../src/host/manifest-diff-client.ts';
import type { DiffSource, ManifestDiffState } from '../../src/host/manifest-diff-client.ts';
const annotation = 'kubectl.kubernetes.io/last-applied-configuration';
const reference = { type: { group: 'example.io', version: 'v1', resource: 'widgets', kind: 'Widget', scope: 'namespace' as const }, name: 'sample', namespace: 'default' };
const observed = { uid: 'same-uid', resourceVersion: '5' };
const resource = (extra: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) => ({ apiVersion: 'example.io/v1', kind: 'Widget', metadata: { name: 'sample', namespace: 'default', ...metadata }, ...extra });
const json = JSON.stringify;
const live = (extra: Record<string, unknown> = {}, original?: string) => json(resource(extra, { ...observed, ...(original === undefined ? {} : { annotations: { [annotation]: original } }) }));
const model = (original: unknown, desired: unknown, current: unknown) => compareThreeWayJson(json(original), json(desired), json(current));
const values = (text: string) => JSON.parse(text) as unknown;
describe('pure three-way JSON value model', { timeout: 10_000 }, () => {
test('owned deletions are distinct from absent unowned live keys, including nested fields', () => {
  const result = model({ spec: { owned: 1, keep: 'old' } }, { spec: { keep: 'new' } }, { spec: { owned: 2, keep: 'old', external: 'retain' }, status: { ready: true } });
  assert.deepEqual(values(result.delta), { spec: { owned: null, keep: 'new' } }); assert.deepEqual(values(result.result), { spec: { keep: 'new', external: 'retain' }, status: { ready: true } }); assert.equal(result.equal, false);
});
test('an empty ownership baseline preserves server fields while the desired value wins an explicitly managed external change', () => {
  const result = model({}, { spec: { managed: 1 } }, { spec: { managed: 2, external: 3 }, extra: true });
  assert.deepEqual(values(result.result), { spec: { managed: 1, external: 3 }, extra: true });
});
test('empty current, empty desired and fully unchanged values are distinct model states', () => {
  assert.deepEqual(values(model({}, { a: 1 }, {}).result), { a: 1 });
  assert.deepEqual(values(model({ a: 1 }, {}, { a: 2, external: 3 }).result), { external: 3 });
  const result = model({ a: 1 }, { a: 1 }, { a: 1 }); assert.equal(result.equal, true); assert.deepEqual(values(result.delta), {});
});
test('explicit null is not omission: new null enters the deletion delta, while unchanged old null does not', () => {
  assert.deepEqual(values(model({}, {}, { x: 1 }).result), { x: 1 });
  assert.deepEqual(values(model({}, { x: null }, { x: 1 }).result), {});
  assert.deepEqual(values(model({ x: 2 }, { x: null }, { x: 1 }).delta), { x: null });
  assert.deepEqual(values(model({ x: null }, { x: null }, { x: 1 }).result), { x: 1 });
});
test('empty maps are values in additions but do not delete unrelated nested live fields', () => {
  assert.deepEqual(values(model({}, { map: {} }, { map: 1 }).result), { map: {} });
  assert.deepEqual(values(model({}, { map: {} }, { map: { external: 1 } }).result), { map: { external: 1 } });
  assert.deepEqual(values(model({ map: { old: 1 } }, { map: {} }, { map: { old: 2, external: 3 } }).result), { map: { external: 3 } });
});
test('arrays are atomic replacements in this model, never strategic merge-key lists', () => {
  const result = model({ containers: [{ name: 'main', image: 'a' }] }, { containers: [{ name: 'main', image: 'b' }] }, { containers: [{ name: 'main', image: 'a' }, { name: 'sidecar', image: 'other' }] });
  assert.deepEqual(values(result.result), { containers: [{ name: 'main', image: 'b' }] });
  assert.deepEqual(values(model({}, { list: [null, { x: null }] }, {}).result), { list: [null, { x: null }] });
});
test('scalar/object/array transitions follow JSON merge values without mutating input texts', () => {
  for (const desired of [false, 0, '', []]) {
    const original = '{"field":{"old":1}}', modified = json({ field: desired }), current = '{"field":{"old":2,"external":3}}';
    const result = compareThreeWayJson(original, modified, current); assert.deepEqual(values(result.result), { field: desired }); assert.equal(original, '{"field":{"old":1}}');
  }
  assert.deepEqual(values(model({ field: { old: 1 } }, { field: { next: true } }, { field: { old: 2, external: 3 } }).result), { field: { next: true, external: 3 } });
});
test('lossless model preserves int64/decimal/exponent lexemes and does not round adjacent integer values into equality', () => {
  const result = compareThreeWayJson('{"n":9007199254740992}', '{"n":9007199254740993,"e":1.20e+21}', '{"n":9007199254740992}');
  assert.ok(result.delta.includes('9007199254740993') && result.result.includes('1.20e+21')); assert.equal(result.equal, false);
});
test('exact decimal equality ignores object ordering and equivalent number spellings without evaluating huge powers', () => {
  const result = compareThreeWayJson('{}', '{"n":1.00e1000000,"z":-0.000,"v":12.30}', '{"v":123e-1,"z":0,"n":10e999999}');
  assert.equal(result.equal, true); assert.deepEqual(values(result.delta), {});
  assert.throws(() => compareThreeWayJson('{}', `{"n":1e${'9'.repeat(129)}}`, '{"n":1}'), /BUDGET_EXCEEDED/);
});
test('prototype-like property names are data, not JS object mutation or inherited ownership', () => {
  const result = compareThreeWayJson('{"__proto__":{"owned":1}}', '{"constructor":{"prototype":2}}', '{"__proto__":{"owned":3},"external":4}');
  const parsed = parseDocumentJson(result.result); assert.equal(documentProperty(parsed, '__proto__'), undefined); assert.ok(documentProperty(parsed, 'constructor')); assert.equal(({} as { owned?: unknown }).owned, undefined);
});
test('malformed JSON, decoded duplicate keys and nonobject roots are rejected, not modeled as no change', () => {
  for (const text of ['{"x":1,"\\u0078":2}', '{', 'null', '[]', '1', '"str"']) assert.throws(() => compareThreeWayJson('{}', text, '{}'), /CONTENT_INVALID/);
});
test('each input/output and traversal has a finite budget', () => {
  assert.throws(() => compareThreeWayJson('{}', json({ body: 'x'.repeat(1_048_576) }), '{}'), /BUDGET_EXCEEDED/);
  assert.throws(() => compareThreeWayJson('{}', '{"deep":'.repeat(65) + '0' + '}'.repeat(65), '{}'), /BUDGET_EXCEEDED/);
  const huge = json({ n: 'x'.repeat(600_000) }); assert.throws(() => compareThreeWayJson('{}', huge, json({ m: 'y'.repeat(600_000) })), /BUDGET_EXCEEDED/);
});
test('shared YAML values retain BOM/CRLF/numeric source and reject aliases, duplicate keys and invalid namespaces', () => {
  const values = parseManifestValues('\ufeff# before\r\napiVersion: example.io/v1\r\nkind: Widget\r\nmetadata: {name: sample}\r\nn: 9007199254740993\r\ne: 1.20e+21\r\n', 'yaml');
  assert.equal(documentProperty(values[0], 'n')?.kind, 'atom'); assert.deepEqual(documentProperty(values[0], 'n'), { kind: 'atom', text: '9007199254740993' });
  for (const text of ['a: &a 1\nb: *a', 'a: 1\na: 2', 'metadata: {name: sample, namespace: null}']) assert.throws(() => parseManifestValues(text, 'yaml'), /CONTENT_INVALID/);
});
});
describe('local last-applied model review', { timeout: 10_000 }, () => {
test('actual captured last-applied controls owned deletions; absent annotation retains unowned live fields', () => {
  const desired = json(resource({ spec: { next: 2 } })), original = json(resource({ spec: { old: 1 } }));
  const result = reviewManifestJsonMerge(desired, live({ spec: { old: 3, external: true } }, original), 'json', reference, observed);
  assert.equal(result.baseline, 'annotation'); assert.deepEqual((values(result.comparison.result) as { spec: unknown }).spec, { next: 2, external: true });
  const absent = reviewManifestJsonMerge(desired, live({ spec: { old: 3 } }), 'json', reference, observed); assert.equal(absent.baseline, 'absent'); assert.deepEqual((values(absent.comparison.result) as { spec: unknown }).spec, { old: 3, next: 2 });
});
test('new last-applied encoding removes old annotation before serialization and preserves other annotations without recursion', () => {
  const local = json(resource({}, { annotations: { [annotation]: 'IGNORE_LOCAL_OLD', other: 'retain' } }));
  const result = reviewManifestJsonMerge(local, live(), 'json', reference, observed), node = parseDocumentJson(result.comparison.result), annotations = documentProperty(documentProperty(node, 'metadata'), 'annotations');
  const baseline = documentString(documentProperty(annotations, annotation)); assert.ok(baseline); assert.ok(!baseline.includes('IGNORE_LOCAL_OLD') && !baseline.includes(annotation)); assert.equal(documentString(documentProperty(annotations, 'other')), 'retain');
});
test('annotation-only change is separate from no literal text difference or user field differences', () => {
  const local = json(resource()); const first = reviewManifestJsonMerge(local, live(), 'json', reference, observed);
  assert.equal(first.annotationWillChange, true); const node = parseDocumentJson(first.comparison.result), annotations = documentProperty(documentProperty(node, 'metadata'), 'annotations'), encoded = documentString(documentProperty(annotations, annotation)); assert.ok(encoded);
  const same = reviewManifestJsonMerge(local, live({}, encoded), 'json', reference, observed); assert.equal(same.annotationWillChange, false); assert.equal(same.comparison.equal, true);
});
test('model pins captured live UID/RV and any explicit desired UID/RV, rather than adopting a same-name replacement', () => {
  assert.throws(() => reviewManifestJsonMerge(json(resource()), live(), 'json', reference, { ...observed, uid: 'new' }), /STALE_TARGET/);
  for (const metadata of [{ uid: 'other' }, { resourceVersion: '4' }]) assert.throws(() => reviewManifestJsonMerge(json(resource({}, metadata)), live(), 'json', reference, observed), /CONFLICT/);
});
test('old baseline RV is historical, but an old baseline UID from a replaced object is not silently adopted', () => {
  assert.equal(reviewManifestJsonMerge(json(resource()), live({}, json(resource({}, { uid: observed.uid, resourceVersion: '1' }))), 'json', reference, observed).baseline, 'annotation');
  assert.throws(() => reviewManifestJsonMerge(json(resource()), live({}, json(resource({}, { uid: 'deleted-uid' }))), 'json', reference, observed), /CONFLICT/);
});
test('exact API/name/namespace identity is checked for live, desired and ownership baseline', () => {
  for (const local of [resource({}, { name: 'other' }), resource({}, { namespace: 'other' }), { ...resource(), kind: 'Other' }, { ...resource(), apiVersion: 'example.io/v2' }]) assert.throws(() => reviewManifestJsonMerge(json(local), live(), 'json', reference, observed), /STALE_TARGET/);
  assert.throws(() => reviewManifestJsonMerge(json(resource()), live({}, json(resource({}, { name: 'other' }))), 'json', reference, observed), /STALE_TARGET/);
});
test('implicit desired namespace is bound to captured reference; cluster scope never defaults to the active namespace', () => {
  const local = 'apiVersion: example.io/v1\nkind: Widget\nmetadata: {name: sample}\n';
  const current = `apiVersion: example.io/v1\nkind: Widget\nmetadata: {name: sample, namespace: default, uid: same-uid, resourceVersion: "5"}\n`;
  assert.equal(reviewManifestJsonMerge(local, current, 'yaml', reference, observed).uid, observed.uid);
  const cluster = { type: { ...reference.type, scope: 'cluster' as const }, name: reference.name };
  const unscoped = json({ ...resource(), metadata: { name: 'sample', ...observed } }); assert.equal(reviewManifestJsonMerge(unscoped, unscoped, 'json', cluster, observed).uid, observed.uid);
  assert.throws(() => reviewManifestJsonMerge(json(resource()), unscoped, 'json', cluster, observed), /STALE_TARGET/);
});
test('malformed/nonobject/foreign/duplicated last-applied and nonstring annotations fail visibly, never an empty baseline', () => {
  for (const original of ['{', 'null', '[]', '{"a":1,"a":2}', json({ ...resource(), apiVersion: 'other.io/v1' })]) assert.throws(() => reviewManifestJsonMerge(json(resource()), live({}, original), 'json', reference, observed), /CONTENT_INVALID|STALE_TARGET/);
  const invalid = json(resource({}, { ...observed, annotations: { [annotation]: 1 } })); assert.throws(() => reviewManifestJsonMerge(json(resource()), invalid, 'json', reference, observed), /CONTENT_INVALID/);
});
test('empty annotation is absent ownership, while oversized annotation/model and multi-document selection fail closed', () => {
  assert.equal(reviewManifestJsonMerge(json(resource()), live({}, ''), 'json', reference, observed).baseline, 'absent');
  assert.throws(() => reviewManifestJsonMerge(json(resource()), live({}, ' '.repeat(262_145)), 'json', reference, observed), /CONTENT_INVALID/);
  assert.throws(() => reviewManifestJsonMerge(json(resource({ body: 'x'.repeat(262_144) })), live(), 'json', reference, observed), /BUDGET_EXCEEDED/);
  assert.throws(() => reviewManifestJsonMerge('apiVersion: v1\n---\napiVersion: v1\n', live(), 'yaml', reference, observed), /CONTENT_INVALID/);
});
});
async function clientFixture(documents = 1) {
  const target = { serviceGeneration: 'service', projectId: 'view', configIdentity: 'config', context: 'active', namespace: 'default' };
  let source: DiffSource | undefined = { owner: {}, revision: 0, target, selection: { mode: 'default' }, text: Array.from({ length: documents }, () => 'apiVersion: example.io/v1\nkind: Widget\nmetadata: {name: sample, namespace: default}\n').join('---\n'), format: 'yaml' };
  const states: ManifestDiffState[] = [], calls: string[] = []; let missing = false;
  const client = new ManifestDiffClient(async input => {
    calls.push(input.body); const request = JSON.parse(input.body) as { target: unknown; locator: unknown; format: string };
    const text = 'apiVersion: example.io/v1\nkind: Widget\nmetadata: {name: sample, namespace: default, uid: same-uid, resourceVersion: "5"}\nspec: {external: true}\n';
    const common = { protocol: 2, target: request.target, locator: request.locator, format: request.format, reference };
    return { status: 200, body: json(missing ? { ...common, kind: 'comparison-missing' } : { ...common, kind: 'live-comparison', ...observed, identity: 'a'.repeat(64), expiresAt: Date.now() + 60_000, totalBytes: text.length, totalCharacters: text.length, offset: 0, end: text.length, text, nextCursor: null }) };
  }, () => source, state => states.push(state));
  await client.read('file', 'yaml');
  return { client, calls, last() { const state = states.at(-1); assert.ok(state); return state; }, missing() { missing = true; }, change() { assert.ok(source); source = { ...source, revision: source.revision + 1 }; } };
}
describe('explicit read-only client model', { timeout: 10_000 }, () => {
test('model is opt-in and consumes captured values only: no second RPC or local body upload', async () => {
  const f = await clientFixture(); assert.equal(f.last().phase, 'ready'); assert.equal(f.last().documents[0]?.mergeReview, undefined); const count = f.calls.length;
  f.client.inspectJsonMerge(0); assert.equal(f.last().documents[0]?.mergeReview?.kind, 'json-merge-model-only'); assert.equal(f.calls.length, count); assert.ok(!f.calls[0]?.includes('external')); f.client.dispose();
});
test('at most one bounded selected-document model is retained, not32 doubled live copies', async () => {
  const f = await clientFixture(2); f.client.inspectJsonMerge(0); assert.ok(f.last().documents[0]?.mergeReview); f.client.inspectJsonMerge(1);
  assert.equal(f.last().documents[0]?.mergeReview, undefined); assert.ok(f.last().documents[1]?.mergeReview); assert.equal(f.calls.length, 2); f.client.dispose();
});
test('source drift clears models/refuses stale review, while reset/dispose release captured model buffers', async () => {
  const f = await clientFixture(); f.client.inspectJsonMerge(0); f.change(); f.client.inspectJsonMerge(0); assert.equal(f.last().phase, 'error'); assert.equal(f.last().stale, true); assert.equal(f.last().documents[0]?.mergeReview, undefined);
  f.client.reset(); assert.deepEqual(f.last().documents, []); f.client.dispose();
});
test('missing objects are not silently modeled or turned into Create; invalid indices do not add reads', async () => {
  const f = await clientFixture(); f.missing(); await f.client.read('file', 'yaml'); assert.equal(f.last().documents[0]?.phase, 'missing'); const count = f.calls.length;
  for (const index of [0, -1, 32, NaN, 0.5]) f.client.inspectJsonMerge(index); assert.equal(f.calls.length, count); assert.equal(f.last().documents[0]?.mergeReview, undefined); f.client.dispose();
});
});
