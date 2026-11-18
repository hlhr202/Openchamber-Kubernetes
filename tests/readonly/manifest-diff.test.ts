// Independent synthetic GET responses, local parser/text alignment and read-only client only. No adapter/SDK/HTTP/writer/operation imports.
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import { ManifestDiffClient } from '../../src/host/manifest-diff-client.ts';
import type { DiffSource, ManifestDiffState } from '../../src/host/manifest-diff-client.ts';
import { localComparisonDocuments } from '../../src/host/manifest-diff-source.ts';
import { compareDocumentText } from '../../src/shared/text-comparison.ts';
import { manifestDiffRequestSchema, manifestComparisonPath } from '../../src/shared/manifest-diff-protocol.ts';
import { projectManifestComparison, resolveManifestComparison } from '../../src/service/queries/manifest-comparison.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { parseReadWorkerStart } from '../../src/service/queries/read-worker-protocol.ts';
import { createManifestDiffReader } from '../../src/service/queries/manifest-diff-reader.ts';
import { BoundaryError } from '../../src/shared/errors.ts';
const signal = () => new AbortController().signal;
async function fixture() {
  let server = 'https://synthetic.invalid', status = 200, uid = 'original', rv = '1', data = 'SYNTHETIC_ONLY', bodyOverride: string | undefined, afterDiscovery = false, failClose = false, errorIterated = false, closed = 0;
  let before: ((request: ResourceReadRequest) => Promise<void>) | undefined;
  let resources = [{ name: 'configmaps', namespaced: true, kind: 'ConfigMap', verbs: ['get'] }];
  const config = createConfigReader('/synthetic/config', async sourcePath => ({ sourcePath, content: JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'cluster', cluster: { server } }], contexts: [{ name: 'active', context: { cluster: 'cluster', namespace: 'default' } }] }) }));
  const value = await config.read({ mode: 'default' }), target = { serviceGeneration: 'service', projectId: 'view', configIdentity: value.snapshot.configIdentity, context: 'active', namespace: 'default' };
  const requests: ResourceReadRequest[] = [];
  const gateway = createResourceGateway({ serviceGeneration: 'service', config, outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => {
    requests.push(request); kubectlReadArguments(request, '/synthetic/configuration.pipe'); await before?.(request);
    const discovery = request.purpose === 'api-version', responseStatus = discovery ? 200 : status;
    const text = discovery ? JSON.stringify({ groupVersion: request.path.startsWith('/apis/') ? request.path.slice('/apis/'.length) : 'v1', resources: afterDiscovery && requests.filter(request => request.purpose === 'api-version').length > 1 ? [] : resources })
      : bodyOverride ?? JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'sample', namespace: request.comparison?.namespace ?? 'default', uid, resourceVersion: rv, managedFields: [{ manager: 'PRIVATE_MANAGED' }] }, data: { text: data } });
    return { status: responseStatus, body: { async *[Symbol.asyncIterator]() { if (responseStatus !== 200) { errorIterated = true; throw new Error('Error bodies must not be iterated'); } yield Buffer.from(text); } }, close: async () => { closed++; if (failClose) throw new Error('synthetic close'); } };
  } });
  const locator = { group: '', version: 'v1', kind: 'ConfigMap', name: 'sample' }, request = { protocol: 2 as const, target, selection: { mode: 'default' as const }, locator, format: 'json' as const };
  let snapshot: DiffSource | undefined = { owner: {}, revision: 0, text: '{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"sample"}}', format: 'json', target, selection: { mode: 'default' } };
  const states: ManifestDiffState[] = [], clientRequests: string[] = [];
  const client = new ManifestDiffClient(async input => {
    assert.equal(input.path, '/v2/manifest-diff/read'); clientRequests.push(input.body);
    try { return { status: 200, body: JSON.stringify(await gateway.readManifestDiff(JSON.parse(input.body), signal())) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  }, () => snapshot, state => states.push(state));
  return { gateway, client, request, target, requests, states, clientRequests, last: () => { const value = states.at(-1); assert.ok(value); return value; },
    server(value: string) { server = value; }, status(value: number) { status = value; }, data(value: string) { data = value; }, uid(value: string) { uid = value; }, rv(value: string) { rv = value; }, raw(value: string) { bodyOverride = value; }, resources(value: typeof resources) { resources = value; },
    driftDiscovery() { afterDiscovery = true; }, failClose() { failClose = true; }, errorIterated: () => errorIterated, closes: () => closed, before(value: typeof before) { before = value; }, snapshot: () => snapshot,
    source(value: DiffSource | undefined) { snapshot = value; }, close() { client.dispose(); gateway.close(); } };
}
describe('independent readonly manifest comparison', { timeout: 10_000 }, () => {
test('pure local inference preserves multi-document slices, name/namespace and numeric/comment text without pluralizing or uploading', () => {
  const text = '# comment\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: sample, namespace: other}\nvalue: 9007199254740993\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata: {name: workload}\n';
  const documents = localComparisonDocuments(text, 'yaml'); assert.equal(documents.length, 2); assert.equal(documents[0]?.locator?.namespace, 'other'); assert.equal(documents[1]?.locator?.group, 'apps'); assert.ok(documents[0]?.text.includes('9007199254740993')); assert.ok(documents[0]?.text.includes('# comment'));
});
test('no input, unresolvable shape and malformed input are distinct; selected ranges validate Unicode boundaries', () => {
  assert.deepEqual(localComparisonDocuments(' \n', 'yaml'), []); assert.equal(localComparisonDocuments('value: only\n', 'yaml')[0]?.locator, undefined);
  for (const text of ['a: 1\na: 2', 'key: &anchor 1\ncopy: *anchor', 'a: [', 'a: \0']) assert.throws(() => localComparisonDocuments(text, 'yaml'), /CONTENT_INVALID/);
  assert.throws(() => localComparisonDocuments('😀', 'yaml', { start: 0, end: 1 }), /CONTENT_INVALID/); assert.throws(() => localComparisonDocuments('abc', 'yaml', { start: 1, end: 1 }), /INVALID_INPUT/);
});
test('comparison retains BOM, directives and inter-document/trailing comments exactly without splitting quoted YAML markers', () => {
  for (const text of ['\ufeff# first\r\napiVersion: v1\r\nkind: ConfigMap\r\nmetadata: {name: sample}\r\n# last\r\n',
    '%YAML 1.2\n---\n# first\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: sample}\n...\n# between\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: sample}\ndata: {marker: "---"}\n# trailing\n']) {
    const documents = localComparisonDocuments(text, 'yaml'); assert.equal(documents.map(document => document.text).join(''), text); assert.ok(documents.every(document => document.locator));
  }
});
test('explicit empty/null/non-string namespace cannot silently read the active namespace', async () => {
  const f = await fixture(), source = f.snapshot(); assert.ok(source);
  for (const namespace of ['null', 'false', '123', '[]', '{}', '""']) {
    const text = `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: sample, namespace: ${namespace}}\n`;
    assert.throws(() => localComparisonDocuments(text, 'yaml'), /CONTENT_INVALID/);
    f.source({ ...source, format: 'yaml', text }); await f.client.read('file', 'yaml'); assert.equal(f.last().phase, 'error'); assert.equal(f.requests.length, 0);
  }
  f.close();
});
test('local inventory bounds32 documents and never rounds JSON int64/exponents or admits decoded duplicate keys', () => {
  assert.throws(() => localComparisonDocuments(Array.from({ length: 33 }, () => 'kind: Thing\n').join('---\n'), 'yaml'), /BUDGET_EXCEEDED/);
  const text = '{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"sample"},"v":9007199254740993}'; assert.equal(localComparisonDocuments(text, 'json')[0]?.text, text);
  assert.throws(() => localComparisonDocuments('{"a":1,"\\u0061":2}', 'json'), /CONTENT_INVALID/);
});
test('exact discovery uses get verb, rejects ambiguous kind/subresources and never guesses plurals or served versions', () => {
  const target = { serviceGeneration: 's', projectId: 'p', configIdentity: 'c', context: 'active', namespace: 'default' }, locator = { group: 'example.io', version: 'v1', kind: 'Mouse', name: 'sample' };
  const resources = [{ name: 'mice', namespaced: true, kind: 'Mouse', verbs: ['get'] }, { name: 'mice/status', namespaced: true, kind: 'Mouse', verbs: ['get'] }];
  const ref = resolveManifestComparison({ groupVersion: 'example.io/v1', resources }, locator, target); assert.equal(ref?.type.resource, 'mice'); assert.equal(ref?.namespace, 'default');
  assert.equal(resolveManifestComparison({ groupVersion: 'example.io/v1', resources: [...resources, { name: 'others', namespaced: true, kind: 'Mouse', verbs: ['get'] }] }, locator, target), undefined);
  assert.equal(resolveManifestComparison({ groupVersion: 'example.io/v1', resources: [{ ...resources[0], verbs: ['list'] }] }, locator, target), undefined);
  assert.throws(() => resolveManifestComparison({ groupVersion: 'example.io/v2', resources: [] }, locator, target), /RESOURCE_INVALID/);
});
test('Diff request is strict metadata only and cannot transport text/argv/body, target replacement or path traversal', async () => {
  const f = await fixture(); assert.equal(manifestDiffRequestSchema.safeParse(f.request).success, true);
  for (const extra of [{ text: 'synthetic body' }, { body: 'anything' }, { argv: ['apply'] }, { locator: { ...f.request.locator, name: '../escape' } }]) assert.equal(manifestDiffRequestSchema.safeParse({ ...f.request, ...extra }).success, false); f.close();
});
test('dedicated worker purpose accepts only exact single-object GET and does not open builtin/custom Load/Delete or subresource admission', async () => {
  const f = await fixture(), comparison = { type: { group: 'example.io', version: 'v1', resource: 'mice', kind: 'Mouse', scope: 'namespace' as const }, namespace: 'other', name: 'sample' };
  const request: ResourceReadRequest = { method: 'GET', purpose: 'manifest-diff', target: f.target, path: manifestComparisonPath(comparison), query: {}, maximumBytes: 2_000_000, comparison };
  const args = kubectlReadArguments(request, '/synthetic/configuration.pipe'); assert.deepEqual(args.slice(-2), ['get', '--raw=/apis/example.io/v1/namespaces/other/mice/sample']); assert.ok(args.includes('--request-timeout=7s'));
  for (const change of [{ path: request.path + '/status' }, { purpose: 'resource-object' as const }, { query: { watch: 'true' } }, { maximumBytes: 8_000_000 as const }]) assert.throws(() => kubectlReadArguments({ ...request, ...change }, '/synthetic/configuration.pipe'), /INVALID_INPUT/);
  assert.equal(parseReadWorkerStart({ protocol: 1, kind: 'read', request, snapshot: new Uint8Array([1]), path: '/synthetic/bin' }).request.purpose, 'manifest-diff'); f.close();
});
test('complete live comparison uses discovery-object-discovery only, captures UID/RV and omits managedFields but preserves other body', async () => {
  const f = await fixture(), page = await f.gateway.readManifestDiff(f.request, signal()); assert.equal(page.kind, 'live-comparison');
  if (page.kind !== 'live-comparison') throw new Error('Wrong branch'); assert.equal(page.uid, 'original'); assert.equal(page.resourceVersion, '1'); assert.ok(page.text.includes('SYNTHETIC_ONLY') && !page.text.includes('PRIVATE_MANAGED')); assert.deepEqual(f.requests.map(request => request.purpose), ['api-version', 'manifest-diff', 'api-version']); assert.equal(f.closes(), 3); f.close();
});
test('explicit manifest namespace and cluster-scoped object routing are not silently taken from current namespace', async () => {
  const f = await fixture(); const page = await f.gateway.readManifestDiff({ ...f.request, locator: { ...f.request.locator, namespace: 'other' } }, signal()); assert.equal(page.kind, 'live-comparison'); assert.ok(f.requests.some(request => request.path === '/api/v1/namespaces/other/configmaps/sample'));
  f.resources([{ name: 'nodes', namespaced: false, kind: 'Node', verbs: ['get'] }]); f.raw('{"apiVersion":"v1","kind":"Node","metadata":{"name":"node","uid":"u","resourceVersion":"1"}}'); const node = await f.gateway.readManifestDiff({ ...f.request, locator: { group: '', version: 'v1', kind: 'Node', name: 'node' } }, signal()); assert.equal(node.kind, 'live-comparison'); assert.ok(f.requests.some(request => request.path === '/api/v1/nodes/node')); f.close();
});
test('missing object is separate from failed lookup, and sensitive non200 bodies are never iterated', async () => {
  const f = await fixture(); f.status(404); assert.equal((await f.gateway.readManifestDiff(f.request, signal())).kind, 'comparison-missing'); assert.equal(f.errorIterated(), false);
  f.status(403); await assert.rejects(f.gateway.readManifestDiff(f.request, signal()), /FORBIDDEN/); assert.equal(f.errorIterated(), false); f.close();
});
test('discovery missing kind returns unresolved without object GET; changed routing after GET fails the comparison', async () => {
  const f = await fixture(); f.resources([]); assert.equal((await f.gateway.readManifestDiff(f.request, signal())).kind, 'comparison-unresolved'); assert.equal(f.requests.length, 1); f.close();
  const second = await fixture(); second.driftDiscovery(); await assert.rejects(second.gateway.readManifestDiff(second.request, signal()), /STALE_TARGET/); second.close();
});
test('loaded same-name replacement expected UID and malformed live identity cannot be adopted as a comparison snapshot', async () => {
  const f = await fixture(); await assert.rejects(f.gateway.readManifestDiff({ ...f.request, expectedUid: 'old-deleted' }, signal()), /STALE_TARGET/); f.uid(''); await assert.rejects(f.gateway.readManifestDiff(f.request, signal()), /STALE_TARGET/); f.close();
});
test('lossless server projection preserves numeric lexemes and rejects duplicate keys/invalid shape, not a JS-number rewrite', () => {
  const reference = { type: { group: '', version: 'v1', resource: 'configmaps', kind: 'ConfigMap', scope: 'namespace' as const }, name: 'sample', namespace: 'default' };
  const text = '{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"sample","namespace":"default","uid":"u","resourceVersion":"1"},"n":9007199254740993,"exp":1.20e+21}';
  const value = projectManifestComparison(text, reference, 'yaml'); assert.ok(value.text.includes('9007199254740993') && value.text.includes('1.20e+21'));
  assert.throws(() => projectManifestComparison(text.replace('"n":', '"kind":"Other","n":'), reference, 'json'), /CONTENT_INVALID/);
});
test('continuation is an immutable captured snapshot: no re-get/dry-run, but original configuration must still match', async () => {
  const f = await fixture(); f.data('x'.repeat(150_000)); const first = await f.gateway.readManifestDiff(f.request, signal()); assert.equal(first.kind, 'live-comparison'); if (first.kind !== 'live-comparison' || !first.nextCursor) throw new Error('Expected cursor');
  f.data('external newer content'); f.rv('2'); const next = await f.gateway.readManifestDiff({ ...f.request, cursor: first.nextCursor }, signal()); assert.equal(next.kind, 'live-comparison'); if (next.kind === 'live-comparison') { assert.equal(next.resourceVersion, '1'); assert.equal(next.identity, first.identity); assert.ok(!next.text.includes('external newer content')); }
  assert.equal(f.requests.length, 3); f.server('https://changed.invalid'); await assert.rejects(f.gateway.readManifestDiff({ ...f.request, cursor: first.nextCursor }, signal()), /STALE_TARGET/); f.close();
});
test('continuation is exact locator/namespace/format/config bound and cannot select another cached document', async () => {
  const f = await fixture(); f.data('x'.repeat(150_000)); const first = await f.gateway.readManifestDiff(f.request, signal()); if (first.kind !== 'live-comparison' || !first.nextCursor) throw new Error('Expected cursor');
  for (const extra of [{ format: 'yaml' }, { locator: { ...f.request.locator, name: 'other' } }, { expectedUid: 'other' }]) await assert.rejects(f.gateway.readManifestDiff({ ...f.request, cursor: first.nextCursor, ...extra }, signal()), /STALE_TARGET/); f.close();
});
test('fixed snapshot expiry and max16/4MiB retained reservation fail closed without prolonging through cursor access', async () => {
  let now = 1, captures = 0;
  const reference = { type: { group: '', version: 'v1', resource: 'configmaps', kind: 'ConfigMap', scope: 'namespace' as const }, name: 'sample', namespace: 'default' };
  const reader = createManifestDiffReader({ compareManifest: async (_target, _locator, _format, _uid, project) => { captures++; return project({ kind: 'live', reference, uid: 'u', resourceVersion: '1', text: 'x'.repeat(1_048_576) }); }, comparisonSnapshot: async (_target, project) => project() }, () => now);
  const f = await fixture(); const first = await reader.read(f.request, signal()); for (let i = 1; i < 4; i++) await reader.read(f.request, signal()); await assert.rejects(reader.read(f.request, signal()), /QUERY_LIMIT/); assert.equal(captures, 4);
  now = 60001; if (first.kind !== 'live-comparison' || !first.nextCursor) throw new Error('Expected cursor'); await assert.rejects(reader.read({ ...f.request, cursor: first.nextCursor }, signal()), /VIEW_EXPIRED/); reader.close(); f.close();
});
test('client completes all validated live chunks before comparing and never uploads local body or uses operation routes', async () => {
  const f = await fixture(); f.data('x'.repeat(150_000)); await f.client.read('live', 'json'); assert.equal(f.last().phase, 'ready'); const document = f.last().documents[0]; assert.equal(document?.phase, 'live'); assert.ok(document?.live && document.live.length > 150_000); assert.equal(document?.observed?.text, '');
  for (const body of f.clientRequests) { const value = JSON.parse(body) as { text?: string; body?: string; content?: string }; assert.equal(value.text, undefined); assert.equal(value.body, undefined); assert.equal(value.content, undefined); } assert.equal(f.requests.length, 3); f.close();
});
test('client represents empty/no-editor/unresolved/missing/lookup-failed distinctly without inventing no-change or an Apply confirmation', async () => {
  const f = await fixture(), source = f.snapshot(); assert.ok(source); f.source(undefined); await f.client.read('live', 'json'); assert.equal(f.last().reason, 'no-editor');
  f.source({ ...source, text: ' \n', format: 'yaml' }); await f.client.read('file', 'yaml'); assert.equal(f.last().reason, 'no-input'); assert.equal(f.requests.length, 0);
  f.source({ ...source, text: '{"something":1}' }); await f.client.read('file', 'json'); assert.equal(f.last().documents[0]?.phase, 'unresolved'); assert.equal(f.requests.length, 0);
  f.source(source); f.status(404); await f.client.read('file', 'json'); assert.equal(f.last().documents[0]?.phase, 'missing'); f.status(403); await f.client.read('file', 'json'); assert.equal(f.last().documents[0]?.phase, 'failed'); assert.equal(f.last().documents[0]?.code, 'FORBIDDEN'); f.close();
});
test('multi-document client compares each exact locator and keeps per-document outcomes without writing or switching context', async () => {
  const f = await fixture(), source = f.snapshot(); assert.ok(source); f.source({ ...source, format: 'yaml', text: 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: sample}\n---\nno: kind\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: sample, namespace: other}\n' });
  await f.client.read('file', 'yaml'); assert.deepEqual(f.last().documents.map(document => document.phase), ['live', 'unresolved', 'live']); assert.equal(f.requests.filter(request => request.purpose === 'manifest-diff').length, 2); f.close();
});
test('cancel/source change/close refuses late comparison delivery and clears closed buffers, without prematurely releasing an actual pending RPC slot', async () => {
  for (const action of ['cancel', 'change', 'close'] as const) {
    const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); f.before(async () => { entered.resolve(); await release.promise; }); const read = f.client.read('live', 'json'); await entered.promise;
    if (action === 'cancel') f.client.cancel(); else if (action === 'close') f.client.reset(); else { const source = f.snapshot(); assert.ok(source); f.source({ ...source, revision: source.revision + 1, text: source.text + ' ' }); f.client.changed(); }
    const count = f.states.length; release.resolve(); await read; assert.equal(f.states.length, count); assert.equal(f.last().phase, action === 'close' ? 'idle' : 'error'); f.close();
  }
});
test('literal comparison preserves CRLF/BOM/last newline and yields accurate reconstructible bounded ranges, never semantic equality', () => {
  for (const [local, live] of [['a\nb\nc\n', 'a\nx\nc\n'], ['', 'one\n'], ['one\n', ''], ['a\r\n', 'a\n'], ['\ufeffa', 'a'], ['a\n', 'a']]) {
    assert.ok(local !== undefined && live !== undefined); const result = compareDocumentText(local, live); assert.equal(result.equal, false); assert.equal(result.alignment, 'bounded-lines');
    const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [], left = lines(local), right = lines(live);
    assert.equal(result.ranges.map(range => left.slice(range.localStart, range.localEnd).join('')).join(''), local); assert.equal(result.ranges.map(range => right.slice(range.liveStart, range.liveEnd).join('')).join(''), live);
    for (const range of result.ranges.filter(range => range.kind === 'equal')) assert.equal(left.slice(range.localStart, range.localEnd).join(''), right.slice(range.liveStart, range.liveEnd).join(''));
  }
  assert.equal(compareDocumentText('same', 'same').equal, true); assert.equal(compareDocumentText('{"a":1}', '{ "a":1 }').equal, false);
});
test('line/work budget omission remains explicitly different with complete texts available, not truncated equal success', () => {
  const result = compareDocumentText('a\n'.repeat(20_001), 'b\n'.repeat(20_001)); assert.equal(result.equal, false); assert.equal(result.alignment, 'omitted-budget'); assert.deepEqual(result.ranges, []);
  assert.throws(() => compareDocumentText('bad\0body', 'anything'), /CONTENT_INVALID/);
});
test('close failure or inconsistent live body is a failed read, never a missing object or healthy empty comparison', async () => {
  const f = await fixture(); f.failClose(); await assert.rejects(f.gateway.readManifestDiff(f.request, signal()), /STATE_UNAVAILABLE/); f.close();
  const second = await fixture(); second.raw('{invalid'); await assert.rejects(second.gateway.readManifestDiff(second.request, signal()), /CONTENT_INVALID/); second.close();
});
test('client rejects a wrong reference even when response echoes the correct locator/target and supplies a well-formed body', async () => {
  const f = await fixture(), source = f.snapshot(); assert.ok(source); const states: ManifestDiffState[] = [];
  const client = new ManifestDiffClient(async request => {
    const page = await f.gateway.readManifestDiff(JSON.parse(request.body), signal()); if (page.kind !== 'live-comparison') throw new Error('Expected live');
    return { status: 200, body: JSON.stringify({ ...page, reference: { ...page.reference, namespace: 'wrong-namespace' } }) };
  }, () => source, state => states.push(state));
  await client.read('live', 'json'); assert.equal(states.at(-1)?.phase, 'error'); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.documents.length, 0); client.dispose(); f.close();
});
test('client keeps two actual RPC slots occupied across reset/cancel until their read promises settle', async () => {
  const f = await fixture(), source = f.snapshot(); assert.ok(source); const pending: Array<ReturnType<typeof Promise.withResolvers<{ status: number; body: string }>>> = [], states: ManifestDiffState[] = [];
  const client = new ManifestDiffClient(async () => { const promise = Promise.withResolvers<{ status: number; body: string }>(); pending.push(promise); return promise.promise; }, () => source, state => states.push(state));
  const one = client.read('live', 'json'); client.cancel(); client.reset(); const two = client.read('live', 'json'); client.reset();
  await client.read('live', 'json'); assert.equal(pending.length, 2); assert.equal(states.at(-1)?.documents[0]?.code, 'QUERY_LIMIT');
  for (const promise of pending) promise.resolve({ status: 403, body: '{"error":{"code":"FORBIDDEN"}}' }); await Promise.all([one, two]);
  const three = client.read('live', 'json'); assert.equal(pending.length, 3); pending[2]?.resolve({ status: 403, body: '{"error":{"code":"FORBIDDEN"}}' }); await three;
  assert.equal(states.at(-1)?.documents[0]?.code, 'FORBIDDEN'); client.dispose(); f.close();
});
test('cancelled initial read cannot publish or retain its late snapshot after a synthetic transport settles', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), controller = new AbortController();
  f.before(async request => { if (request.purpose === 'manifest-diff') { entered.resolve(); await release.promise; } });
  const pending = f.gateway.readManifestDiff(f.request, controller.signal); const rejected = assert.rejects(pending, /QUERY_CANCELLED/); await entered.promise; controller.abort(); release.resolve(); await rejected; f.close();
});
test('bounded line ranges reconstruct deterministic mixed insertion/deletion inputs with no duplicated or missing source lines', () => {
  let seed = 7;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let sample = 0; sample < 64; sample++) {
    const left = Array.from({ length: 60 }, () => `${next() % 5}\n`), right = [...left];
    for (let change = 0; change < 10; change++) { const index = next() % (right.length + 1); right.splice(index, next() % 2, `new-${next() % 9}\r\n`); }
    const result = compareDocumentText(left.join(''), right.join('')); assert.equal(result.alignment, 'bounded-lines'); let i = 0, j = 0;
    for (const range of result.ranges) { assert.equal(range.localStart, i); assert.equal(range.liveStart, j); if (range.kind === 'equal') assert.deepEqual(left.slice(i, range.localEnd), right.slice(j, range.liveEnd)); i = range.localEnd; j = range.liveEnd; }
    assert.equal(i, left.length); assert.equal(j, right.length);
  }
});
});
