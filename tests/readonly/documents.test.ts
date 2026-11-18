import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocument } from 'yaml';
import { BoundaryError } from '../../src/shared/errors.ts';
import { documentBytes, documentReferenceFromNode } from '../../src/shared/document-protocol.ts';
import { DocumentBuffer } from '../../src/shared/document-buffer.ts';
import { parseDocumentJson, renderDocumentJson } from '../../src/shared/document-json.ts';
import { DocumentClient } from '../../src/host/document-client.ts';
import type { DocumentState } from '../../src/host/document-client.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { createDocumentReader } from '../../src/service/queries/documents.ts';
import { projectResourceDocument } from '../../src/service/queries/resource-document.ts';
import { resourceDescriptors } from '../../src/shared/tree.ts';
import { validateResourceReadTransportRequest } from '../../src/service/queries/kubectl-plan.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';

const signal = () => new AbortController().signal, marker = 'SYNTHETIC_DOCUMENT_SECRET', managed = 'SYNTHETIC_MANAGED_FIELDS';
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;
const reference = { type: { group: '', version: 'v1', resource: 'configmaps', kind: 'ConfigMap', scope: 'namespace' as const }, namespace: 'default', name: 'sample', uid: 'u', resourceVersion: '1' };
function resource(text = marker, kind = 'ConfigMap') { return { apiVersion: 'v1', kind, metadata: { name: 'sample', namespace: 'default', uid: 'u', resourceVersion: '1', managedFields: [{ manager: managed }], annotations: { explicitlyLoaded: marker } }, data: { key: text }, private: { retainedOnlyInDocument: marker } }; }
async function fixture(text = marker) {
  let raw = JSON.stringify(resource(text)), status = 200, changed = false, iteratedError = false;
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: changed ? 'https://changed.invalid' : 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const configRead = await config.read({ mode: 'default' }), target = { serviceGeneration: 's', projectId: 'view', configIdentity: configRead.snapshot.configIdentity, context: 'active', namespace: 'default' };
  const request = { protocol: 2 as const, selection: { mode: 'default' as const }, target, reference, format: 'json' as const };
  const requests: ResourceReadRequest[] = [], states: DocumentState[] = [];
  let wait: ((request: ResourceReadRequest, signal: AbortSignal) => Promise<void>) | undefined;
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request, signal) => {
    validateResourceReadTransportRequest(request); requests.push(request); await wait?.(request, signal);
    let body = raw;
    if (request.purpose === 'resource-list') body = JSON.stringify({ apiVersion: 'v1', kind: 'SecretList', metadata: { resourceVersion: 'list-rv' }, items: [resource(marker, 'Secret')] });
    if (request.purpose === 'resource-object' && request.path.includes('/secrets/')) body = JSON.stringify(resource(Buffer.from(marker).toString('base64'), 'Secret'));
    return { status, body: { async *[Symbol.asyncIterator]() { if (status !== 200) iteratedError = true; yield Buffer.from(body); } }, close: async () => {} };
  } });
  const transport = async (input: { method: 'POST'; path: string; body: string }) => {
    assert.equal(input.path, '/v2/documents/read');
    try { return { status: 200, body: JSON.stringify(await gateway.readDocument(JSON.parse(input.body) as unknown, signal())) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  };
  const client = new DocumentClient(transport, state => states.push(state));
  return { gateway, request, client, requests, states, transport, raw: (value: string) => { raw = value; }, status: (value: number) => { status = value; },
    changed: () => { changed = true; }, wait: (callback: typeof wait) => { wait = callback; }, errorRead: () => iteratedError,
    close() { client.dispose(); gateway.close(); } };
}

test('named Load performs one raw GET in the existing reader and preserves full explicit content, omitting only metadata.managedFields', async () => {
  const f = await fixture(), page = await f.gateway.readDocument(f.request, signal());
  assert.equal(page.kind, 'resource-document'); assert.equal(page.format, 'json'); assert.equal(page.nextCursor, null);
  assert.equal(page.text.includes(marker), true); assert.equal(page.text.includes(managed), false); assert.ok(Object.isFrozen(page));
  assert.deepEqual(f.requests.map(request => request.path), ['/api/v1/namespaces/default/configmaps/sample']); assert.deepEqual(f.requests[0]?.query, {});
  const expected = resource(); const { managedFields: _omitted, ...metadata } = expected.metadata;
  assert.deepEqual(JSON.parse(page.text), { ...expected, metadata }); f.close();
});

test('Load preserves int64/decimal/exponent/-0 tokens in both JSON and YAML, without passing numbers through JS Number', () => {
  const raw = JSON.stringify(resource()).replace('"private":', '"large":9223372036854775807,"decimal":0.10000000000000000001,"exponent":1e+100,"minusZero":-0,"private":');
  for (const format of ['json', 'yaml'] as const) {
    const output = projectResourceDocument(raw, reference, format).text;
    for (const literal of ['9223372036854775807', '0.10000000000000000001', '1e+100', '-0']) assert.ok(output.includes(literal));
  }
  const yaml = projectResourceDocument(raw, reference, 'yaml').text, doc = parseDocument(yaml, { intAsBigInt: true }); assert.equal(doc.errors.length, 0);
  const value: unknown = doc.toJS(); assert.equal(typeof value, 'object'); assert.equal(Reflect.get(value as object, 'large'), 9223372036854775807n);
});

test('YAML 1.2 block output quotes strings/keys, preserves nested containers, prototype-like keys, booleans and empty values without tags/aliases', () => {
  const input = '{"__proto__":{"toString":"yes"},"boolean":false,"values":[[],{},null,"",{"x":"!tag &anchor *alias --- <script>\\nline"}]}';
  const output = renderDocumentJson(parseDocumentJson(input), 'yaml', documentBytes), parsed = parseDocument(output);
  assert.equal(parsed.errors.length, 0); assert.deepEqual(parsed.toJS(), JSON.parse(input)); assert.ok(output.includes('"__proto__":'));
});

test('lossless JSON formatter roundtrips all safe scalar/container fixtures, and is deterministic across whitespace', () => {
  for (const value of [null, false, 0, -5.25, 'BOM\uFEFF \r\n 😀', [], {}, { a: [1, null, { '0': 'x' }], b: '\u0000\u001b', c: '☃' }]) {
    const text = JSON.stringify(value), output = renderDocumentJson(parseDocumentJson(text), 'json', documentBytes);
    assert.deepEqual(JSON.parse(output), value); assert.equal(renderDocumentJson(parseDocumentJson(output), 'json', documentBytes), output);
  }
});

test('duplicate decoded keys, malformed JSON, lone surrogates and trailing values fail fixed; depth/node/output budgets are hard limits', () => {
  for (const text of ['{"a":1,"\\u0061":2}', '{"x":}', '[1,]', '{"x":01}', 'true false', '"\\uD800"', '{"a":"\u0000"}', '{', 'NaN', '1.', '\uFEFF{}']) assert.throws(() => parseDocumentJson(text), fails('CONTENT_INVALID'));
  assert.throws(() => parseDocumentJson('['.repeat(66) + '0' + ']'.repeat(66)), fails('BUDGET_EXCEEDED'));
  assert.throws(() => parseDocumentJson('[' + '0,'.repeat(50_000) + '0]'), fails('BUDGET_EXCEEDED'));
  assert.throws(() => renderDocumentJson(parseDocumentJson('{"x":"long"}'), 'yaml', 3), fails('BUDGET_EXCEEDED'));
});

test('Secret Load is explicit and keeps manifest encoding, while default resource DTOs cannot carry values or annotations', async () => {
  const f = await fixture(), ref = { ...reference, type: { ...reference.type, resource: 'secrets', kind: 'Secret' } };
  const tree = await f.gateway.read({ protocol: 2, selection: f.request.selection, target: f.request.target, resource: 'secrets' }, signal());
  assert.equal(JSON.stringify(tree).includes(marker), false);
  const page = await f.gateway.readDocument({ ...f.request, reference: ref }, signal());
  assert.ok(page.text.includes(Buffer.from(marker).toString('base64'))); assert.ok(page.text.includes('explicitlyLoaded'));
  assert.equal(page.nextCursor, null); f.close();
});

test('every builtin stable resource row can produce a complete GVR document reference; custom lookalikes or missing UID/RV cannot', () => {
  for (const descriptor of Object.values(resourceDescriptors)) {
    const row = { id: 'synthetic', type: 'resource', label: 'sample', expandable: descriptor.children !== 'none', children: descriptor.children,
      resource: { group: descriptor.group, version: descriptor.version, kind: descriptor.kind, resource: descriptor.resource, scope: descriptor.scope,
        name: 'sample', uid: 'u', resourceVersion: '1', ...(descriptor.scope === 'namespace' ? { namespace: 'default' } : {}) } };
    assert.equal(documentReferenceFromNode(row)?.type.kind, descriptor.kind);
    for (const resource of [{ ...row.resource, uid: undefined }, { ...row.resource, resourceVersion: undefined }, { ...row.resource, group: 'custom.invalid' }]) assert.equal(documentReferenceFromNode({ ...row, resource }), null);
  }
});

test('resource namespace/UID/RV/kind changes invalidate Load rather than loading a same-name replacement', async () => {
  const f = await fixture();
  for (const change of [{ metadata: { ...resource().metadata, uid: 'new' } }, { metadata: { ...resource().metadata, resourceVersion: '2' } }, { kind: 'Secret' }, { metadata: { ...resource().metadata, namespace: 'other' } }]) {
    f.raw(JSON.stringify({ ...resource(), ...change })); await assert.rejects(f.gateway.readDocument(f.request, signal()), fails('STALE_TARGET'));
  }
  f.close();
});

test('list/all/custom/arbitrary URL/command references are not promoted into the named builtin document path', async () => {
  const f = await fixture();
  for (const change of [{ reference: { ...reference, name: '' } }, { reference: { ...reference, type: { ...reference.type, group: 'custom.invalid' } } }, { url: 'https://synthetic.invalid' }, { command: ['get', 'all'] }, { reference: { ...reference, namespace: undefined } }]) await assert.rejects(f.gateway.readDocument({ ...f.request, ...change }, signal()), fails('INVALID_INPUT'));
  await assert.rejects(f.gateway.readDocument({ ...f.request, reference: { ...reference, namespace: 'other' } }, signal()), fails('STALE_TARGET')); assert.equal(f.requests.length, 0); f.close();
});

test('document chunks are explicit, surrogate-safe and bound to same content; the complete document alone opens a clean buffer', async () => {
  const f = await fixture('😀'.repeat(40_000)); await f.client.read(f.request);
  assert.equal(f.states.at(-1)?.complete, false); assert.equal(f.states.at(-1)?.editor, undefined); f.client.edit('incomplete');
  const first = f.states.at(-1)?.text; assert.notEqual(first, 'incomplete');
  while (f.states.at(-1)?.page?.nextCursor) await f.client.next();
  const state = f.states.at(-1); assert.equal(state?.complete, true); assert.equal(state?.editor?.dirty, false); assert.equal(state?.editor?.text, state?.text);
  assert.deepEqual(JSON.parse(state?.text ?? '{}').data.key, '😀'.repeat(40_000)); assert.ok(f.requests.length > 1); f.close();
});

test('every continued chunk freshly checks UID/RV and keyed content, including a body change with unchanged RV', async () => {
  const f = await fixture('a'.repeat(70_000)), page = await f.gateway.readDocument(f.request, signal()); assert.ok(page.nextCursor);
  const count = f.requests.length; await f.gateway.readDocument({ ...f.request, cursor: page.nextCursor }, signal()); assert.equal(f.requests.length, count + 1);
  f.raw(JSON.stringify(resource('b'.repeat(70_000)))); await assert.rejects(f.gateway.readDocument({ ...f.request, cursor: page.nextCursor }, signal()), fails('STALE_TARGET'));
  f.raw(JSON.stringify({ ...resource('a'.repeat(70_000)), metadata: { ...resource().metadata, uid: 'new' } }));
  await assert.rejects(f.gateway.readDocument({ ...f.request, cursor: page.nextCursor }, signal()), fails('STALE_TARGET')); f.close();
});

test('document cursor cannot cross format/resource/namespace/project/config selection or another service instance', async () => {
  const f = await fixture('a'.repeat(70_000)), page = await f.gateway.readDocument(f.request, signal()); assert.ok(page.nextCursor); const count = f.requests.length;
  for (const change of [{ format: 'yaml' }, { reference: { ...reference, name: 'other' } }, { target: { ...f.request.target, projectId: 'other' } }, { selection: { mode: 'file', path: '/synthetic/explicit' } }]) await assert.rejects(f.gateway.readDocument({ ...f.request, cursor: page.nextCursor, ...change }, signal()), fails('STALE_TARGET'));
  assert.equal(f.requests.length, count); const other = await fixture(); await assert.rejects(other.gateway.readDocument({ ...other.request, cursor: page.nextCursor }, signal()), fails('STALE_TARGET')); other.close(); f.close();
});

test('fixed cursor deadline is checked before and after reads, cannot renew, and disposal prevents new documents', async () => {
  const f = await fixture('a'.repeat(70_000)); let time = 1000, reads = 0;
  const reader = createDocumentReader({ document: async (_target, _ref, _format, project) => { reads++; return project({ text: 'a'.repeat(70_000), bytes: 70_000 }); } }, () => time);
  const first = await reader.read(f.request, signal()); time = 61_000;
  await assert.rejects(reader.read({ ...f.request, cursor: first.nextCursor }, signal()), fails('CONTINUATION_EXPIRED')); assert.equal(reads, 1); reader.dispose();
  await assert.rejects(reader.read(f.request, signal()), fails('SERVICE_CLOSED'));
  const slow = createDocumentReader({ document: async (_t, _r, _f, project) => { time += 60_000; return project({ text: '{}\n', bytes: 3 }); } }, () => time);
  await assert.rejects(slow.read(f.request, signal()), fails('CONTINUATION_EXPIRED')); slow.dispose(); f.close();
});

test('document size limits reject oversized complete manifests, never return a truncated editable JSON or YAML', async () => {
  const f = await fixture('a'.repeat(documentBytes)); await assert.rejects(f.gateway.readDocument(f.request, signal()), fails('BUDGET_EXCEEDED'));
  f.raw(JSON.stringify(resource('a'.repeat(2_000_000)))); await assert.rejects(f.gateway.readDocument(f.request, signal()), fails('BUDGET_EXCEEDED')); f.close();
});

test('401/403/404/410 and transport/parser failures are fixed, do not iterate sensitive error bodies or echo content', async () => {
  const f = await fixture();
  for (const [status, code] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [410, 'CONTINUATION_EXPIRED']] as const) { f.status(status); await assert.rejects(f.gateway.readDocument(f.request, signal()), fails(code)); }
  assert.equal(f.errorRead(), false); f.status(200); f.raw(marker); await assert.rejects(f.gateway.readDocument(f.request, signal()), fails('CONTENT_INVALID')); f.close();
});

test('configuration changes during reading, closed gateways and pre-aborted consumers cannot publish document text', async () => {
  const f = await fixture(); f.wait(async () => f.changed()); await assert.rejects(f.gateway.readDocument(f.request, signal()), fails('STALE_TARGET')); f.close();
  const other = await fixture(), abort = new AbortController(); abort.abort(); await assert.rejects(other.gateway.readDocument(other.request, abort.signal), fails('QUERY_CANCELLED')); assert.equal(other.requests.length, 0);
  other.close(); await assert.rejects(other.gateway.readDocument(other.request, signal()), fails('SERVICE_CLOSED'));
});

test('client rejects wrong source/offset/content/size/sensitive extensions before opening an edit buffer', async () => {
  const f = await fixture(), page = await f.gateway.readDocument(f.request, signal());
  for (const change of [{ target: { ...page.target, projectId: 'wrong' } }, { format: 'yaml' }, { reference: { ...reference, uid: 'wrong' } }, { offset: 1 }, { totalBytes: page.totalBytes + 1 }, { private: marker }]) {
    const states: DocumentState[] = [], client = new DocumentClient(async () => ({ status: 200, body: JSON.stringify({ ...page, ...change }) }), state => states.push(state));
    await client.read(f.request); assert.equal(states.at(-1)?.phase, 'error'); assert.equal(states.at(-1)?.editor, undefined); assert.equal(states.at(-1)?.text, ''); client.dispose();
  }
  f.close();
});

test('late document responses after cancel/reset/dispose cannot restore old content or a dirty buffer', async () => {
  const f = await fixture(), page = await f.gateway.readDocument(f.request, signal());
  for (const action of ['cancel', 'reset', 'dispose'] as const) {
    let release: ((value: { status: number; body: string }) => void) | undefined; const states: DocumentState[] = [];
    const client = new DocumentClient(() => new Promise(resolve => { release = resolve; }), state => states.push(state));
    const pending = client.read(f.request); client[action](); release?.({ status: 200, body: JSON.stringify(page) }); await pending;
    assert.equal(states.some(state => state.editor), false); client.dispose();
  }
  f.close();
});

test('cancelled document SDK calls retain the four admission slots until actual settlement, without leaking raw errors', async () => {
  const f = await fixture(), states: DocumentState[] = [], releases: (() => void)[] = [];
  const client = new DocumentClient(() => new Promise((_resolve, reject) => { releases.push(() => reject(Error(marker))); }), state => states.push(state));
  const pending: Promise<void>[] = [];
  for (let index = 0; index < 4; index++) { pending.push(client.read(f.request)); client.cancel(); }
  await client.read(f.request); assert.equal(states.at(-1)?.error, 'QUERY_LIMIT'); assert.equal(releases.length, 4);
  releases.forEach(release => release()); await Promise.all(pending); assert.equal(JSON.stringify(states).includes(marker), false); client.dispose(); f.close();
});

test('pure edit buffer tracks dirty/revision and exact revert without mutating its immutable live origin', async () => {
  const f = await fixture(), page = await f.gateway.readDocument(f.request, signal()), buffer = new DocumentBuffer(page.text, page);
  assert.equal(buffer.state.dirty, false); buffer.edit(page.text); assert.equal(buffer.state.revision, 0);
  buffer.edit('edited\r\n'); assert.equal(buffer.state.dirty, true); assert.equal(buffer.state.revision, 1);
  assert.equal(buffer.state.origin.reference.uid, 'u'); assert.ok(Object.isFrozen(buffer.state.origin.reference.type)); buffer.revert();
  assert.deepEqual(Object.keys(buffer.state.origin).sort(), ['contentIdentity', 'format', 'reference', 'target']);
  assert.equal(buffer.state.dirty, false); assert.equal(buffer.state.revision, 2); assert.equal(buffer.state.text, page.text); f.close();
});

test('new Load, format switch, reload and close cannot silently discard dirty edits; explicit discard is local only', async () => {
  const f = await fixture(); await f.client.read(f.request); const baseline = f.states.at(-1)?.text; f.client.edit('edited'); const count = f.requests.length;
  await f.client.read({ ...f.request, format: 'yaml' }); await f.client.reload(); f.client.close();
  assert.equal(f.states.at(-1)?.error, 'DOCUMENT_DIRTY'); assert.equal(f.states.at(-1)?.editor?.text, 'edited'); assert.equal(f.requests.length, count);
  f.client.revert(); assert.equal(f.states.at(-1)?.editor?.text, baseline); assert.equal(f.states.at(-1)?.editor?.dirty, false);
  f.client.edit('another edit'); await f.client.reload(true); assert.equal(f.states.at(-1)?.editor?.dirty, false);
  f.client.edit('last edit'); f.client.close(true); assert.equal(f.states.at(-1)?.phase, 'idle'); assert.equal(f.states.at(-1)?.text, ''); f.close();
});

test('editing never invokes transport, over-budget/invalid edits preserve previous text, and forced target reset clears dirty content', async () => {
  const f = await fixture(); await f.client.read(f.request); const count = f.requests.length;
  f.client.edit('valid'); f.client.edit('a'.repeat(documentBytes + 1)); assert.equal(f.states.at(-1)?.error, 'BUDGET_EXCEEDED'); assert.equal(f.states.at(-1)?.editor?.text, 'valid');
  f.client.edit('\uD800'); assert.equal(f.states.at(-1)?.error, 'CONTENT_INVALID'); assert.equal(f.states.at(-1)?.editor?.text, 'valid');
  assert.equal(f.requests.length, count); f.client.reset(); assert.equal(f.states.at(-1)?.editor, undefined); assert.equal(f.states.at(-1)?.text, ''); f.close();
});

test('configuration freshness suspension preserves private baseline and dirty text without transport or pretending fresh', async () => {
  const f = await fixture(); await f.client.read(f.request);
  const baseline = f.states.at(-1)?.editor?.text, count = f.requests.length;
  f.client.edit('retained detached draft'); f.client.suspend();
  assert.equal(f.states.at(-1)?.stale, true);
  assert.equal(f.states.at(-1)?.editor?.text, 'retained detached draft');
  await f.client.next(); await f.client.reload(); f.client.close();
  assert.equal(f.requests.length, count);
  assert.equal(f.states.at(-1)?.stale, true);
  f.client.revert();
  assert.equal(f.states.at(-1)?.editor?.text, baseline);
  assert.equal(f.states.at(-1)?.stale, true);
  f.close();
});

test('document reads and unrelated resources share the global pool and duplicate consumer cancellation does not cancel its peer', async () => {
  const f = await fixture(); let release: (() => void) | undefined, started: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), start = new Promise<void>(resolve => { started = resolve; }); let active = 0, maximum = 0;
  f.wait(async () => { active++; maximum = Math.max(maximum, active); started?.(); await gate; active--; });
  const abort = new AbortController(), a = f.gateway.readDocument(f.request, abort.signal).catch(error => error instanceof BoundaryError ? error.code : 'unexpected');
  await start; const b = f.gateway.readDocument(f.request, signal()); abort.abort(); assert.equal(await a, 'QUERY_CANCELLED');
  const c = f.gateway.read({ protocol: 2, selection: f.request.selection, target: f.request.target, resource: 'secrets' }, signal());
  release?.(); await Promise.all([b, c]); assert.ok(maximum <= 2); assert.equal(f.requests.filter(request => request.purpose === 'resource-object').length, 1); f.close();
});

test('cluster documents require absent namespace and Pod documents retain their explicit original namespace', async () => {
  const f = await fixture(), nodeRef = { type: { group: '', version: 'v1', kind: 'Node', resource: 'nodes', scope: 'cluster' }, name: 'sample', uid: 'u', resourceVersion: '1' };
  f.raw(JSON.stringify({ apiVersion: 'v1', kind: 'Node', metadata: { name: 'sample', uid: 'u', resourceVersion: '1' }, spec: {} }));
  const page = await f.gateway.readDocument({ ...f.request, reference: nodeRef }, signal()); assert.equal(page.reference.namespace, undefined); assert.equal(f.requests.at(-1)?.path, '/api/v1/nodes/sample');
  f.raw(JSON.stringify({ apiVersion: 'v1', kind: 'Node', metadata: { name: 'sample', uid: 'u', resourceVersion: '1', namespace: null } }));
  await assert.rejects(f.gateway.readDocument({ ...f.request, reference: nodeRef }, signal()), fails('STALE_TARGET'));
  const podRef = { ...reference, type: { ...reference.type, resource: 'pods', kind: 'Pod' }, namespace: 'other' };
  f.raw(JSON.stringify({ ...resource('', 'Pod'), metadata: { ...resource().metadata, namespace: 'other' } }));
  const pod = await f.gateway.readDocument({ ...f.request, reference: podRef }, signal()); assert.equal(pod.reference.namespace, 'other'); assert.equal(pod.target.namespace, 'default'); f.close();
});

test('a complete exactly-1MiB manifest assembles within the finite chunk count and opens only one full buffer', async () => {
  const f = await fixture(''), overhead = projectResourceDocument(JSON.stringify(resource('')), reference, 'json').bytes;
  f.raw(JSON.stringify(resource('a'.repeat(documentBytes - overhead)))); await f.client.read(f.request);
  let chunks = 1; while (f.states.at(-1)?.page?.nextCursor) { await f.client.next(); chunks++; assert.ok(chunks <= 17); }
  assert.equal(f.states.at(-1)?.page?.totalBytes, documentBytes); assert.equal(f.states.at(-1)?.complete, true); assert.equal(Buffer.byteLength(f.states.at(-1)?.editor?.text ?? ''), documentBytes); f.close();
});

test('continued client pages cannot replay an offset, change document identity or cycle an older cursor', async () => {
  const f = await fixture('a'.repeat(140_000)), first = await f.gateway.readDocument(f.request, signal()); assert.ok(first.nextCursor);
  const second = await f.gateway.readDocument({ ...f.request, cursor: first.nextCursor }, signal()); assert.ok(second.nextCursor);
  for (const change of [{ offset: 0 }, { contentIdentity: 'f'.repeat(64) }, { nextCursor: first.nextCursor }]) {
    const states: DocumentState[] = []; let count = 0;
    const client = new DocumentClient(async () => ({ status: 200, body: JSON.stringify(++count === 1 ? first : { ...second, ...change }) }), state => states.push(state));
    await client.read(f.request); await client.next(); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.editor, undefined); assert.equal(states.at(-1)?.text, first.text); client.dispose();
  }
  f.close();
});

test('omitted managedFields alone does not change the document content identity, but arbitrary metadata/spec content still does', async () => {
  const f = await fixture('a'.repeat(70_000)), first = await f.gateway.readDocument(f.request, signal()); assert.ok(first.nextCursor);
  const value = resource('a'.repeat(70_000)); f.raw(JSON.stringify({ ...value, metadata: { ...value.metadata, managedFields: [{ manager: 'new-manager' }] } }));
  const next = await f.gateway.readDocument({ ...f.request, cursor: first.nextCursor }, signal()); assert.equal(next.contentIdentity, first.contentIdentity);
  f.raw(JSON.stringify({ ...value, metadata: { ...value.metadata, annotations: { explicitlyLoaded: 'different' } } }));
  await assert.rejects(f.gateway.readDocument({ ...f.request, cursor: first.nextCursor }, signal()), fails('STALE_TARGET')); f.close();
});
