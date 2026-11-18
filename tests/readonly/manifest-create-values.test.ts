// Pure values/synthetic GET proof only. Never import a Create client/controller/worker/adapter or call prepare/begin/submit/status/cancel.
import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeCreateSource } from '../../src/host/manifest-create-source.ts';
import { readCreatePayload } from '../../src/shared/manifest-create-payload.ts';
import { manifestCreateRequestSchema, createOutcomeSchema } from '../../src/shared/manifest-create-protocol.ts';
import { readManifestCreateProof } from '../../src/service/queries/manifest-create-proof.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { treeQueryAffectedByCreate } from '../../src/shared/tree-create-effect.ts';
import type { ResourceReadRequest, ResourceReadTransport } from '../../src/service/queries/resource-reader.ts';
const target = { serviceGeneration: '00000000-0000-4000-8000-000000000001', projectId: 'synthetic', configIdentity: 'synthetic-configuration', context: 'active', namespace: 'default' };
const locator = { group: '', version: 'v1', kind: 'ConfigMap', name: 'sample' };
const yaml = 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: sample}\ndata: {literal: "<script>synthetic only</script>"}\n';
function fixture() {
  let status = 404, calls = 0, closed = 0, iterated = false, drift = false, scope = true, verbs = ['get', 'create'];
  const requests: ResourceReadRequest[] = [];
  const read: ResourceReadTransport = async request => {
    requests.push(request); kubectlReadArguments(request, '/synthetic/configuration.pipe');
    const discovery = request.purpose === 'api-version', responseStatus = discovery ? 200 : status;
    const body = JSON.stringify({ groupVersion: 'v1', resources: [{ name: drift && calls++ > 0 ? 'others' : 'configmaps', kind: 'ConfigMap', namespaced: scope, verbs }] });
    return { status: responseStatus, body: { async *[Symbol.asyncIterator]() { if (!discovery) { iterated = true; throw new Error('Never iterate existence/error body'); } yield Buffer.from(body); } }, close: async () => { closed++; } };
  };
  return { read, requests, responseStatus(value: number) { status = value; }, drift() { drift = true; }, scope(value: boolean) { scope = value; }, verbs(value: string[]) { verbs = value; }, closes: () => closed, iterated: () => iterated };
}
const signal = () => new AbortController().signal;
test('local Create encoding only constructs strict JSON values; text stays inert and exact large numeric lexemes survive', () => {
  const text = yaml + 'values: {large: 9007199254740993, exponent: 1.20e+21, minus: -0, decimal: 0.1234567890123456789}\n';
  const payload = encodeCreateSource(text, 'yaml'), values = readCreatePayload(payload); assert.equal(values.length, 1); assert.deepEqual(values[0]?.locator, locator);
  for (const literal of ['9007199254740993', '1.20e+21', '-0', '0.1234567890123456789', '<script>synthetic only</script>']) assert.ok(payload.includes(literal));
});
test('JSON payload encoding does not round int64 or decoded strings and rejects duplicate decoded keys', () => {
  const input = '{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"sample"},"n":9007199254740993}'; assert.ok(encodeCreateSource(input, 'json').includes('9007199254740993'));
  assert.throws(() => encodeCreateSource(input.replace('"n":', '"kind":"Other","n":'), 'json'), /CONTENT_INVALID/);
});
test('multi-document and nested v1 List flatten into bounded ordered independent values, never an execution chain', () => {
  const input = 'apiVersion: v1\nkind: List\nitems:\n  - apiVersion: v1\n    kind: List\n    items:\n      - apiVersion: v1\n        kind: ConfigMap\n        metadata: {name: first}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: second}\n';
  assert.deepEqual(readCreatePayload(encodeCreateSource(input, 'yaml')).map(item => item.locator.name), ['first', 'second']);
});
test('selection encoding captures only the explicit nonempty UTF16 range and refuses broken surrogate/negative/empty ranges', () => {
  const input = `not a manifest\n${yaml}invalid suffix`;
  assert.equal(readCreatePayload(encodeCreateSource(input, 'yaml', { start: 15, end: 15 + yaml.length })).length, 1);
  for (const selection of [{ start: -1, end: 1 }, { start: 0, end: 0 }, { start: 0, end: 9999 }]) assert.throws(() => encodeCreateSource(yaml, 'yaml', selection), /INVALID_INPUT/);
  assert.throws(() => encodeCreateSource('😀', 'yaml', { start: 0, end: 1 }), /CONTENT_INVALID/);
});
test('Create local parser rejects unsafe YAML aliases/tags/anchors/duplicate maps and nonfinite numeric values without a transport', () => {
  for (const tail of ['x: &a 1\ny: *a\n', 'x: !!str tagged\n', 'x: 1\nx: 2\n', 'x: .inf\n', 'x: .nan\n']) assert.throws(() => encodeCreateSource(yaml + tail, 'yaml'), /CONTENT_INVALID/);
});
test('present invalid namespace is not silently omitted or made the active namespace, while explicit other namespace remains explicit', () => {
  for (const value of ['null', 'false', '123', '[]', '{}', '""', '"../escape"']) assert.throws(() => encodeCreateSource(yaml.replace('{name: sample}', `{name: sample, namespace: ${value}}`), 'yaml'), /CONTENT_INVALID/);
  assert.equal(readCreatePayload(encodeCreateSource(yaml.replace('{name: sample}', '{name: sample, namespace: other}'), 'yaml'))[0]?.locator.namespace, 'other');
});
test('Create refuses inherited live identity, generateName and managedFields instead of stripping or repurposing them', () => {
  for (const key of ['uid', 'resourceVersion', 'generateName', 'managedFields', 'deletionTimestamp']) assert.throws(() => encodeCreateSource(yaml.replace('{name: sample}', `{name: sample, ${key}: value}`), 'yaml'), /CONTENT_INVALID/);
});
test('Create envelope cannot be arbitrary argv/URL/body or a nested List and requires a named exact locator', () => {
  for (const input of ['[]', '{}', '{"documents":[]}', '{"documents":[{}]}', '{"documents":[],"argv":["create"]}', '{"documents":[{"apiVersion":"v1","kind":"List","items":[]}]}']) assert.throws(() => readCreatePayload(input), /CONTENT_INVALID/);
  assert.throws(() => encodeCreateSource('apiVersion: v1\nkind: ConfigMap\nmetadata: {generateName: generated-}\n', 'yaml'), /CONTENT_INVALID/);
});
test('pure encoding is bounded to32 flattened items/1MiB and rejects deep or malformed structures, not partial success', () => {
  assert.throws(() => encodeCreateSource(Array.from({ length: 33 }, () => yaml).join('---\n'), 'yaml'), /BUDGET_EXCEEDED/);
  assert.throws(() => encodeCreateSource(yaml + 'x: ' + 'a'.repeat(1_048_576), 'yaml'), /CONTENT_INVALID/);
  assert.throws(() => encodeCreateSource(' \n', 'yaml'), /CONTENT_INVALID/);
});
test('pure YAML numeric normalization never serializes a rounded float or coerces quoted numbers', () => {
  const payload = encodeCreateSource(yaml + 'a: 0x20000000000001\nb: +0.1234567890123456789\nc: .1234567890123456789\nd: "9007199254740993"\n', 'yaml');
  assert.ok(payload.includes('9007199254740993') && payload.includes('0.1234567890123456789') && payload.includes('"9007199254740993"'));
});
test('Create DTO has independent write grants/explicit confirmation, no Diff cursor/readscope/argv or arbitrary operation name', () => {
  const begin = { protocol: 2, kind: 'begin', requestId: '00000000-0000-4000-8000-000000000002', target, selection: { mode: 'default' }, source: { kind: 'scratch', identity: 'a'.repeat(64), revision: 0 }, bytes: 10, digest: 'b'.repeat(64) };
  assert.equal(manifestCreateRequestSchema.safeParse(begin).success, true);
  for (const extra of [{ text: 'body' }, { cursor: 'diff-token' }, { scope: 'read-scope' }, { argv: ['apply'] }, { kind: 'apply' }]) assert.equal(manifestCreateRequestSchema.safeParse({ ...begin, ...extra }).success, false);
  const grant = { id: begin.requestId, generation: target.serviceGeneration, capability: 'a'.repeat(64), expiresAt: 60_000 };
  assert.equal(manifestCreateRequestSchema.safeParse({ protocol: 2, kind: 'submit', grant, confirmation: 'create-exact-documents' }).success, true);
  assert.equal(manifestCreateRequestSchema.safeParse({ protocol: 2, kind: 'submit', grant, confirmation: 'save-exact-snapshot' }).success, false);
});
test('pure result DTO refuses false success/unknown accounting and body/secret leakage', () => {
  const value = { id: '00000000-0000-4000-8000-000000000003', generation: target.serviceGeneration, requestId: '00000000-0000-4000-8000-000000000002', target,
    source: { kind: 'scratch', identity: 'a'.repeat(64), revision: 0 }, bytes: 10, digest: 'b'.repeat(64), received: 0, createdAt: 0, updatedAt: 0, expiresAt: 60_000, phase: 'uploading', steps: [], cleanup: 'none' };
  assert.equal(createOutcomeSchema.safeParse(value).success, true);
  for (const extra of [{ phase: 'succeeded' }, { phase: 'unknown' }, { received: 11 }, { body: 'synthetic-secret' }]) assert.equal(createOutcomeSchema.safeParse({ ...value, ...extra }).success, false);
});
test('independent GET proof brackets exact nonexistence with fresh discovery, never consumes a missing/error object body', async () => {
  const f = fixture(); let verifies = 0; const reference = await readManifestCreateProof(target, locator, signal(), f.read, async () => { verifies++; });
  assert.equal(reference.namespace, 'default'); assert.deepEqual(f.requests.map(request => request.purpose), ['api-version', 'manifest-create-proof', 'api-version']); assert.equal(f.closes(), 3); assert.equal(f.iterated(), false); assert.equal(verifies, 2);
});
test('independent existence check conflicts on200 without iterating even a sensitive existing Secret object', async () => {
  const f = fixture(); f.responseStatus(200); await assert.rejects(readManifestCreateProof(target, locator, signal(), f.read, async () => {}), /CONFLICT/); assert.equal(f.iterated(), false); assert.equal(f.closes(), 2);
});
test('403/401/429 are not absence, never iterate error bodies or retry/prepare a Create', async () => {
  for (const [status, code] of [[403, 'FORBIDDEN'], [401, 'UNAUTHENTICATED'], [429, 'QUERY_LIMIT']] as const) {
    const f = fixture(); f.responseStatus(status); await assert.rejects(readManifestCreateProof(target, locator, signal(), f.read, async () => {}), new RegExp(code)); assert.equal(f.iterated(), false); assert.equal(f.requests.length, 2);
  }
});
test('API get+create capability/routing must agree before and after absence proof; get-only discovery does not authorize Create', async () => {
  const f = fixture(); f.verbs(['get']); await assert.rejects(readManifestCreateProof(target, locator, signal(), f.read, async () => {}), /RESOURCE_INVALID/); assert.equal(f.requests.length, 1);
  const drift = fixture(); drift.drift(); await assert.rejects(readManifestCreateProof(target, locator, signal(), drift.read, async () => {}), /STALE_TARGET/);
});
test('explicit namespace proof routes only there; cluster resource cannot carry namespace', async () => {
  const f = fixture(); const reference = await readManifestCreateProof(target, { ...locator, namespace: 'other' }, signal(), f.read, async () => {}); assert.equal(reference.namespace, 'other'); assert.equal(f.requests[1]?.path, '/api/v1/namespaces/other/configmaps/sample');
  const cluster = fixture(); cluster.scope(false); await assert.rejects(readManifestCreateProof(target, { ...locator, namespace: 'other' }, signal(), cluster.read, async () => {}), /RESOURCE_INVALID/);
});
test('private GET proof purpose never opens POST/Apply/generic Load/Delete/Watch admission or accepts Diff comparison refs', () => {
  const ref = { type: { group: '', version: 'v1', resource: 'configmaps', kind: 'ConfigMap', scope: 'namespace' as const }, name: 'sample', namespace: 'default' };
  const request: ResourceReadRequest = { method: 'GET', purpose: 'manifest-create-proof', path: '/api/v1/namespaces/default/configmaps/sample', query: {}, maximumBytes: 2_000_000, target, createReference: ref };
  assert.deepEqual(kubectlReadArguments(request, '/synthetic/configuration.pipe').slice(-2), ['get', '--raw=/api/v1/namespaces/default/configmaps/sample']);
  for (const change of [{ purpose: 'manifest-diff' as const, comparison: ref }, { purpose: 'resource-object' as const }, { query: { dryRun: 'All' } }, { path: request.path + '/status' }]) assert.throws(() => kubectlReadArguments({ ...request, ...change }, '/synthetic/configuration.pipe'), /INVALID_INPUT/);
});
test('pre-cancelled and malformed locator proofs cannot touch even a synthetic transport', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(readManifestCreateProof(target, locator, controller.signal, f.read, async () => {}), /QUERY_CANCELLED/);
  await assert.rejects(readManifestCreateProof(target, { ...locator, name: '../escape' }, signal(), f.read, async () => {}), /INVALID_INPUT/); assert.equal(f.requests.length, 0);
});
test('pure Create metadata invalidates only matching target/namespace collections, not old documents or other projects', () => {
  const reference = { type: { group: '', version: 'v1', resource: 'configmaps', kind: 'ConfigMap', scope: 'namespace' as const }, name: 'sample', namespace: 'default' };
  assert.equal(treeQueryAffectedByCreate({ target, kind: 'resources', resource: 'configmaps' }, target, reference), true);
  assert.equal(treeQueryAffectedByCreate({ target, kind: 'resources', resource: 'configmaps' }, target, { ...reference, namespace: 'other' }), false);
  assert.equal(treeQueryAffectedByCreate({ target: { ...target, projectId: 'other' }, kind: 'resources', resource: 'configmaps' }, target, reference), false);
  assert.equal(treeQueryAffectedByCreate({ target, kind: 'resources', resource: 'secrets' }, target, reference), false);
});
test('pure created Pod metadata invalidates matching workload children and cross-namespace Node Pods only, without proving selector membership', () => {
  const reference = { type: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' as const }, name: 'pod', namespace: 'other' };
  const node = { resource: 'nodes' as const, name: 'node', uid: 'node', resourceVersion: '1' };
  assert.equal(treeQueryAffectedByCreate({ target, kind: 'children', parent: node }, target, reference), true);
  const parent = { resource: 'deployments' as const, name: 'workload', namespace: 'default', uid: 'workload', resourceVersion: '1' };
  assert.equal(treeQueryAffectedByCreate({ target, kind: 'children', parent }, target, reference), false);
  assert.equal(treeQueryAffectedByCreate({ target, kind: 'children', parent: { ...parent, namespace: 'other' } }, target, reference), true);
});

// ---- Approved batch-2 upgrades: generateName creates and typed List expansion ----
test('a document carries exactly one of metadata.name or metadata.generateName', () => {
  const named = JSON.stringify({ documents: [{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cm' } }] });
  const generated = JSON.stringify({ documents: [{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { generateName: 'cm' } }] });
  const namedItem = readCreatePayload(named)[0], generatedItem = readCreatePayload(generated)[0];
  assert.equal(namedItem?.generated, undefined);
  assert.equal(namedItem?.locator.name, 'cm');
  assert.equal(generatedItem?.generated, true);
  assert.equal(generatedItem?.locator.name, 'cm'); // the prefix pins the collection POST identity
  for (const bad of [
    { documents: [{ apiVersion: 'v1', kind: 'ConfigMap', metadata: {} }] }, // neither
    { documents: [{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cm', generateName: 'cm' } }] }, // both
    { documents: [{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { generateName: 'cm-' } }] }, // trailing-dash prefix: disclosed fixed rejection of this chain
  ]) assert.throws(() => readCreatePayload(JSON.stringify(bad)), /CONTENT_INVALID/);
});
test('one top-level typed List expands into individually validated documents; nested/untyped Lists are rejected', () => {
  const podList = JSON.stringify({ documents: [{ apiVersion: 'v1', kind: 'PodList', items: [
    { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'a' } }, { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'b' } }] }] });
  const expanded = readCreatePayload(podList);
  assert.equal(expanded.length, 2);
  assert.equal(expanded[0]?.locator.kind, 'Pod');
  assert.equal(expanded[1]?.locator.name, 'b');
  assert.throws(() => readCreatePayload(JSON.stringify({ documents: [{ apiVersion: 'v1', kind: 'List', items: [{ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'a' } }] }] })), /CONTENT_INVALID/); // untyped List
  assert.throws(() => readCreatePayload(JSON.stringify({ documents: [{ apiVersion: 'v1', kind: 'PodList', items: [{ apiVersion: 'v1', kind: 'PodList', items: [] }] }] })), /CONTENT_INVALID/); // nested List
  assert.throws(() => readCreatePayload(JSON.stringify({ documents: [{ apiVersion: 'v1', kind: 'PodList', items: [] }] })), /CONTENT_INVALID/); // empty items
});
