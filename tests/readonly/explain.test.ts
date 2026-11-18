// Synthetic schema/metadata/transport/local buffers only; no real worker/CLI/cache/SDK/bridge or write-chain imports/calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { ExplainClient } from '../../src/host/explain-client.ts';
import type { ExplainState } from '../../src/host/explain-client.ts';
import { documentFields, explanationRequest } from '../../src/host/document-fields.ts';
import { DocumentBuffer } from '../../src/shared/document-buffer.ts';
import type { DocumentState } from '../../src/host/document-client.ts';
import { explainRequestSchema } from '../../src/shared/explain-protocol.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { openApiLocation, projectExplanation } from '../../src/service/queries/openapi-explanation.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { parseReadWorkerResult, parseReadWorkerStart } from '../../src/service/queries/read-worker-protocol.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';

const signal = () => new AbortController().signal;
const type = { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' as const };
const reference = { type, namespace: 'default', name: 'sample', uid: 'u', resourceVersion: '1' };
const text = 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: sample\nspec:\n  containers:\n  - name: app\n    image: SYNTHETIC_SECRET\n';
const schema = () => ({ openapi: '3.0.0', components: { schemas: {
  Pod: { type: 'object', description: 'A pod.', 'x-kubernetes-group-version-kind': [{ group: '', version: 'v1', kind: 'Pod' }], required: ['spec'], properties: { spec: { $ref: '#/components/schemas/Spec' }, metadata: { type: 'object', additionalProperties: { type: 'string', description: 'Map value.' } } } },
  Spec: { type: 'object', description: 'Pod specification.', properties: { containers: { type: 'array', items: { $ref: '#/components/schemas/Container' } } } },
  Container: { type: 'object', required: ['image'], properties: { image: { type: 'string', description: 'Container image.' }, name: { type: 'string' } } },
} } });
const index = (hash = 'FIRST') => ({ paths: { 'api/v1': { serverRelativeURL: `/openapi/v3/api/v1?hash=${hash}` } } });
async function fixture() {
  let changed = false, drift = false, after = false, status = 200, indexes = 0, consumedError = false, data: unknown = schema();
  const reads: ResourceReadRequest[] = [], states: ExplainState[] = [];
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active',
    clusters: [{ name: 'c', cluster: { server: changed ? 'https://changed.invalid' : 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const current = await config.read({ mode: 'default' }), target = { serviceGeneration: 's', projectId: 'view', configIdentity: current.snapshot.configIdentity, context: 'active', namespace: 'default' };
  const request = { protocol: 2 as const, target, selection: { mode: 'default' as const }, type, fieldPath: ['spec', 'containers', 'image'], documentIdentity: 'a'.repeat(64), revision: 1 };
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => {
    kubectlReadArguments(request, '/synthetic/configuration.pipe'); reads.push(request);
    const body = request.purpose === 'openapi-index' ? index(drift && ++indexes > 1 ? 'SECOND' : 'FIRST') : data;
    if (request.purpose === 'openapi-schema' && after) changed = true;
    return { status, body: { async *[Symbol.asyncIterator]() { if (status !== 200) consumedError = true; yield Buffer.from(JSON.stringify(body)); } }, close: async () => {} };
  } });
  const transport = async (input: { method: 'POST'; path: string; body: string }) => {
    assert.equal(input.path, '/v2/explain/read');
    try { return { status: 200, body: JSON.stringify(await gateway.explain(JSON.parse(input.body) as unknown, signal())) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  };
  const client = new ExplainClient(transport, state => states.push(state));
  function document(value = text): DocumentState {
    const source = { protocol: 2 as const, target, selection: request.selection, reference, format: 'yaml' as const };
    const page = { protocol: 2 as const, kind: 'resource-document' as const, target, reference, format: 'yaml' as const, contentIdentity: request.documentIdentity,
      text: value, totalBytes: Buffer.byteLength(value), totalCharacters: value.length, offset: 0, end: value.length, nextCursor: null };
    return { phase: 'ready', stale: false, text: value, complete: true, source, page, editor: new DocumentBuffer(value, page).state };
  }
  return { request, gateway, client, states, reads, document, schema: (value: unknown) => { data = value; }, change: () => { changed = true; }, after: () => { after = true; },
    drift: () => { drift = true; }, status: (value: number) => { status = value; }, errorConsumed: () => consumedError, close() { client.dispose(); gateway.close(); } };
}

test('local YAML field inventory contains real paths with array indexes removed only from schema paths, never scalar values', () => {
  const fields = documentFields(text, type); assert.ok(fields.some(f => f.label.includes('[0]') && JSON.stringify(f.path) === JSON.stringify(['spec', 'containers', 'image'])));
  assert.equal(JSON.stringify(fields).includes('SYNTHETIC_SECRET'), false); assert.deepEqual(fields[0]?.path, []);
});
test('local JSON document yields the same field paths without serializing values', () => {
  const fields = documentFields(JSON.stringify({ apiVersion: 'v1', kind: 'Pod', spec: { containers: [{ image: 'SYNTHETIC_SECRET' }] } }), type);
  assert.ok(fields.some(f => f.path.join('.') === 'spec.containers.image')); assert.equal(JSON.stringify(fields).includes('SYNTHETIC_SECRET'), false);
});
test('edited GVK cannot silently query a different kind/group/version schema', () => {
  for (const value of [text.replace('kind: Pod', 'kind: Service'), text.replace('apiVersion: v1', 'apiVersion: apps/v1')]) assert.throws(() => documentFields(value, type), /CONTENT_INVALID/);
});
test('malformed, duplicate, alias, custom-tag and multi-document YAML cannot form Explain requests', () => {
  for (const value of [text + 'bad: [', text + 'kind: Pod\n', text + 'extra: &x {a: 1}\ncopy: *x\n', text + 'extra: !unsafe abc\n', text + '---\nkind: Pod\n']) assert.throws(() => documentFields(value, type), /CONTENT_INVALID/);
});
test('local document byte/field/depth budgets fail instead of building unlimited choices', () => {
  assert.throws(() => documentFields(text + 'x: ' + 'a'.repeat(1_048_576), type), /BUDGET_EXCEEDED/);
  assert.throws(() => documentFields(text + Array.from({ length: 2001 }, (_, i) => `field${i}: x\n`).join(''), type), /BUDGET_EXCEEDED/);
});
test('a selected actual buffer field produces only identity/type/path/revision, never document text or values', async () => {
  const f = await fixture(), doc = f.document(), field = documentFields(text, type).find(f => f.path.join('.') === 'spec.containers.image'); assert.ok(field);
  const request = explanationRequest(doc, field.id, 0); assert.deepEqual(request.fieldPath, ['spec', 'containers', 'image']); assert.equal(JSON.stringify(request).includes('SYNTHETIC_SECRET'), false); assert.equal('text' in request, false); f.close();
});
test('dirty buffer Explain uses current local field inventory/revision without sending edited content or changing the loaded origin', async () => {
  const f = await fixture(), doc = f.document(); assert.ok(doc.page);
  const buffer = new DocumentBuffer(text, doc.page); buffer.edit(text + '  restartPolicy: SYNTHETIC_EDITED_VALUE\n');
  const field = documentFields(buffer.state.text, type).find(field => field.path.join('.') === 'spec.restartPolicy'); assert.ok(field);
  const request = explanationRequest({ ...doc, editor: buffer.state }, field.id, buffer.state.revision);
  assert.equal(request.revision, 1); assert.equal(request.documentIdentity, doc.page.contentIdentity); assert.equal(JSON.stringify(request).includes('SYNTHETIC_EDITED_VALUE'), false); f.close();
});
test('partial/stale/non-editor documents and old buffer revisions cannot dispatch Explain', async () => {
  const f = await fixture(), doc = f.document(); for (const change of [{ complete: false }, { stale: true }, { editor: undefined }, { phase: 'loading' as const }]) assert.throws(() => explanationRequest({ ...doc, ...change } as DocumentState, '0', 0));
  assert.throws(() => explanationRequest(doc, '0', 1), /STALE_TARGET/); assert.throws(() => explanationRequest(doc, 'unknown', 0), /INVALID_INPUT/); f.close();
});
test('strict Explain request rejects body, URL, argv and arbitrary custom type extensions', async () => {
  const f = await fixture(); for (const change of [{ text: 'SYNTHETIC_SECRET' }, { url: 'https://other.invalid' }, { argv: ['explain'] }, { type: { ...type, group: 'custom.invalid' } }, { fieldPath: ['x'.repeat(257)] }]) assert.equal(explainRequestSchema.safeParse({ ...f.request, ...change }).success, false); f.close();
});
test('OpenAPI location is keyed by full group/version, not global Swagger or kind guessing', () => {
  assert.equal(openApiLocation(index(), type).path, '/openapi/v3/api/v1');
  assert.equal(openApiLocation({ paths: { 'apis/apps/v1': { serverRelativeURL: '/openapi/v3/apis/apps/v1?hash=ABC' } } }, { ...type, group: 'apps' }).path, '/openapi/v3/apis/apps/v1');
});
test('OpenAPI index cannot redirect reads to another group/version, host, proxy or query', () => {
  for (const url of ['https://other.invalid/openapi/v3/api/v1?hash=A', '/openapi/v3/api/v2?hash=A', '/api/v1/services/x/proxy', '/openapi/v3/api/v1?hash=A&token=secret', '/openapi/v3/api/v1']) assert.throws(() => openApiLocation({ paths: { 'api/v1': { serverRelativeURL: url } } }, type));
});
test('GVK matching is exact and ambiguous or missing definitions never fall back to v1beta1 or another group', () => {
  assert.throws(() => projectExplanation(schema(), { type: { ...type, group: 'other' }, fieldPath: [] }), /NOT_FOUND/);
  const data = schema(); const duplicate = { ...data, components: { schemas: { ...data.components.schemas, Duplicate: data.components.schemas.Pod } } };
  assert.throws(() => projectExplanation(duplicate, { type, fieldPath: [] }), /RESOURCE_INVALID/);
});
test('root and fields show schema description/type/required without default/example/object values', () => {
  const root = projectExplanation(schema(), { type, fieldPath: [] }); assert.equal(root.description, 'A pod.'); assert.equal(root.properties.find(p => p.name === 'spec')?.required, true);
  assert.deepEqual(projectExplanation(schema(), { type, fieldPath: ['spec', 'containers', 'image'] }), { type: 'string', description: 'Container image.', required: true, properties: [] });
});
test('schema local refs, array items and additionalProperties maps are traversed without losing field identity', () => {
  assert.equal(projectExplanation(schema(), { type, fieldPath: ['spec', 'containers'] }).type, 'array<object>');
  assert.equal(projectExplanation(schema(), { type, fieldPath: ['metadata', 'arbitrary-key'] }).description, 'Map value.');
});
test('external, cyclic and unresolved schema references fail without network access', () => {
  for (const ref of ['https://other.invalid/schema', '#/components/schemas/Missing', '#/components/schemas/Pod']) {
    const data = schema(); const changed = { ...data, components: { schemas: { ...data.components.schemas, Spec: { $ref: ref } } } };
    assert.throws(() => projectExplanation(changed, { type, fieldPath: ['spec', 'containers'] }));
  }
});
test('single allOf reference is resolved while ambiguous composite schemas explicitly fail', () => {
  const data = schema(); const wrapped = { ...data, components: { schemas: { ...data.components.schemas, Spec: { allOf: [{ $ref: '#/components/schemas/Container' }] } } } };
  assert.equal(projectExplanation(wrapped, { type, fieldPath: ['spec', 'image'] }).type, 'string');
  const ambiguous = { ...data, components: { schemas: { ...data.components.schemas, Spec: { allOf: [{ type: 'object' }, { type: 'object' }] } } } };
  assert.throws(() => projectExplanation(ambiguous, { type, fieldPath: ['spec'] }), /RESOURCE_INVALID/);
});
test('schema description/property/node budgets reject rather than silently truncate', () => {
  const data = schema(); assert.throws(() => projectExplanation({ ...data, components: { schemas: { ...data.components.schemas, Pod: { ...data.components.schemas.Pod, description: 'a'.repeat(16_385) } } } }, { type, fieldPath: [] }), /BUDGET_EXCEEDED/);
  const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`p${i}`, { type: 'string' }]));
  assert.throws(() => projectExplanation({ ...data, components: { schemas: { ...data.components.schemas, Spec: { properties: many } } } }, { type, fieldPath: ['spec'] }), /BUDGET_EXCEEDED/);
});
test('inherited property names cannot masquerade as schema fields', () => {
  assert.throws(() => projectExplanation(schema(), { type, fieldPath: ['toString'] }), /NOT_FOUND/);
});
test('OpenAPI private plan emits only fixed raw GET with original context and hash, no cache or explain command', async () => {
  const f = await fixture(); await f.gateway.explain(f.request, signal()); const read = f.reads.find(r => r.purpose === 'openapi-schema'); assert.ok(read);
  const args = kubectlReadArguments(read, '/synthetic/pipe'); assert.ok(args.includes('--context=active') && args.includes('--raw=/openapi/v3/api/v1?hash=FIRST')); assert.equal(args.includes('explain'), false); assert.equal(args.some(a => a.startsWith('--cache-dir=')), false); f.close();
});
test('8MB request budget is private to exact OpenAPI schema purpose, never a way to enlarge ordinary resource reads', async () => {
  const f = await fixture(); await f.gateway.explain(f.request, signal()); const request = f.reads.find(r => r.purpose === 'openapi-schema'); assert.ok(request);
  const start = { protocol: 1, kind: 'read', request, snapshot: new Uint8Array([123]), path: '/synthetic/bin' }; assert.equal(parseReadWorkerStart(start).request.maximumBytes, 8_000_000);
  for (const change of [{ purpose: 'resource-object' }, { path: '/api/v1/pods' }, { query: { hash: 'A', token: 'SYNTHETIC_SECRET' } }, { maximumBytes: 9_000_000 }]) assert.throws(() => parseReadWorkerStart({ ...start, request: { ...request, ...change } })); f.close();
});
test('private IPC result remains 2MB by default and only schema callers explicitly admit up to 8MB', () => {
  const result = { protocol: 1, ok: true, status: 200, body: new Uint8Array(2_000_001) }; assert.throws(() => parseReadWorkerResult(result)); assert.equal(parseReadWorkerResult(result, 8_000_000).ok, true);
  assert.throws(() => parseReadWorkerResult({ ...result, body: new Uint8Array(8_000_001) }, 8_000_000));
});
test('real gateway/reader returns only bounded explanation after index-schema-index and original config verification', async () => {
  const f = await fixture(), page = await f.gateway.explain(f.request, signal()); assert.equal(page.explanation.description, 'Container image.');
  assert.deepEqual(f.reads.map(r => r.purpose), ['openapi-index', 'openapi-schema', 'openapi-index']); assert.equal('components' in page, false); assert.equal('text' in page, false); f.close();
});
test('schema generation drift during Explain discards the result', async () => {
  const f = await fixture(); f.drift(); await assert.rejects(f.gateway.explain(f.request, signal()), /STALE_TARGET/); f.close();
});
test('configuration drift before Explain starts prevents all schema transport calls', async () => {
  const f = await fixture(); f.change(); await assert.rejects(f.gateway.explain(f.request, signal()), /STALE_TARGET/); assert.equal(f.reads.length, 0); f.close();
});
test('configuration drift after schema fetch does not publish another cluster schema', async () => {
  const f = await fixture(); f.after(); await assert.rejects(f.gateway.explain(f.request, signal()), /STALE_TARGET/); f.close();
});
test('schema permission failure never consumes or returns a sensitive raw error body', async () => {
  const f = await fixture(); f.status(403); await f.client.read(f.request); assert.equal(f.errorConsumed(), false); assert.equal(f.states.at(-1)?.error, 'FORBIDDEN'); assert.equal(f.states.at(-1)?.page, undefined); f.close();
});
test('schema larger than 2MB but within the private 8MB limit can be read without raising unrelated resource budgets', async () => {
  const f = await fixture(); f.schema({ ...schema(), padding: 'a'.repeat(2_100_000) }); const page = await f.gateway.explain(f.request, signal()); assert.equal(page.explanation.type, 'string'); f.close();
});
test('schema over 8MB fails whole, without a truncated schema or healthy explanation', async () => {
  const f = await fixture(); f.schema({ ...schema(), padding: 'a'.repeat(8_000_000) }); await f.client.read(f.request); assert.equal(f.states.at(-1)?.error, 'BUDGET_EXCEEDED'); f.close();
});
test('independent Explain client accepts only a response for the original document generation/type/path/target', async () => {
  const f = await fixture(); await f.client.read(f.request); assert.equal(f.states.at(-1)?.phase, 'ready'); assert.equal(f.states.at(-1)?.page?.revision, 1); f.close();
});
test('client rejects cross-context/type/path/document/revision results without exposing stale explanation text', async () => {
  const f = await fixture(), page = await f.gateway.explain(f.request, signal());
  for (const change of [{ target: { ...page.target, context: 'other' } }, { type: { ...type, kind: 'Service' } }, { fieldPath: ['metadata'] }, { revision: 2 }, { documentIdentity: 'b'.repeat(64) }]) {
    const states: ExplainState[] = [], client = new ExplainClient(async () => ({ status: 200, body: JSON.stringify({ ...page, ...change }) }), state => states.push(state)); await client.read(f.request);
    assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.page, undefined); client.dispose();
  } f.close();
});
test('reset/dispose drops late schema responses without cancelling any write or operation session', async () => {
  const f = await fixture(), page = await f.gateway.explain(f.request, signal()), deferred = Promise.withResolvers<{ status: number; body: string }>(), states: ExplainState[] = [];
  const client = new ExplainClient(async () => deferred.promise, state => states.push(state)); const pending = client.read(f.request); client.reset(); deferred.resolve({ status: 200, body: JSON.stringify(page) }); await pending;
  assert.equal(states.at(-1)?.phase, 'idle'); client.dispose(); f.close();
});
test('four actual unsettled Explain transports remain bounded even after repeated local resets', async () => {
  const f = await fixture(), deferred = Promise.withResolvers<{ status: number; body: string }>(), states: ExplainState[] = []; let calls = 0;
  const client = new ExplainClient(async () => { calls++; return deferred.promise; }, state => states.push(state)), pending = [];
  for (let i = 0; i < 5; i++) { client.reset(); pending.push(client.read(f.request)); } assert.equal(calls, 4); assert.equal(states.at(-1)?.error, 'QUERY_LIMIT');
  deferred.resolve({ status: 400, body: '{"error":{"code":"NOT_FOUND"}}' }); await Promise.all(pending); client.dispose(); f.close();
});
test('cancelled or closed Explain gateway cannot start a schema transport', async () => {
  const f = await fixture(); await assert.rejects(f.gateway.explain(f.request, AbortSignal.abort()), /QUERY_CANCELLED/); f.gateway.close();
  await assert.rejects(f.gateway.explain(f.request, signal()), /SERVICE_CLOSED/); assert.equal(f.reads.length, 0); f.close();
});
