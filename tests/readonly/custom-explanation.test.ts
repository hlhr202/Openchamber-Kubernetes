// Independent synthetic GET/schema responses and pure document/client helpers only. No real SDK/CLI/worker/files or write chains.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { explainRequestSchema, explainResponseSchema } from '../../src/shared/explain-protocol.ts';
import { deleteReferenceSchema } from '../../src/shared/delete-protocol.ts';
import { DocumentBuffer } from '../../src/shared/document-buffer.ts';
import type { DocumentState } from '../../src/host/document-client.ts';
import { documentFields, explanationRequest } from '../../src/host/document-fields.ts';
import { analyseManifestBundle } from '../../src/host/manifest-bundle.ts';
import { ExplainClient } from '../../src/host/explain-client.ts';
import type { ExplainState } from '../../src/host/explain-client.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { parseReadWorkerStart } from '../../src/service/queries/read-worker-protocol.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';

const signal = () => new AbortController().signal, marker = 'SYNTHETIC_PRIVATE_VALUE';
const type = { group: 'example.com', version: 'v2', resource: 'widgets', kind: 'Widget', scope: 'namespace' as const }, definition = { name: 'widgets.example.com', uid: 'd', resourceVersion: 'd1' };
const reference = { type, definition, namespace: 'default', name: 'sample', uid: 'u', resourceVersion: 'r1' };
const documentText = `apiVersion: example.com/v2\nkind: Widget\nmetadata:\n  name: sample\nspec:\n  entries:\n  - value: ${marker}\n`;
const crd = () => ({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { ...definition, annotations: { private: marker } }, spec: { group: 'example.com', scope: 'Namespaced', names: { plural: 'widgets', kind: 'Widget', listKind: 'WidgetCollection' }, versions: [{ name: 'v1', served: true, storage: true }, { name: 'v2', served: true, storage: false }] } });
const discovery = () => ({ groupVersion: 'example.com/v2', resources: [{ name: 'widgets', kind: 'Widget', namespaced: true, verbs: ['get', 'list'] }] });
const index = (hash = 'FIRST') => ({ paths: { 'apis/example.com/v2': { serverRelativeURL: `/openapi/v3/apis/example.com/v2?hash=${hash}` } } });
const schema = () => ({ openapi: '3.0.0', components: { schemas: {
  Widget: { type: 'object', description: 'A custom widget.', 'x-kubernetes-group-version-kind': [{ group: 'example.com', version: 'v2', kind: 'Widget' }], required: ['spec'], properties: { spec: { $ref: '#/components/schemas/Spec' }, metadata: { type: 'object', additionalProperties: { type: 'string', description: 'Metadata value.' } } } },
  Spec: { type: 'object', properties: { entries: { type: 'array', items: { $ref: '#/components/schemas/Entry' } } } },
  Entry: { type: 'object', required: ['value'], properties: { value: { type: 'string', description: 'Entry value.', default: marker, example: marker }, settings: { type: 'object', additionalProperties: { type: 'integer', description: 'Setting value.' } } } },
} } });
async function fixture() {
  let def = crd(), disc = discovery(), locator: unknown = index(), data: unknown = schema(), changed = false, status = 200, failurePurpose = '', errorIterated = false, padding = 0, schemaPadding = 0;
  let before: ((request: ResourceReadRequest) => void | Promise<void>) | undefined;
  const reads: ResourceReadRequest[] = [], states: ExplainState[] = [];
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: changed ? 'https://changed.invalid' : 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), target = { serviceGeneration: 's', projectId: 'p', configIdentity: snapshot.snapshot.configIdentity, context: 'active', namespace: 'default' };
  const request = { protocol: 2 as const, selection: { mode: 'default' as const }, target, type, definition, fieldPath: ['spec', 'entries', 'value'], documentIdentity: 'a'.repeat(64), revision: 0 };
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, input) => {
    kubectlReadArguments(input, '/synthetic/config.pipe'); reads.push(input); await before?.(input);
    assert.ok(['resource-object', 'api-version', 'openapi-index', 'openapi-schema'].includes(input.purpose));
    if (input.purpose === 'resource-object') assert.equal(input.path, '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/widgets.example.com');
    const value = input.purpose === 'resource-object' ? def : input.purpose === 'api-version' ? disc : input.purpose === 'openapi-index' ? locator : data;
    const body = JSON.stringify(value).padEnd(input.purpose === 'openapi-schema' ? schemaPadding : padding), code = input.purpose === failurePurpose ? status : 200;
    return { status: code, body: { async *[Symbol.asyncIterator]() { if (code !== 200) errorIterated = true; yield Buffer.from(body); } }, close: async () => {} };
  } });
  const transport = async (input: { method: 'POST'; path: string; body: string }) => { assert.equal(input.path, '/v2/explain/read'); try { return { status: 200, body: JSON.stringify(await gateway.explain(JSON.parse(input.body) as unknown, signal())) }; } catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; } };
  const client = new ExplainClient(transport, state => states.push(state));
  function document(text = documentText): DocumentState { const source = { protocol: 2 as const, target, selection: request.selection, reference, format: 'yaml' as const }, page = { protocol: 2 as const, kind: 'resource-document' as const, target, reference, format: 'yaml' as const, contentIdentity: request.documentIdentity, totalBytes: Buffer.byteLength(text), totalCharacters: text.length, offset: 0, end: text.length, text, nextCursor: null }; return { phase: 'ready', stale: false, text, complete: true, source, page, editor: new DocumentBuffer(text, page).state }; }
  return { request, target, gateway, client, states, reads, document, definition: () => def, discovery: () => disc, schema: () => schema(), setDefinition(value: typeof def) { def = value; }, setDiscovery(value: typeof disc) { disc = value; }, setSchema(value: unknown) { data = value; }, setIndex(value: unknown) { locator = value; }, padMetadata(bytes: number) { padding = bytes; }, padSchema(bytes: number) { schemaPadding = bytes; }, before(callback: typeof before) { before = callback; }, fail(purpose: string, code: number) { failurePurpose = purpose; status = code; }, errorIterated: () => errorIterated, changeConfig() { changed = true; }, close() { client.dispose(); gateway.close(); } };
}
test('custom Explain requires a strict original definition and exact plural.group, not bare custom type/URL/body', async () => {
  const f = await fixture(); try { assert.ok(explainRequestSchema.safeParse(f.request).success); for (const change of [{ definition: undefined }, { definition: { ...definition, name: 'other.example.com' } }, { definition: { ...definition, schema: marker } }, { body: marker }, { text: documentText }, { url: 'https://invalid' }, { reference }, { argv: ['explain'] }]) assert.equal(explainRequestSchema.safeParse({ ...f.request, ...change }).success, false); } finally { f.close(); }
});
test('builtin schema sources remain definition-free, while CRD Explain cannot widen Delete or generic object verification', async () => {
  const f = await fixture(); try { const builtin = { ...type, group: '', version: 'v1', resource: 'pods', kind: 'Pod' }; assert.ok(explainRequestSchema.safeParse({ ...f.request, definition: undefined, type: builtin }).success); assert.equal(explainRequestSchema.safeParse({ ...f.request, type: builtin, definition: { ...definition, name: 'pods.' } }).success, false); assert.equal(deleteReferenceSchema.safeParse(reference).success, false); await assert.rejects(f.gateway.verifyReference({ selection: f.request.selection, target: f.target, reference }, signal()), /INVALID_INPUT/); assert.equal(f.reads.length, 0); } finally { f.close(); }
});
test('local actual CRD field request carries only definition/type/path/document identity and revision, never scalar values or instance identity', async () => {
  const f = await fixture(); try { const field = documentFields(documentText, type).find(x => x.path.join('.') === 'spec.entries.value'); assert.ok(field); const request = explanationRequest(f.document(), field.id, 0); assert.deepEqual(request.definition, definition); assert.deepEqual(request.fieldPath, ['spec', 'entries', 'value']); for (const key of ['text', 'body', 'name', 'namespace', 'uid', 'resourceVersion', 'reference']) assert.equal(key in request, false); assert.equal(JSON.stringify(request).includes(marker), false); } finally { f.close(); }
});
test('dirty CRD buffer uses current fields/revision but cannot change its original definition or GVK', async () => {
  const f = await fixture(); try { const doc = f.document(); assert.ok(doc.page); const buffer = new DocumentBuffer(documentText, doc.page); buffer.edit(documentText + '  local: SYNTHETIC_EDIT\n'); const field = documentFields(buffer.state.text, type).find(x => x.path.join('.') === 'spec.local'); assert.ok(field); const request = explanationRequest({ ...doc, editor: buffer.state }, field.id, buffer.state.revision); assert.deepEqual(request.definition, definition); assert.equal(request.revision, 1); assert.equal(JSON.stringify(request).includes('SYNTHETIC_EDIT'), false); assert.throws(() => explanationRequest(f.document(documentText.replace('kind: Widget', 'kind: Other')), '0', 0), /CONTENT_INVALID/); } finally { f.close(); }
});
test('explicit CRD document-stream selection can Explain only the selected document matching the original full GVK', async () => {
  const f = await fixture(); try { const text = documentText + '---\napiVersion: example.com/v2\nkind: Other\n', doc = f.document(text); assert.ok(doc.page); const buffer = new DocumentBuffer(text, doc.page); buffer.analyse(analyseManifestBundle(text, 'yaml')); assert.deepEqual(explanationRequest({ ...doc, editor: buffer.state }, '0', buffer.state.revision).definition, definition); buffer.selectDocument(1); assert.throws(() => explanationRequest({ ...doc, editor: buffer.state }, '0', buffer.state.revision), /CONTENT_INVALID/); } finally { f.close(); }
});
test('partial/stale/old revision CRD buffers cannot form schema requests', async () => {
  const f = await fixture(); try { const doc = f.document(); assert.throws(() => explanationRequest({ ...doc, stale: true }, '0', 0), /CONTENT_INVALID/); assert.throws(() => explanationRequest({ ...doc, complete: false }, '0', 0), /CONTENT_INVALID/); assert.throws(() => explanationRequest(doc, '0', 1), /STALE_TARGET/); } finally { f.close(); }
});
test('local source/page/editor origins must agree on original definition and target before any request', async () => {
  const f = await fixture(); try { const doc = f.document(); assert.ok(doc.source && doc.page); for (const source of [{ ...doc.source, reference: { ...reference, definition: { ...definition, uid: 'replacement' } } }, { ...doc.source, target: { ...f.target, context: 'other' } }]) assert.throws(() => explanationRequest({ ...doc, source }, '0', 0), /STALE_TARGET/); } finally { f.close(); }
});
test('custom Explain reads CRD/discovery then index-schema-index then CRD/discovery, never an instance body', async () => {
  const f = await fixture(); try { const page = await f.gateway.explain(f.request, signal()); assert.deepEqual(f.reads.map(x => x.purpose), ['resource-object', 'api-version', 'openapi-index', 'openapi-schema', 'openapi-index', 'resource-object', 'api-version']); assert.deepEqual(page.definition, definition); assert.equal(page.explanation.description, 'Entry value.'); assert.equal(page.explanation.required, true); assert.equal(JSON.stringify(page).includes(marker), false); assert.ok(explainResponseSchema.safeParse(page).success); assert.equal(f.reads.some(r => r.path.includes('/namespaces/')), false); } finally { f.close(); }
});
test('custom schema request stays on exact selected non-storage served GVR and hash', async () => {
  const f = await fixture(); try { await f.gateway.explain(f.request, signal()); const request = f.reads.find(r => r.purpose === 'openapi-schema'); assert.ok(request); assert.equal(request.path, '/openapi/v3/apis/example.com/v2'); assert.deepEqual(request.query, { hash: 'FIRST' }); const args = kubectlReadArguments(request, '/synthetic/config.pipe'); assert.ok(args.includes('--raw=/openapi/v3/apis/example.com/v2?hash=FIRST')); assert.equal(args.includes('explain'), false); assert.equal(parseReadWorkerStart({ protocol: 1, kind: 'read', request, snapshot: new Uint8Array([1]), path: '/synthetic/bin' }).request.maximumBytes, 8_000_000); } finally { f.close(); }
});
test('cluster-scoped CRD schema uses exact cluster kind without inventing an instance namespace or UID', async () => {
  const f = await fixture(); try { const def = f.definition(); def.spec.scope = 'Cluster'; f.setDefinition(def); const disc = f.discovery(), entry = disc.resources[0]; assert.ok(entry); entry.namespaced = false; f.setDiscovery(disc); const page = await f.gateway.explain({ ...f.request, type: { ...type, scope: 'cluster' } }, signal()); assert.equal(page.type.scope, 'cluster'); assert.equal(page.target.namespace, 'default'); assert.equal(f.reads.some(r => r.path.includes('/namespaces/')), false); } finally { f.close(); }
});
test('CRD schema field traversal retains root/arrays/maps/local refs but omits examples/defaults/CEL values', async () => {
  const f = await fixture(); try { const root = await f.gateway.explain({ ...f.request, fieldPath: [] }, signal()); assert.ok(root.explanation.properties.some(x => x.name === 'spec' && x.required)); const map = await f.gateway.explain({ ...f.request, fieldPath: ['spec', 'entries', 'settings', 'custom-key'] }, signal()); assert.equal(map.explanation.description, 'Setting value.'); assert.equal(map.explanation.type, 'integer'); assert.equal(JSON.stringify(map).includes(marker), false); } finally { f.close(); }
});
test('missing/mismatched/ambiguous custom schema GVK fails rather than selecting a preferred version or same-named kind', async () => {
  for (const mode of ['version', 'kind', 'duplicate']) { const f = await fixture(); try { const data = f.schema(); if (mode === 'duplicate') f.setSchema({ ...data, components: { schemas: { ...data.components.schemas, Duplicate: data.components.schemas.Widget } } }); else { const gvk = data.components.schemas.Widget['x-kubernetes-group-version-kind'][0]; assert.ok(gvk); if (mode === 'version') gvk.version = 'v1'; else gvk.kind = 'Other'; f.setSchema(data); } await assert.rejects(f.gateway.explain(f.request, signal()), mode === 'duplicate' ? /RESOURCE_INVALID/ : /NOT_FOUND/); } finally { f.close(); } }
});
test('unpublished custom schemas and unsupported OpenAPI versions fail explicitly without raw CRD-schema or Swagger fallback', async () => {
  for (const mode of ['missing', 'v2']) { const f = await fixture(); try { if (mode === 'missing') f.setIndex({ paths: {} }); else f.setSchema({ ...f.schema(), openapi: '2.0' }); await assert.rejects(f.gateway.explain(f.request, signal()), mode === 'missing' ? /NOT_FOUND/ : /RESOURCE_INVALID/); assert.equal(f.reads.some(x => x.path.includes('swagger') || x.path === '/openapi/v2'), false); } finally { f.close(); } }
});
test('external/cyclic custom schema refs cannot cause additional network reads', async () => {
  for (const ref of ['https://invalid/schema', '#/components/schemas/Spec']) { const f = await fixture(); try { const data = f.schema(); f.setSchema({ ...data, components: { schemas: { ...data.components.schemas, Spec: { $ref: ref } } } }); await assert.rejects(f.gateway.explain(f.request, signal()), /RESOURCE_INVALID/); assert.equal(f.reads.length, 4); } finally { f.close(); } }
});
test('wrong CRD UID/RV or unserved version prevents all OpenAPI transport reads', async () => {
  for (const mode of ['uid', 'rv', 'served']) { const f = await fixture(); try { const def = f.definition(); if (mode === 'uid') def.metadata.uid = 'replacement'; if (mode === 'rv') def.metadata.resourceVersion = 'd2'; if (mode === 'served') { const v = def.spec.versions[1]; assert.ok(v); v.served = false; } f.setDefinition(def); await assert.rejects(f.gateway.explain(f.request, signal()), /STALE_TARGET/); assert.equal(f.reads.some(r => r.purpose.startsWith('openapi')), false); } finally { f.close(); } }
});
test('discovery wrong kind/scope/group-version or missing list capability prevents schema routing', async () => {
  for (const mode of ['kind', 'scope', 'gv', 'verbs']) { const f = await fixture(); try { const disc = f.discovery(), entry = disc.resources[0]; assert.ok(entry); if (mode === 'kind') entry.kind = 'Other'; if (mode === 'scope') entry.namespaced = false; if (mode === 'gv') disc.groupVersion = 'example.com/v1'; if (mode === 'verbs') entry.verbs = ['get']; f.setDiscovery(disc); await assert.rejects(f.gateway.explain(f.request, signal()), /STALE_TARGET/); assert.equal(f.reads.length, 2); } finally { f.close(); } }
});
test('OpenAPI locator drift after schema reading discards the selected field explanation', async () => {
  const f = await fixture(); try { f.before(r => { if (r.purpose === 'openapi-schema') f.setIndex(index('SECOND')); }); await assert.rejects(f.gateway.explain(f.request, signal()), /STALE_TARGET/); assert.equal(f.reads.length, 5); } finally { f.close(); }
});
test('post-schema CRD identity/served-routing or discovery drift invalidates explanation', async () => {
  for (const mode of ['definition', 'routing', 'discovery']) { const f = await fixture(); try { f.before(r => { if (r.purpose === 'openapi-schema') { if (mode === 'discovery') { const disc = f.discovery(), entry = disc.resources[0]; assert.ok(entry); entry.kind = 'Other'; f.setDiscovery(disc); } else { const def = f.definition(); if (mode === 'definition') def.metadata.resourceVersion = 'd2'; else def.spec.names.listKind = 'Changed'; f.setDefinition(def); } } }); await assert.rejects(f.gateway.explain(f.request, signal()), /STALE_TARGET/); } finally { f.close(); } }
});
test('schema result identity incorporates original definition in addition to the published locator', async () => {
  const f = await fixture(); try { const first = await f.gateway.explain(f.request, signal()), def = f.definition(); def.metadata.resourceVersion = 'd2'; f.setDefinition(def); const second = await f.gateway.explain({ ...f.request, definition: { ...definition, resourceVersion: 'd2' } }, signal()); assert.notEqual(first.schemaIdentity, second.schemaIdentity); } finally { f.close(); }
});
test('configuration changes before or during proof/schema reads reject old-target results', async () => {
  for (const mode of ['before', 'during']) { const f = await fixture(); try { if (mode === 'before') f.changeConfig(); else f.before(r => { if (r.purpose === 'openapi-schema') f.changeConfig(); }); await assert.rejects(f.gateway.explain(f.request, signal()), /STALE_TARGET/); if (mode === 'before') assert.equal(f.reads.length, 0); } finally { f.close(); } }
});
test('permission/notfound/throttle errors never iterate upstream bodies or retry authentication', async () => {
  for (const [purpose, code, expected] of [['resource-object', 403, 'FORBIDDEN'], ['api-version', 404, 'NOT_FOUND'], ['openapi-index', 401, 'UNAUTHENTICATED'], ['openapi-schema', 429, 'QUERY_LIMIT']] as const) { const f = await fixture(); try { f.fail(purpose, code); await f.client.read(f.request); assert.equal(f.states.at(-1)?.error, expected); assert.equal(f.errorIterated(), false); assert.equal(f.reads.filter(x => x.purpose === purpose).length, 1); assert.equal(f.states.at(-1)?.page, undefined); } finally { f.close(); } }
});
test('index cannot redirect a CRD schema request to another host/group/version/query or proxy', async () => {
  for (const url of ['https://invalid/openapi/v3/apis/example.com/v2?hash=A', '/openapi/v3/apis/example.com/v1?hash=A', '/openapi/v3/apis/example.com/v2?hash=A&token=private', '/api/v1/services/x/proxy']) { const f = await fixture(); try { f.setIndex({ paths: { 'apis/example.com/v2': { serverRelativeURL: url } } }); await assert.rejects(f.gateway.explain(f.request, signal()), /RESOURCE_INVALID/); assert.equal(f.reads.length, 3); } finally { f.close(); } }
});
test('cancellation after initial CRD proof prevents schema fetch and late delivery', async () => {
  const f = await fixture(), controller = new AbortController(); try { f.before(() => controller.abort()); await assert.rejects(f.gateway.explain(f.request, controller.signal), /QUERY_CANCELLED/); assert.equal(f.reads.length, 1); } finally { f.close(); }
});
test('per-response 2MB/8MB and total 16MB schema-proof budgets reject whole responses', async () => {
  for (const mode of ['metadata', 'schema', 'aggregate']) { const f = await fixture(); try { if (mode === 'metadata') f.padMetadata(2_000_001); if (mode === 'schema') f.padSchema(8_000_001); if (mode === 'aggregate') { f.padMetadata(2_000_000); f.padSchema(4_100_000); } await assert.rejects(f.gateway.explain(f.request, signal()), /BUDGET_EXCEEDED/); assert.ok(f.reads.length <= 7); } finally { f.close(); } }
});
test('a schema over 2MB within 8MB stays readable without broadening other private purposes', async () => {
  const f = await fixture(); try { f.padSchema(2_100_000); assert.equal((await f.gateway.explain(f.request, signal())).explanation.type, 'string'); const request = f.reads.find(r => r.purpose === 'openapi-schema'); assert.ok(request); assert.throws(() => kubectlReadArguments({ ...request, purpose: 'resource-object' }, '/synthetic/config.pipe'), /INVALID_INPUT/); } finally { f.close(); }
});
test('client validates definition on matching document/type/path/revision, rejecting missing or substituted original identity', async () => {
  const f = await fixture(); try { const page = await f.gateway.explain(f.request, signal()); for (const definition of [undefined, { name: 'widgets.example.com', uid: 'other', resourceVersion: 'd1' }, { name: 'widgets.example.com', uid: 'd', resourceVersion: 'd2' }]) { const states: ExplainState[] = [], client = new ExplainClient(async () => ({ status: 200, body: JSON.stringify({ ...page, definition }) }), state => states.push(state)); await client.read(f.request); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.page, undefined); client.dispose(); } } finally { f.close(); }
});
test('valid custom client response is frozen and reset/dispose drops late metadata results without business cleanup', async () => {
  const f = await fixture(); try { await f.client.read(f.request); const state = f.states.at(-1); assert.equal(state?.phase, 'ready'); assert.ok(Object.isFrozen(state?.page?.definition)); const page = await f.gateway.explain(f.request, signal()), deferred = Promise.withResolvers<{ status: number; body: string }>(), states: ExplainState[] = [], client = new ExplainClient(async () => deferred.promise, state => states.push(state)); const pending = client.read(f.request); client.reset(); deferred.resolve({ status: 200, body: JSON.stringify(page) }); await pending; assert.equal(states.at(-1)?.phase, 'idle'); client.dispose(); } finally { f.close(); }
});
test('custom schema work shares the same two finite slots and duplicate outer requests share a proof', async () => {
  const f = await fixture(), gate = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(); let initial = 0; try { f.before(async r => { if (r.purpose === 'resource-object' && initial < 2) { if (++initial === 2) ready.resolve(); await gate.promise; } }); const jobs = [f.request, { ...f.request, fieldPath: [] }, f.request].map(r => f.gateway.explain(r, signal())); await ready.promise; assert.equal(f.reads.length, 2); gate.resolve(); await Promise.all(jobs); assert.equal(f.reads.length, 14); } finally { gate.resolve(); f.close(); }
});
test('already cancelled or closed CRD Explain cannot start metadata/schema transports', async () => {
  const f = await fixture(); try { await assert.rejects(f.gateway.explain(f.request, AbortSignal.abort()), /QUERY_CANCELLED/); f.gateway.close(); await assert.rejects(f.gateway.explain(f.request, signal()), /SERVICE_CLOSED/); assert.equal(f.reads.length, 0); } finally { f.close(); }
});
