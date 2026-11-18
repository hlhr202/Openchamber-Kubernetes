// Independent synthetic GET/printer responses, protocol and pure client only. No SDK/CLI/worker/files or write handlers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { inspectionBytes, inspectionRequestSchema, inspectionPageSchema, sameInspectionObject } from '../../src/shared/inspection-protocol.ts';
import type { InspectionReference } from '../../src/shared/inspection-protocol.ts';
import { documentReferenceSchema, documentReferenceId } from '../../src/shared/document-protocol.ts';
import { deleteReferenceSchema } from '../../src/shared/delete-protocol.ts';
import { explainRequestSchema } from '../../src/shared/explain-protocol.ts';
import { InspectionClient } from '../../src/host/inspection-client.ts';
import type { InspectionState } from '../../src/host/inspection-client.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { createInspectionReader } from '../../src/service/queries/inspection-output.ts';
import { createResourceReader } from '../../src/service/queries/resource-reader.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { parseReadWorkerStart } from '../../src/service/queries/read-worker-protocol.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';

const signal = () => new AbortController().signal, marker = 'SYNTHETIC_PRIVATE_OUTPUT';
const reference: InspectionReference = { type: { group: 'example.com', version: 'v2', resource: 'widgets', kind: 'Widget', scope: 'namespace' }, namespace: 'default', name: 'sample', uid: 'u', resourceVersion: 'r1', definition: { name: 'widgets.example.com', uid: 'd', resourceVersion: 'd1' } };
const object = () => ({ apiVersion: 'example.com/v2', kind: 'Widget', metadata: { name: 'sample', namespace: 'default', uid: 'u', resourceVersion: 'r1' }, spec: { private: marker } });
const definition = () => ({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'widgets.example.com', uid: 'd', resourceVersion: 'd1', annotations: { private: marker } }, spec: { group: 'example.com', scope: 'Namespaced', names: { plural: 'widgets', kind: 'Widget', listKind: 'WidgetCollection' }, versions: [{ name: 'v1', storage: true, served: true }, { name: 'v2', storage: false, served: true }] } });
const discovery = () => ({ groupVersion: 'example.com/v2', resources: [{ name: 'widgets', kind: 'Widget', namespaced: true, verbs: ['get', 'list'] }] });
async function fixture(output = 'NAME\tAGE\r\nsample\t1m\r\n') {
  let raw = object(), def = definition(), disc = discovery(), text = output, changedConfig = false, padding = 0, status = 200, failingPurpose = '', errorIterated = false;
  let before: ((request: ResourceReadRequest) => void | Promise<void>) | undefined;
  const requests: ResourceReadRequest[] = [], states: InspectionState[] = [];
  const config = createConfigReader('/synthetic', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: changedConfig ? 'https://changed.invalid' : 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), target = { serviceGeneration: 's', projectId: 'p', configIdentity: snapshot.snapshot.configIdentity, context: 'active', namespace: 'default' };
  const request = { protocol: 2 as const, selection: { mode: 'default' as const }, target, reference, mode: 'wide' as const };
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, input) => {
    kubectlReadArguments(input, '/synthetic/config.pipe'); requests.push(input); await before?.(input);
    const printer = input.purpose === 'custom-wide' || input.purpose === 'custom-describe', value = input.path.includes('/customresourcedefinitions/') ? def : input.purpose === 'api-version' ? disc : raw;
    const body = printer ? text : JSON.stringify(value).padEnd(padding), code = input.purpose === failingPurpose ? status : 200;
    return { status: code, body: { async *[Symbol.asyncIterator]() { if (code !== 200) errorIterated = true; yield Buffer.from(body); } }, close: async () => {} };
  } });
  const transport = async (input: { method: 'POST'; path: string; body: string }) => {
    assert.equal(input.path, '/v2/inspection/read'); try { return { status: 200, body: JSON.stringify(await gateway.readInspection(JSON.parse(input.body) as unknown, signal())) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  };
  const client = new InspectionClient(transport, state => states.push(state));
  return { request, target, gateway, client, states, requests, transport, raw: () => raw, definition: () => def, discovery: () => disc,
    setRaw(value: typeof raw) { raw = value; }, setDefinition(value: typeof def) { def = value; }, setDiscovery(value: typeof disc) { disc = value; }, setOutput(value: string) { text = value; }, padJson(bytes: number) { padding = bytes; },
    before(callback: typeof before) { before = callback; }, fail(purpose: string, code: number) { failingPurpose = purpose; status = code; }, errorIterated: () => errorIterated, changeConfig() { changedConfig = true; }, close() { client.dispose(); gateway.close(); } };
}
test('inspection explicitly admits pinned CRD references but cannot authorize Delete/Explain or generic builtin verification', async () => {
  const f = await fixture(); try { assert.ok(inspectionRequestSchema.safeParse(f.request).success); assert.equal(documentReferenceSchema.safeParse(reference).success, false); assert.equal(deleteReferenceSchema.safeParse(reference).success, false);
    assert.equal(explainRequestSchema.safeParse({ protocol: 2, target: f.target, selection: f.request.selection, type: reference.type, fieldPath: [], documentIdentity: 'a'.repeat(64), revision: 0 }).success, false);
    await assert.rejects(f.gateway.verifyReference({ target: f.target, selection: f.request.selection, reference }, signal()), /INVALID_INPUT/); assert.equal(f.requests.length, 0);
  } finally { f.close(); }
});
test('custom inspection schema rejects unpinned types, arbitrary arguments and refresh-plus-cursor', async () => {
  const f = await fixture(); try { for (const change of [{ reference: { ...reference, definition: undefined } }, { reference: { ...reference, namespace: undefined } }, { mode: 'exec' }, { argv: ['describe'] }, { url: 'https://invalid' }, { refresh: true, cursor: 'opaque' }]) assert.equal(inspectionRequestSchema.safeParse({ ...f.request, ...change }).success, false); } finally { f.close(); }
});
test('CRD wide output is one real printer bracketed by two exact CRD/discovery and instance proofs', async () => {
  const output = 'NAME\tAGE\r\nsample\t1m\r\n', f = await fixture(output); try { const page = await f.gateway.readInspection(f.request, signal()); assert.equal(page.text, output); assert.ok(page.mode !== 'cluster-info'); assert.deepEqual(page.reference, reference);
    assert.deepEqual(f.requests.map(r => r.purpose), ['resource-object', 'api-version', 'custom-document', 'custom-wide', 'custom-document', 'resource-object', 'api-version']);
    assert.equal(JSON.stringify(page.reference).includes(marker), false); assert.ok(inspectionPageSchema.safeParse(page).success);
  } finally { f.close(); }
});
test('custom-wide private worker args use fixed full GVR/name wide printer and cache sentinel, never raw', async () => {
  const f = await fixture(); try { await f.gateway.readInspection(f.request, signal()); const request = f.requests.find(r => r.purpose === 'custom-wide'); assert.ok(request); const args = kubectlReadArguments(request, '/synthetic/config.pipe');
    for (const arg of ['get', 'widgets.v2.example.com/sample', '--output=wide', '--server-print=true', '--cache-dir=/dev/null', '--context=active', '--namespace=default', '--chunk-size=100']) assert.ok(args.includes(arg)); assert.equal(args.some(a => a.startsWith('--raw=')), false);
    assert.equal(parseReadWorkerStart({ protocol: 1, kind: 'read', request, snapshot: new Uint8Array([1]), path: '/synthetic/bin' }).request.purpose, 'custom-wide');
  } finally { f.close(); }
});
test('custom Describe uses one qualified TYPE/NAME and real events, without raw conversion or prefix fallback', async () => {
  const f = await fixture('Name: sample\nEvents: none\n'); try { const page = await f.gateway.readInspection({ ...f.request, mode: 'describe' }, signal()), request = f.requests.find(r => r.purpose === 'custom-describe'); assert.ok(request); assert.equal(page.mode, 'describe'); const args = kubectlReadArguments(request, '/synthetic/config.pipe'); assert.ok(args.includes('describe') && args.includes('widgets.v2.example.com/sample') && args.includes('--show-events=true')); assert.equal(args.includes('--output=wide'), false); } finally { f.close(); }
});
test('custom printer worker admission rejects missing/changed identity, alternate paths/namespace/query/method/budget', async () => {
  const f = await fixture(); try { await f.gateway.readInspection(f.request, signal()); const request = f.requests.find(r => r.purpose === 'custom-wide'); assert.ok(request);
    for (const change of [{ customInspection: undefined }, { path: `${request.path}/status` }, { path: request.path.replace('/sample', '/other') }, { path: request.path.replace('/default/', '/other/') }, { query: { watch: 'true' } }, { method: 'POST' }, { maximumBytes: 8_000_000 }, { customDocument: reference }, { customInspection: { ...reference, definition: undefined } }]) assert.throws(() => parseReadWorkerStart({ protocol: 1, kind: 'read', snapshot: new Uint8Array([1]), path: '/synthetic/bin', request: { ...request, ...change } }));
  } finally { f.close(); }
});
test('custom printer references cannot widen original resource-wide/resource-describe/resource-object purposes', async () => {
  const f = await fixture(); try { await f.gateway.readInspection(f.request, signal()); const request = f.requests.find(r => r.purpose === 'custom-wide'); assert.ok(request); for (const purpose of ['resource-wide', 'resource-describe', 'resource-object', 'custom-document'] as const) assert.throws(() => kubectlReadArguments({ ...request, purpose }, '/synthetic/config.pipe'), /INVALID_INPUT/); } finally { f.close(); }
});
test('namespace CRD inspection cannot route to a different browsing namespace', async () => {
  const f = await fixture(); try { await assert.rejects(f.gateway.readInspection({ ...f.request, reference: { ...reference, namespace: 'other' } }, signal()), /STALE_TARGET/); assert.equal(f.requests.length, 0); } finally { f.close(); }
});
test('cluster-scoped custom printer routes without an object namespace and leaves browsing namespace unchanged', async () => {
  const f = await fixture(); try { const def = f.definition(); def.spec.scope = 'Cluster'; const disc = f.discovery(), entry = disc.resources[0]; assert.ok(entry); entry.namespaced = false; f.setDefinition(def); f.setDiscovery(disc); const raw = f.raw(); const { namespace: _namespace, ...metadata } = raw.metadata; f.setRaw({ ...raw, metadata } as typeof raw);
    const page = await f.gateway.readInspection({ ...f.request, reference: { ...reference, namespace: undefined, type: { ...reference.type, scope: 'cluster' } } }, signal()); assert.equal(page.target.namespace, 'default'); assert.ok(page.mode !== 'cluster-info'); assert.equal(page.reference.namespace, undefined); const printer = f.requests.find(r => r.purpose === 'custom-wide'); assert.ok(printer); assert.equal(printer.path, '/apis/example.com/v2/widgets/sample');
  } finally { f.close(); }
});
test('pinned served non-storage version stays selected even when another version is storage', async () => {
  const f = await fixture(); try { await f.gateway.readInspection(f.request, signal()); assert.ok(f.requests.every(r => !r.path.includes('/v1/namespaces/'))); assert.ok(f.requests.find(r => r.purpose === 'custom-wide')?.path.includes('/v2/')); } finally { f.close(); }
});
test('CRD identity or served/discovery mismatch before output prevents printer dispatch', async () => {
  for (const mode of ['uid', 'rv', 'served', 'discovery']) { const f = await fixture(); try { if (mode === 'discovery') { const disc = f.discovery(); disc.groupVersion = 'example.com/v1'; f.setDiscovery(disc); } else { const def = f.definition(); if (mode === 'uid') def.metadata.uid = 'replacement'; if (mode === 'rv') def.metadata.resourceVersion = 'd2'; if (mode === 'served') { const v = def.spec.versions[1]; assert.ok(v); v.served = false; } f.setDefinition(def); }
    await assert.rejects(f.gateway.readInspection(f.request, signal()), /STALE_TARGET/); assert.equal(f.requests.some(r => r.purpose === 'custom-wide'), false);
  } finally { f.close(); } }
});
test('wrong instance UID/RV/GVK/name before output does not print a substitute', async () => {
  for (const mode of ['uid', 'rv', 'kind', 'name']) { const f = await fixture(); try { const raw = f.raw(); if (mode === 'uid') raw.metadata.uid = 'other'; if (mode === 'rv') raw.metadata.resourceVersion = 'r2'; if (mode === 'kind') raw.kind = 'Other'; if (mode === 'name') raw.metadata.name = 'other'; f.setRaw(raw); await assert.rejects(f.gateway.readInspection(f.request, signal()), /STALE_TARGET/); assert.equal(f.requests.length, 3); } finally { f.close(); } }
});
test('instance drift after printer discards otherwise valid output before it reaches a client', async () => {
  const f = await fixture(marker); try { f.before(r => { if (r.purpose === 'custom-wide') { const raw = f.raw(); raw.metadata.resourceVersion = 'r2'; f.setRaw(raw); } }); await f.client.read(f.request); assert.equal(f.states.at(-1)?.error, 'STALE_TARGET'); assert.equal(f.states.at(-1)?.text, ''); } finally { f.close(); }
});
test('post-printer definition/discovery drift rejects output rather than treating initial proof as permission forever', async () => {
  for (const mode of ['definition', 'discovery', 'routing']) { const f = await fixture(); try { f.before(r => { if (r.purpose === 'custom-wide') { if (mode === 'discovery') { const disc = f.discovery(), entry = disc.resources[0]; assert.ok(entry); entry.kind = 'Other'; f.setDiscovery(disc); } else { const def = f.definition(); if (mode === 'definition') def.metadata.resourceVersion = 'd2'; else def.spec.names.listKind = 'Changed'; f.setDefinition(def); } } }); await assert.rejects(f.gateway.readInspection(f.request, signal()), /STALE_TARGET/); } finally { f.close(); } }
});
test('configuration drift between proof reads and printer prevents another target dispatch', async () => {
  const f = await fixture(); try { f.before(r => { if (r.purpose === 'api-version') f.changeConfig(); }); await assert.rejects(f.gateway.readInspection(f.request, signal()), /STALE_TARGET/); assert.equal(f.requests.length, 2); } finally { f.close(); }
});
test('permission/notfound/throttle responses never iterate their sensitive error bodies or retry', async () => {
  for (const [purpose, code, expected] of [['resource-object', 403, 'FORBIDDEN'], ['api-version', 404, 'NOT_FOUND'], ['custom-document', 401, 'UNAUTHENTICATED'], ['custom-wide', 429, 'QUERY_LIMIT']] as const) { const f = await fixture(marker); try { f.fail(purpose, code); await assert.rejects(f.gateway.readInspection(f.request, signal()), new RegExp(expected)); assert.equal(f.errorIterated(), false); assert.equal(f.requests.filter(r => r.purpose === purpose).length, 1); } finally { f.close(); } }
});
test('cancellation after a proof response prevents later GETs and output', async () => {
  const f = await fixture(), controller = new AbortController(); try { f.before(() => controller.abort()); await assert.rejects(f.gateway.readInspection(f.request, controller.signal), /QUERY_CANCELLED/); assert.equal(f.requests.length, 1); } finally { f.close(); }
});
test('custom snapshot continuation repeats five fresh proofs but never reruns the changing printer', async () => {
  const text = '😀'.repeat(40_000), f = await fixture(text); try { const first = await f.gateway.readInspection(f.request, signal()); assert.ok(first.nextCursor); f.setOutput('new AGE'); const next = await f.gateway.readInspection({ ...f.request, cursor: first.nextCursor }, signal()); assert.equal(first.text + next.text, text); assert.equal(first.contentIdentity, next.contentIdentity); assert.equal(f.requests.length, 12); assert.equal(f.requests.filter(r => r.purpose === 'custom-wide').length, 1); } finally { f.close(); }
});
test('CRD or instance replacement between chunks cannot continue an older printer snapshot', async () => {
  for (const mode of ['definition', 'instance']) { const f = await fixture('x'.repeat(70_000)); try { const first = await f.gateway.readInspection(f.request, signal()); assert.ok(first.nextCursor); if (mode === 'definition') { const def = f.definition(); def.metadata.uid = 'replacement'; f.setDefinition(def); } else { const raw = f.raw(); raw.metadata.resourceVersion = 'r2'; f.setRaw(raw); } await assert.rejects(f.gateway.readInspection({ ...f.request, cursor: first.nextCursor }, signal()), /STALE_TARGET/); assert.equal(f.requests.filter(r => r.purpose === 'custom-wide').length, 1); } finally { f.close(); } }
});
test('sealed inspection cursor rejects a different CRD identity before reading any metadata', async () => {
  const f = await fixture('x'.repeat(70_000)); try { const first = await f.gateway.readInspection(f.request, signal()); assert.ok(first.nextCursor && 'definition' in reference); const count = f.requests.length; await assert.rejects(f.gateway.readInspection({ ...f.request, cursor: first.nextCursor, reference: { ...reference, definition: { ...reference.definition, resourceVersion: 'd2' } } }, signal()), /STALE_TARGET/); assert.equal(f.requests.length, count); } finally { f.close(); }
});
test('explicit custom Refresh captures only a new RV of the same instance while retaining definition identity', async () => {
  const f = await fixture(); try { await f.client.read(f.request); const raw = f.raw(); raw.metadata.resourceVersion = 'r2'; f.setRaw(raw); f.setOutput('refreshed'); await f.client.refresh(); const state = f.states.at(-1); assert.equal(state?.text, 'refreshed'); assert.ok(state?.source && state.source.mode !== 'cluster-info'); assert.equal(state.source.reference.resourceVersion, 'r2'); assert.ok('definition' in state.source.reference && 'definition' in reference); assert.deepEqual(state.source.reference.definition, reference.definition); assert.equal('refresh' in state.source, false); assert.equal(reference.resourceVersion, 'r1'); } finally { f.close(); }
});
test('explicit Refresh does not adopt a replacement instance UID or newer CRD definition', async () => {
  for (const mode of ['uid', 'definition']) { const f = await fixture('old'); try { await f.client.read(f.request); if (mode === 'uid') { const raw = f.raw(); raw.metadata.uid = 'replacement'; f.setRaw(raw); } else { const def = f.definition(); def.metadata.resourceVersion = 'd2'; f.setDefinition(def); } await f.client.refresh(); assert.equal(f.states.at(-1)?.error, 'STALE_TARGET'); assert.equal(f.states.at(-1)?.text, 'old'); assert.equal(f.states.at(-1)?.stale, true); } finally { f.close(); } }
});
test('refreshed custom reference binds normalized cursor so continuation verifies its captured RV without another printer', async () => {
  const f = await fixture('old'); try { await f.client.read(f.request); const raw = f.raw(); raw.metadata.resourceVersion = 'r2'; f.setRaw(raw); const text = 'x'.repeat(70_000); f.setOutput(text); await f.client.refresh(); await f.client.next(); assert.equal(f.states.at(-1)?.text, text); assert.equal(f.states.at(-1)?.complete, true); assert.equal(f.requests.filter(r => r.purpose === 'custom-wide').length, 2); } finally { f.close(); }
});
test('custom refresh identity comparison includes pinned CRD UID/RV even if only instance RV is allowed to advance', () => {
  assert.ok('definition' in reference); const next = { ...reference, resourceVersion: 'r2' }; assert.ok(sameInspectionObject(reference, next)); assert.notEqual(documentReferenceId(reference), documentReferenceId(next)); assert.equal(sameInspectionObject(reference, { ...next, definition: { ...reference.definition, uid: 'other' } }), false);
});
test('client rejects forged custom output definition before displaying text even on Refresh', async () => {
  const f = await fixture(), states: InspectionState[] = []; try { const page = await f.gateway.readInspection(f.request, signal()); assert.ok(page.mode !== 'cluster-info' && 'definition' in page.reference); const forged = { ...page, reference: { ...page.reference, definition: { ...page.reference.definition, uid: 'other' } } }; const client = new InspectionClient(async () => ({ status: 200, body: JSON.stringify(forged) }), s => states.push(s)); await client.read(f.request); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.text, ''); await client.refresh(); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); client.dispose(); } finally { f.close(); }
});
test('custom printer output is complete read-only text and cannot create an edit buffer or mutate origin references', async () => {
  const f = await fixture('<script>literal</script>'); try { await f.client.read({ ...f.request, mode: 'describe' }); const state = f.states.at(-1); assert.equal(state?.complete, true); assert.equal('editor' in (state ?? {}), false); assert.equal(state?.text, '<script>literal</script>'); assert.ok(state?.source && state.source.mode !== 'cluster-info' && 'definition' in state.source.reference); assert.ok(Object.isFrozen(state.source.reference.definition)); } finally { f.close(); }
});
test('client reset rejects late custom output and performs no business cancellation or cleanup', async () => {
  const f = await fixture(), states: InspectionState[] = []; try { const page = await f.gateway.readInspection(f.request, signal()), deferred = Promise.withResolvers<{ status: number; body: string }>(), client = new InspectionClient(async () => deferred.promise, state => states.push(state)); const pending = client.read(f.request); client.reset(); deferred.resolve({ status: 200, body: JSON.stringify(page) }); await pending; assert.equal(states.at(-1)?.phase, 'idle'); assert.equal(states.at(-1)?.text, ''); client.dispose(); } finally { f.close(); }
});
test('custom inspection applies per-response/output and aggregate budgets without truncating into success', async () => {
  for (const mode of ['response', 'output', 'aggregate']) { const f = await fixture(mode === 'output' ? 'x'.repeat(inspectionBytes + 1) : 'x'.repeat(1000)); try { if (mode === 'response') f.padJson(2_000_001); if (mode === 'aggregate') f.padJson(2_000_000); await assert.rejects(f.gateway.readInspection(f.request, signal()), /BUDGET_EXCEEDED/); assert.ok(f.requests.length <= 7); } finally { f.close(); } }
});
test('custom continuation retains its independent 8MB proof budget and cannot dispatch another printer on overflow', async () => {
  const f = await fixture('x'.repeat(70_000)); try { const page = await f.gateway.readInspection(f.request, signal()); assert.ok(page.nextCursor); f.padJson(2_000_000); await assert.rejects(f.gateway.readInspection({ ...f.request, cursor: page.nextCursor }, signal()), /BUDGET_EXCEEDED/); assert.equal(f.requests.filter(r => r.purpose === 'custom-wide').length, 1); } finally { f.close(); }
});
test('custom snapshots still expire at the fixed deadline before any fresh proof or printer dispatch', async () => {
  const f = await fixture(); let now = 1000, checks = 0; try { const reader = createInspectionReader({ inspect: async (_t, _r, _m, project) => project('x'.repeat(70_000)), verifyReference: async () => { throw new Error('builtin path'); }, verifyCustomInspection: async () => { checks++; }, verifyTarget: async () => {}, clusterInfo: async () => { throw new Error('cluster path'); } }, () => now); const page = await reader.read(f.request, signal()); assert.ok(page.nextCursor); now += 60_000; await assert.rejects(reader.read({ ...f.request, cursor: page.nextCursor }, signal()), /CONTINUATION_EXPIRED/); assert.equal(checks, 0); reader.dispose(); } finally { f.close(); }
});
test('custom continuation without its explicit verifier fails closed instead of falling through to builtin verification', async () => {
  const f = await fixture(); try { const reader = createInspectionReader({ inspect: async (_t, _r, _m, project) => project('x'.repeat(70_000)), verifyReference: async () => { throw new Error('must not run'); }, verifyTarget: async () => {}, clusterInfo: async () => { throw new Error('must not run'); } }); const page = await reader.read(f.request, signal()); assert.ok(page.nextCursor); await assert.rejects(reader.read({ ...f.request, cursor: page.nextCursor }, signal()), /STATE_UNAVAILABLE/); reader.dispose(); } finally { f.close(); }
});
test('custom inspection shares the finite two slots and coalesces identical outer requests without nested deadlock', async () => {
  const f = await fixture(); const gate = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(); let first = 0; try { f.before(async r => { if (r.purpose === 'resource-object' && first < 2) { if (++first === 2) ready.resolve(); await gate.promise; } }); const jobs = (['wide', 'describe', 'wide'] as const).map(mode => f.gateway.readInspection({ ...f.request, mode }, signal())); await ready.promise; assert.equal(f.requests.length, 2); gate.resolve(); await Promise.all(jobs); assert.equal(f.requests.length, 14); } finally { gate.resolve(); f.close(); }
});
test('closed resource reader and already cancelled custom calls never start metadata or printers', async () => {
  const f = await fixture(); let calls = 0; try { const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async t => t, read: async () => { calls++; throw new Error('unexpected'); } }); reader.close(); await assert.rejects(reader.inspect(f.target, reference, 'wide', () => { throw new Error('unexpected'); }, signal()), /SERVICE_CLOSED/); assert.equal(calls, 0); await assert.rejects(f.gateway.readInspection(f.request, AbortSignal.abort()), /QUERY_CANCELLED/); assert.equal(f.requests.length, 0); } finally { f.close(); }
});
