// Independent synthetic JSON reads/local buffers only. Never operation clients/planners/writers, real SDK/CLI/auth/files or sessions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { documentRequestSchema, documentPageSchema, documentReferenceSchema, loadDocumentReferenceSchema, customDocumentReferenceFromNode, documentReferenceFromNode, documentReferenceId } from '../../src/shared/document-protocol.ts';
import type { LoadDocumentReference } from '../../src/shared/document-protocol.ts';
import { deleteReferenceSchema } from '../../src/shared/delete-protocol.ts';
import { inspectionRequestSchema } from '../../src/shared/inspection-protocol.ts';
import { explainRequestSchema } from '../../src/shared/explain-protocol.ts';
import { DocumentBuffer } from '../../src/shared/document-buffer.ts';
import { DocumentClient } from '../../src/host/document-client.ts';
import type { DocumentState } from '../../src/host/document-client.ts';
import { explanationRequest } from '../../src/host/document-fields.ts';
import { planLoadDocument, customDocumentProof } from '../../src/service/queries/custom-document.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import { parseReadWorkerStart } from '../../src/service/queries/read-worker-protocol.ts';

const marker = 'SYNTHETIC_PRIVATE', signal = () => new AbortController().signal;
const definition = () => ({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'widgets.example.com', uid: 'd-u', resourceVersion: 'd1', annotations: { private: marker } },
  spec: { group: 'example.com', scope: 'Namespaced', names: { plural: 'widgets', kind: 'Widget', shortNames: ['w'], listKind: 'WidgetCollection' }, versions: [{ name: 'v1', served: true, storage: true }, { name: 'v2', served: true, storage: false }], conversion: { private: marker } } });
const ref: LoadDocumentReference = { type: { group: 'example.com', version: 'v2', resource: 'widgets', kind: 'Widget', scope: 'namespace' }, namespace: 'default', name: 'sample', uid: 'w-u', resourceVersion: 'w1', definition: { name: 'widgets.example.com', uid: 'd-u', resourceVersion: 'd1' } };
const discovery = () => ({ groupVersion: 'example.com/v2', resources: [{ name: 'widgets', kind: 'Widget', namespaced: true, verbs: ['get', 'list'] }, { name: 'widgets/status', kind: 'Widget', namespaced: true, verbs: ['get'] }] });
const instance = (text = marker) => JSON.stringify({ apiVersion: 'example.com/v2', kind: 'Widget', metadata: { name: 'sample', namespace: 'default', uid: 'w-u', resourceVersion: 'w1', managedFields: [{ manager: marker }] }, spec: { private: text } });
const target = { serviceGeneration: 's', projectId: 'p', configIdentity: 'c', context: 'active', namespace: 'default' };
const node = { id: 'synthetic', type: 'resource', label: 'sample', expandable: false, children: 'none', resource: { ...ref.type, name: ref.name, namespace: ref.namespace, uid: ref.uid, resourceVersion: ref.resourceVersion } };
async function fixture(text = marker) {
  let def = definition(), disc = discovery(), raw = instance(text), proofPadding = 0, changed = false, status = 200, statusPath = '', iterated = false, before: ((request: ResourceReadRequest) => Promise<void> | void) | undefined;
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: changed ? 'https://changed.invalid' : 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), request = { protocol: 2 as const, target: { ...target, configIdentity: snapshot.snapshot.configIdentity }, selection: { mode: 'default' as const }, reference: ref, format: 'json' as const }, requests: ResourceReadRequest[] = [];
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, input) => { kubectlReadArguments(input, '/synthetic/pipe'); requests.push(input); await before?.(input);
    const body = input.path.includes('/customresourcedefinitions/') ? JSON.stringify(def).padEnd(proofPadding) : input.purpose === 'api-version' ? JSON.stringify(disc).padEnd(proofPadding) : raw;
    const code = input.path === statusPath ? status : 200;
    return { status: code, body: { async *[Symbol.asyncIterator]() { if (code !== 200) iterated = true; yield Buffer.from(body); } }, close: async () => {} };
  } });
  return { request, requests, gateway, definition: () => def, discovery: () => disc, raw: () => raw, setDefinition(value: typeof def) { def = value; }, setDiscovery(value: typeof disc) { disc = value; }, setRaw(value: string) { raw = value; }, padProofs(bytes: number) { proofPadding = bytes; }, changeConfig() { changed = true; }, before(callback: typeof before) { before = callback; }, status(path: string, code: number) { statusPath = path; status = code; }, iteratedError: () => iterated, close() { gateway.close(); } };
}
test('custom Load requires pinned CRD identity and exact plural.group; builtin reference contract remains unchanged', () => {
  assert.ok(loadDocumentReferenceSchema.safeParse(ref).success); assert.equal(documentReferenceSchema.safeParse(ref).success, false);
  for (const change of [{ definition: undefined }, { definition: { name: 'other.example.com', uid: 'd-u', resourceVersion: 'd1' } }, { path: '/arbitrary' }, { namespace: undefined }, { type: { ...ref.type, group: '' } }]) assert.equal(loadDocumentReferenceSchema.safeParse({ ...ref, ...change }).success, false);
});
test('custom branch nodes produce a Load-only reference, never a builtin resource/operation reference', () => {
  assert.equal(documentReferenceFromNode(node), null); assert.deepEqual(customDocumentReferenceFromNode(node, 'definition' in ref ? ref.definition : null), ref);
  assert.equal(customDocumentReferenceFromNode({ ...node, resource: { ...node.resource, uid: undefined } }, definition().metadata), null);
});
test('CRD Load identity remains rejected by Delete/Explain; inspection has separately reviewed explicit admission', () => {
  assert.equal(deleteReferenceSchema.safeParse(ref).success, false);
  assert.equal(inspectionRequestSchema.safeParse({ protocol: 2, target, selection: { mode: 'default' }, mode: 'describe', reference: ref }).success, true);
  assert.equal(explainRequestSchema.safeParse({ protocol: 2, target, selection: { mode: 'default' }, type: ref.type, fieldPath: [], documentIdentity: 'a'.repeat(64), revision: 0 }).success, false);
});
test('only selected namespace or a real cluster scope can route a CRD instance, never all namespaces or subresources', () => {
  assert.equal(planLoadDocument(ref, target).path, '/apis/example.com/v2/namespaces/default/widgets/sample');
  const cluster = { ...ref, type: { ...ref.type, scope: 'cluster' as const }, namespace: undefined }; assert.equal(planLoadDocument(cluster, target).path, '/apis/example.com/v2/widgets/sample');
  assert.throws(() => planLoadDocument({ ...ref, namespace: 'other' }, target), /STALE_TARGET/);
  for (const resource of ['widgets/status', '../widgets', 'w?exec=true']) assert.throws(() => planLoadDocument({ ...ref, type: { ...ref.type, resource } }, target), /INVALID_INPUT/);
});
test('CRD proof permits the exact served non-storage version but strips schema/annotations/conversion/shortNames', () => {
  const proof = customDocumentProof(definition(), discovery(), ref); assert.equal(proof.includes(marker), false); assert.equal(proof.includes('shortNames'), false); assert.equal(proof.includes('v2'), true);
});
test('definition UID/RV/group/kind/scope or served-version changes cannot redirect Load', () => {
  for (const mode of ['uid', 'rv', 'kind', 'scope', 'served']) { const def = definition(); if (mode === 'uid') def.metadata.uid = 'replacement'; if (mode === 'rv') def.metadata.resourceVersion = 'd2'; if (mode === 'kind') def.spec.names.kind = 'Other'; if (mode === 'scope') def.spec.scope = 'Cluster'; if (mode === 'served') { const version = def.spec.versions.find(v => v.name === 'v2'); assert.ok(version); version.served = false; }
    assert.throws(() => customDocumentProof(def, discovery(), ref), /STALE_TARGET/);
  }
});
test('discovery must advertise the same full GVR/kind/scope and listing capability; no preferred-version fallback', () => {
  for (const disc of [{ ...discovery(), groupVersion: 'example.com/v1' }, { ...discovery(), resources: [] }, { ...discovery(), resources: [{ name: 'widgets', kind: 'Other', namespaced: true, verbs: ['list'] }] }, { ...discovery(), resources: [{ name: 'widgets', kind: 'Widget', namespaced: false, verbs: ['list'] }] }, { ...discovery(), resources: [{ name: 'widgets', kind: 'Widget', namespaced: true, verbs: ['get'] }] }]) assert.throws(() => customDocumentProof(definition(), disc, ref), /STALE_TARGET/);
});
test('one named CRD Load brackets lossless instance reading with fresh definition/discovery in the existing finite pool', async () => {
  const f = await fixture(); try { const page = await f.gateway.readDocument(f.request, signal()); assert.ok(page.text.includes(marker)); assert.equal(page.text.includes('managedFields'), false); assert.deepEqual(page.reference, ref);
    assert.deepEqual(f.requests.map(r => r.path), ['/apis/apiextensions.k8s.io/v1/customresourcedefinitions/widgets.example.com', '/apis/example.com/v2', '/apis/example.com/v2/namespaces/default/widgets/sample', '/apis/apiextensions.k8s.io/v1/customresourcedefinitions/widgets.example.com', '/apis/example.com/v2']); assert.equal(f.requests.every(r => r.method === 'GET'), true);
  } finally { f.close(); }
});
test('CRD JSON/YAML Load preserves integer/exponent/decimal lexical content without reserializing through Number', async () => {
  for (const format of ['json', 'yaml'] as const) { const f = await fixture(); try { f.setRaw(instance().replace('"spec":', '"large":9223372036854775807,"negative":-0,"fraction":0.10000000000000000001,"exponent":1e400,"spec":'));
    const page = await f.gateway.readDocument({ ...f.request, format }, signal()); for (const token of ['9223372036854775807', '-0', '0.10000000000000000001', '1e400']) assert.ok(page.text.includes(token)); }
    finally { f.close(); }
  }
});
test('cluster-scoped CRD objects load without inventing a namespace or altering the browsing namespace', async () => {
  const f = await fixture(); try { const def = f.definition(); def.spec.scope = 'Cluster'; f.setDefinition(def); const disc = f.discovery(); const entry = disc.resources[0]; assert.ok(entry); entry.namespaced = false; f.setDiscovery(disc); f.setRaw(instance().replace('"namespace":"default",', ''));
    const reference = { ...ref, namespace: undefined, type: { ...ref.type, scope: 'cluster' as const } }; const page = await f.gateway.readDocument({ ...f.request, reference }, signal()); assert.equal(page.reference.namespace, undefined); assert.equal(page.target.namespace, 'default'); assert.ok(f.requests.some(r => r.path === '/apis/example.com/v2/widgets/sample'));
  } finally { f.close(); }
});
test('post-read definition or discovery drift discards otherwise valid instance text', async () => {
  for (const mode of ['definition', 'discovery']) { const f = await fixture(); try { let proofs = 0; f.before(request => { if (request.path.includes('/customresourcedefinitions/') && ++proofs === 2) { if (mode === 'definition') { const def = f.definition(); def.metadata.resourceVersion = 'd2'; f.setDefinition(def); } else { const disc = f.discovery(); const entry = disc.resources[0]; assert.ok(entry); entry.kind = 'Other'; f.setDiscovery(disc); } } }); await assert.rejects(f.gateway.readDocument(f.request, signal()), /STALE_TARGET/); }
    finally { f.close(); }
  }
});
test('same CRD UID/RV with changed routing fields/versions also fails the stripped before/after proof', async () => {
  const f = await fixture(); try { let proofs = 0; f.before(request => { if (request.path.includes('/customresourcedefinitions/') && ++proofs === 2) { const def = f.definition(); def.spec.names.listKind = 'ChangedCollection'; f.setDefinition(def); } }); await assert.rejects(f.gateway.readDocument(f.request, signal()), /STALE_TARGET/); } finally { f.close(); }
});
test('wrong instance UID/RV/name/GVK or namespace never reaches a document buffer', async () => {
  for (const change of ['"uid":"w-u"', '"resourceVersion":"w1"', '"name":"sample"', '"kind":"Widget"', '"namespace":"default"', '"apiVersion":"example.com/v2"']) { const f = await fixture(); try { const value = f.raw(); const index = value.indexOf(change); assert.ok(index >= 0); f.setRaw(value.replace(change, change.replace(/:"[^"]+"$/, ':"wrong"'))); await assert.rejects(f.gateway.readDocument(f.request, signal()), /STALE_TARGET/); } finally { f.close(); } }
});
test('permission/notfound/auth failures at definition/discovery/instance never iterate or leak error bodies', async () => {
  for (const [path, status, code] of [['/apis/apiextensions.k8s.io/v1/customresourcedefinitions/widgets.example.com', 403, 'FORBIDDEN'], ['/apis/example.com/v2', 404, 'NOT_FOUND'], ['/apis/example.com/v2/namespaces/default/widgets/sample', 401, 'UNAUTHENTICATED']] as const) { const f = await fixture(); try { f.status(path, status); await assert.rejects(f.gateway.readDocument(f.request, signal()), new RegExp(code)); assert.equal(f.iteratedError(), false); } finally { f.close(); } }
});
test('config change between proofs and document reading rejects the original target without a second route', async () => {
  const f = await fixture(); try { f.before(request => { if (request.purpose === 'api-version') f.changeConfig(); }); await assert.rejects(f.gateway.readDocument(f.request, signal()), /STALE_TARGET/); assert.equal(f.requests.some(r => r.path.endsWith('/widgets/sample')), false); } finally { f.close(); }
});
test('cancellation after a proof read prevents any instance GET', async () => {
  const f = await fixture(), controller = new AbortController(); try { f.before(() => { controller.abort(); }); await assert.rejects(f.gateway.readDocument(f.request, controller.signal), /QUERY_CANCELLED/); assert.equal(f.requests.length, 1); } finally { f.close(); }
});
test('continuation fetches all five fresh proofs/reads again and preserves the original content identity', async () => {
  const f = await fixture('😀'.repeat(40_000)); try { const first = await f.gateway.readDocument(f.request, signal()); assert.ok(first.nextCursor); const next = await f.gateway.readDocument({ ...f.request, cursor: first.nextCursor }, signal()); assert.equal(next.contentIdentity, first.contentIdentity); assert.equal(next.offset, first.end); assert.equal(f.requests.length, 10); } finally { f.close(); }
});
test('CRD/instance replacement between document chunks cannot continue an older document', async () => {
  for (const mode of ['definition', 'instance']) { const f = await fixture('x'.repeat(70_000)); try { const first = await f.gateway.readDocument(f.request, signal()); assert.ok(first.nextCursor); if (mode === 'definition') { const def = f.definition(); def.metadata.uid = 'replacement'; f.setDefinition(def); } else f.setRaw(f.raw().replace('"w-u"', '"replacement"')); await assert.rejects(f.gateway.readDocument({ ...f.request, cursor: first.nextCursor }, signal()), /STALE_TARGET/); } finally { f.close(); } }
});
test('sealed cursor binding rejects a new definition identity before issuing any read', async () => {
  const f = await fixture('x'.repeat(70_000)); try { const first = await f.gateway.readDocument(f.request, signal()); assert.ok(first.nextCursor && 'definition' in ref); const count = f.requests.length; await assert.rejects(f.gateway.readDocument({ ...f.request, cursor: first.nextCursor, reference: { ...ref, definition: { ...ref.definition, resourceVersion: 'd2' } } }, signal()), /STALE_TARGET/); assert.equal(f.requests.length, count); } finally { f.close(); }
});
test('reference identity includes definition UID/RV so client DTO substitution is not hidden by equal instance fields', () => {
  assert.ok('definition' in ref); assert.notEqual(documentReferenceId(ref), documentReferenceId({ ...ref, definition: { ...ref.definition, uid: 'replacement' } }));
});
test('client rejects forged response definition identity before displaying text or constructing an editor', async () => {
  const f = await fixture(), states: DocumentState[] = []; try { const original = await f.gateway.readDocument(f.request, signal()); assert.ok('definition' in original.reference); const page = { ...original, reference: { ...original.reference, definition: { ...original.reference.definition, uid: 'replacement' } } };
    const client = new DocumentClient(async () => ({ status: 200, body: JSON.stringify(page) }), state => states.push(state)); await client.read(f.request); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.editor, undefined); client.dispose();
  } finally { f.close(); }
});
test('CRD client completes a real synthetic gateway document and supports pure editing/dirty protection, without another read', async () => {
  const f = await fixture(), states: DocumentState[] = []; let calls = 0; const client = new DocumentClient(async request => { calls++; return { status: 200, body: JSON.stringify(await f.gateway.readDocument(JSON.parse(request.body) as unknown, signal())) }; }, state => states.push(state));
  try { await client.read(f.request); assert.ok(states.at(-1)?.editor); client.edit('{"apiVersion":"example.com/v2","kind":"Widget"}'); client.analyse(); assert.ok(states.at(-1)?.editor?.analysis); await client.read(f.request); assert.equal(calls, 1); assert.equal(states.at(-1)?.error, 'DOCUMENT_DIRTY'); assert.ok(states.at(-1)?.editor?.analysis); } finally { client.dispose(); f.close(); }
});
test('detached CRD buffer clones/freezes definition identity, not a mutable external authorization object', () => {
  assert.ok('definition' in ref); const reference = { ...ref, definition: { ...ref.definition } }, buffer = new DocumentBuffer(instance(), { target, reference, format: 'json', contentIdentity: 'a'.repeat(64) }); reference.definition.uid = 'mutated'; assert.ok('definition' in buffer.state.origin.reference); assert.equal(buffer.state.origin.reference.definition.uid, 'd-u'); assert.ok(Object.isFrozen(buffer.state.origin.reference.definition));
});
test('CRD Load Explain now has separate explicit metadata admission bound to the original definition, never the body', async () => {
  const f = await fixture(); try { const page = await f.gateway.readDocument(f.request, signal()), buffer = new DocumentBuffer(page.text, page); const request = explanationRequest({ phase: 'ready', stale: false, text: page.text, complete: true, source: f.request, page, editor: buffer.state }, '0', 0); assert.ok('definition' in ref); assert.deepEqual(request.definition, ref.definition); assert.equal(JSON.stringify(request).includes(marker), false); } finally { f.close(); }
});
test('old builtin Load still admits unchanged reference and response shapes', () => {
  const reference = { type: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' }, namespace: 'default', name: 'p', uid: 'u', resourceVersion: 'r' };
  assert.ok(loadDocumentReferenceSchema.safeParse(reference).success); assert.ok(documentReferenceSchema.safeParse(reference).success); assert.equal('definition' in loadDocumentReferenceSchema.parse(reference), false);
});
test('custom reference cannot impersonate a builtin and extra schema/credential fields are never accepted', () => {
  for (const value of [{ ...ref, type: { group: 'apps', version: 'v1', resource: 'deployments', kind: 'Deployment', scope: 'namespace' }, definition: { name: 'deployments.apps', uid: 'd', resourceVersion: 'r' } }, { ...ref, definition: { ...definition().metadata, secret: marker } }, { ...ref, credential: marker }]) assert.equal(loadDocumentReferenceSchema.safeParse(value).success, false);
});
test('document protocol roundtrips the pinned definition metadata but no raw CRD schema/conversion content', async () => {
  const f = await fixture(); try { const response = await f.gateway.readDocument(f.request, signal()); assert.ok(documentRequestSchema.safeParse(f.request).success); assert.ok(documentPageSchema.safeParse(response).success); assert.equal(JSON.stringify(response.reference).includes(marker), false); } finally { f.close(); }
});
test('custom document worker admission requires exact reference/path/namespace and GET-only bounded raw argv', () => {
  const request = { method: 'GET', purpose: 'custom-document', target, path: planLoadDocument(ref, target).path, query: {}, maximumBytes: 2_000_000, customDocument: ref } as const;
  const start = { protocol: 1, kind: 'read', snapshot: new Uint8Array([1]), path: '/synthetic/bin', request };
  assert.deepEqual(parseReadWorkerStart(start).request.customDocument, ref);
  const args = kubectlReadArguments(request, '/synthetic/config.pipe'); assert.ok(args.includes(`--raw=${request.path}`) && args.includes('get')); assert.equal(args.includes('describe'), false);
  for (const change of [{ customDocument: undefined }, { method: 'POST' }, { maximumBytes: 8_000_000 }, { query: { watch: 'true' } }, { path: `${request.path}/status` }, { path: request.path.replace('/sample', '/other') }, { path: request.path.replace('/default/', '/other/') }, { customDocument: { ...ref, namespace: 'other' } }]) assert.throws(() => parseReadWorkerStart({ ...start, request: { ...request, ...change } }));
});
test('new custom document purpose does not widen builtin raw object or printer/other worker requests', () => {
  const request = { method: 'GET', purpose: 'custom-document', target, path: planLoadDocument(ref, target).path, query: {}, maximumBytes: 2_000_000, customDocument: ref } as const;
  for (const purpose of ['resource-object', 'resource-wide', 'resource-describe'] as const) {
    assert.throws(() => kubectlReadArguments({ ...request, purpose }, '/synthetic/config.pipe'), /INVALID_INPUT/);
    const { customDocument: _reference, ...withoutReference } = request;
    assert.throws(() => kubectlReadArguments({ ...withoutReference, purpose }, '/synthetic/config.pipe'), /INVALID_INPUT/);
  }
  assert.throws(() => kubectlReadArguments({ ...request, customDocument: { ...ref, type: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' } } }, '/synthetic/config.pipe'), /INVALID_INPUT/);
});
test('CRD proof identity is semantic and does not depend on external property insertion order', () => {
  assert.ok('definition' in ref); assert.equal(customDocumentProof(definition(), discovery(), ref), customDocumentProof(definition(), discovery(), { ...ref, definition: { resourceVersion: 'd1', uid: 'd-u', name: 'widgets.example.com' } }));
});
test('CRD proof and instance responses enforce per-read 2MB, rendered 1MiB and aggregate 8MB limits', async () => {
  for (const mode of ['per-read', 'rendered', 'aggregate']) { const f = await fixture(mode === 'aggregate' ? 'x'.repeat(300_000) : mode === 'rendered' ? 'x'.repeat(1_048_576) : marker);
    try { if (mode === 'per-read') f.padProofs(2_000_001); if (mode === 'aggregate') f.padProofs(1_950_000); await assert.rejects(f.gateway.readDocument(f.request, signal()), /BUDGET_EXCEEDED/); assert.ok(f.requests.length <= 5); }
    finally { f.close(); }
  }
});
test('distinct CRD Loads share the two finite read slots and duplicate consumers share a load, without nested deadlock', async () => {
  const f = await fixture(); let release: () => void = () => {}, started: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }), twoStarted = new Promise<void>(resolve => { started = resolve; }); let firstReads = 0;
  try { f.before(async request => { if (request.path.includes('/customresourcedefinitions/') && firstReads < 2) { if (++firstReads === 2) started(); await gate; } });
    const jobs = (['json', 'yaml', 'json'] as const).map(format => f.gateway.readDocument({ ...f.request, format }, signal())); await twoStarted; assert.equal(f.requests.length, 2); release(); const pages = await Promise.all(jobs); assert.equal(pages.length, 3); assert.equal(f.requests.length, 10);
  } finally { release(); f.close(); }
});
test('generic builtin reference verification rejects a custom Load reference before issuing reads', async () => {
  const f = await fixture(); try { await assert.rejects(f.gateway.verifyReference({ selection: f.request.selection, target: f.request.target, reference: ref }, signal()), /INVALID_INPUT/); assert.equal(f.requests.length, 0); } finally { f.close(); }
});
