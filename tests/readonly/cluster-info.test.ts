// Only synthetic read transports/protocols/clients. Never invokes CLI, workers, real configuration, SDK or write handlers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { inspectionBytes, inspectionPageSchema, inspectionRequestSchema } from '../../src/shared/inspection-protocol.ts';
import { InspectionClient } from '../../src/host/inspection-client.ts';
import type { InspectionState } from '../../src/host/inspection-client.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { createInspectionReader } from '../../src/service/queries/inspection-output.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { parseReadWorkerStart } from '../../src/service/queries/read-worker-protocol.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';

const signal = () => new AbortController().signal;
const output = 'Kubernetes control plane is running at https://synthetic.invalid\nCoreDNS is running at https://synthetic.invalid/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n';
async function fixture(text = output) {
  let changed = false, changeAfter = false, status = 200, current = text, errorBodyConsumed = false;
  const requests: ResourceReadRequest[] = [], states: InspectionState[] = [];
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active',
    clusters: [{ name: 'c', cluster: { server: changed ? 'https://changed.invalid' : 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c', namespace: 'team' } }, { name: 'inactive', context: { cluster: 'c', namespace: 'team' } }] }) }));
  const snapshot = await config.read({ mode: 'default' }), target = { serviceGeneration: 's', projectId: 'view', configIdentity: snapshot.snapshot.configIdentity, context: 'active', namespace: 'team' };
  const request = { protocol: 2 as const, selection: { mode: 'default' as const }, target, mode: 'cluster-info' as const };
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => {
    kubectlReadArguments(request, '/synthetic/configuration.pipe'); requests.push(request);
    assert.equal(request.purpose, 'cluster-info'); if (changeAfter) changed = true;
    return { status, body: { async *[Symbol.asyncIterator]() { if (status !== 200) errorBodyConsumed = true; yield Buffer.from(current); } }, close: async () => {} };
  } });
  const transport = async (input: { method: 'POST'; path: string; body: string }) => {
    assert.equal(input.path, '/v2/inspection/read');
    try { return { status: 200, body: JSON.stringify(await gateway.readInspection(JSON.parse(input.body) as unknown, signal())) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  };
  const client = new InspectionClient(transport, state => states.push(state));
  return { gateway, request, client, states, requests, change: () => { changed = true; }, after: () => { changeAfter = true; }, setText: (text: string) => { current = text; },
    setStatus: (value: number) => { status = value; }, errorBodyConsumed: () => errorBodyConsumed, close() { client.dispose(); gateway.close(); } };
}
const clusterOnly = { inspect: async () => { throw new Error('Unexpected resource printer'); }, verifyReference: async () => { throw new Error('Unexpected resource metadata'); } };

test('Cluster Info request is a distinct strict variant without reference, service namespace, dump, URL or arbitrary args', async () => {
  const f = await fixture(); assert.equal(inspectionRequestSchema.safeParse(f.request).success, true);
  for (const change of [{ reference: {} }, { serviceNamespace: 'team' }, { namespace: 'team' }, { dump: true }, { args: ['dump'] }, { url: 'https://other.invalid' }, { mode: 'cluster-info dump' }]) assert.equal(inspectionRequestSchema.safeParse({ ...f.request, ...change }).success, false);
  f.close();
});
test('Cluster Info plan explicitly pins original context, kube-system, no disk cache and no dump/proxy/terminal', async () => {
  const f = await fixture(); await f.gateway.readInspection(f.request, signal()); const request = f.requests[0]; assert.ok(request);
  assert.deepEqual(kubectlReadArguments(request, '/synthetic/pipe'), ['--kubeconfig=/synthetic/pipe', '--context=active', '--namespace=kube-system', '--cache-dir=/dev/null', '--request-timeout=7s', '--profile=none', '--v=0', 'cluster-info']);
  assert.equal(request.path, '/api/v1/namespaces/kube-system/services'); assert.deepEqual(request.query, {}); f.close();
});
test('private worker request only accepts the exact Cluster Info intent path without extra flags or alternate Service scopes', async () => {
  const f = await fixture(); await f.gateway.readInspection(f.request, signal()); const request = f.requests[0]; assert.ok(request);
  const start = { protocol: 1, kind: 'read', request, snapshot: new Uint8Array([123]), path: '/synthetic/bin' };
  assert.equal(parseReadWorkerStart(start).request.purpose, 'cluster-info');
  for (const change of [{ path: '/api/v1/namespaces/team/services' }, { path: '/api/v1/pods' }, { query: { 'output-directory': '/synthetic/dump' } }, { query: { watch: 'true' } }, { args: ['dump'] }]) assert.throws(() => parseReadWorkerStart({ ...start, request: { ...request, ...change } })); f.close();
});
test('real gateway/reader preserves exact CLI text in a Cluster Info DTO without synthetic resource UID/RV', async () => {
  const f = await fixture(); const page = await f.gateway.readInspection(f.request, signal()); assert.equal(page.mode, 'cluster-info');
  assert.equal(page.text, output); assert.equal('reference' in page, false); assert.equal(page.mode === 'cluster-info' && page.serviceNamespace, 'kube-system'); assert.equal(page.target.namespace, 'team'); assert.equal(f.requests.length, 1); f.close();
});
test('Cluster Info reads selected active context only and rejects client-supplied inactive context or namespace', async () => {
  const f = await fixture();
  for (const target of [{ ...f.request.target, context: 'inactive' }, { ...f.request.target, namespace: 'kube-system' }, { ...f.request.target, serviceGeneration: 'other' }]) await assert.rejects(f.gateway.readInspection({ ...f.request, target }, signal()), /STALE_TARGET/);
  assert.equal(f.requests.length, 0); f.close();
});
test('configuration drift before Cluster Info prevents CLI-purpose dispatch', async () => {
  const f = await fixture(); f.change(); await assert.rejects(f.gateway.readInspection(f.request, signal()), /STALE_TARGET/); assert.equal(f.requests.length, 0); f.close();
});
test('configuration drift after Cluster Info discards all printer output', async () => {
  const f = await fixture('SYNTHETIC_OUTPUT'); f.after(); await f.client.read(f.request); assert.equal(f.states.at(-1)?.error, 'STALE_TARGET'); assert.equal(f.states.at(-1)?.text, ''); assert.equal(f.requests.length, 1); f.close();
});
test('Cluster Info permission error does not consume sensitive raw error response', async () => {
  const f = await fixture('SYNTHETIC_SECRET'); f.setStatus(403); await f.client.read(f.request);
  assert.equal(f.errorBodyConsumed(), false); assert.equal(f.states.at(-1)?.error, 'FORBIDDEN'); assert.equal(JSON.stringify(f.states).includes('SYNTHETIC_SECRET'), false); f.close();
});
test('Cluster Info output and client transport budgets fail whole rather than report a healthy truncated result', async () => {
  const f = await fixture('a'.repeat(inspectionBytes + 1)); await f.client.read(f.request); assert.equal(f.states.at(-1)?.error, 'BUDGET_EXCEEDED'); assert.equal(f.states.at(-1)?.text, ''); f.close();
});
test('Cluster Info snapshot continuations never rerun changing services and only revalidate configuration', async () => {
  const text = 'a'.repeat(70_000), f = await fixture(text); await f.client.read(f.request); assert.equal(f.states.at(-1)?.complete, false); f.setText('different services');
  await f.client.next(); assert.equal(f.states.at(-1)?.text, text); assert.equal(f.states.at(-1)?.complete, true); assert.equal(f.requests.length, 1); f.close();
});
test('Cluster Info continuation rejects changed configuration and does not append stale output', async () => {
  const f = await fixture('a'.repeat(70_000)); await f.client.read(f.request); const old = f.states.at(-1)?.text; f.change(); await f.client.next();
  assert.equal(f.states.at(-1)?.error, 'STALE_TARGET'); assert.equal(f.states.at(-1)?.text, old); assert.equal(f.states.at(-1)?.stale, true); assert.equal(f.requests.length, 1); f.close();
});
test('Cluster Info cursor cannot cross project, selection, mode or namespace binding', async () => {
  const f = await fixture('a'.repeat(70_000)), first = await f.gateway.readInspection(f.request, signal()); assert.ok(first.nextCursor);
  const pod = { type: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' }, namespace: 'team', name: 'sample', uid: 'u', resourceVersion: '1' };
  for (const change of [{ target: { ...f.request.target, projectId: 'other' } }, { selection: { mode: 'file', path: '/synthetic/other' } }, { target: { ...f.request.target, namespace: 'default' } }, { mode: 'describe', reference: pod }]) await assert.rejects(f.gateway.readInspection({ ...f.request, cursor: first.nextCursor, ...change }, signal()), /STALE_TARGET/);
  assert.equal(f.requests.length, 1); f.close();
});
test('Cluster Info snapshot expiry after configuration verification is fixed, not extended by continuation', async () => {
  const f = await fixture(); let clock = 1000;
  const reader = createInspectionReader({ ...clusterOnly, clusterInfo: async (_t, project) => project('a'.repeat(70_000)), verifyTarget: async () => { clock += 60_000; } }, () => clock);
  const first = await reader.read(f.request, signal()); assert.ok(first.nextCursor);
  await assert.rejects(reader.read({ ...f.request, cursor: first.nextCursor }, signal()), /CONTINUATION_EXPIRED/); reader.dispose(); f.close();
});
test('Cluster Info shares the same retained output budget as resource output instead of allocating another cache', async () => {
  const f = await fixture(); const reader = createInspectionReader({ clusterInfo: async (_t, project) => project('a'.repeat(inspectionBytes)),
    inspect: async (_t, _r, _m, project) => project('b'.repeat(inspectionBytes)), verifyTarget: async () => {}, verifyReference: async () => {} });
  const reference = { type: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' }, namespace: 'team', name: 'sample', uid: 'u', resourceVersion: '1' };
  for (let n = 0; n < 2; n++) { await reader.read(f.request, signal()); await reader.read({ ...f.request, mode: 'wide', reference }, signal()); }
  await assert.rejects(reader.read(f.request, signal()), /QUERY_LIMIT/); reader.dispose(); f.close();
});
test('explicit Cluster Info refresh reruns only original context and replaces the old snapshot', async () => {
  const f = await fixture('first'); await f.client.read(f.request); f.setText('second'); await f.client.refresh();
  assert.equal(f.states.at(-1)?.text, 'second'); assert.equal(f.states.at(-1)?.source?.mode, 'cluster-info'); assert.equal(f.requests.length, 2); assert.equal(f.requests.every(r => r.target.context === 'active'), true); f.close();
});
test('failed Cluster Info refresh keeps old output stale and disables further paging', async () => {
  const f = await fixture('first'); await f.client.read(f.request); f.setStatus(404); await f.client.refresh(); const count = f.requests.length; await f.client.next();
  assert.equal(f.requests.length, count); assert.equal(f.states.at(-1)?.stale, true); assert.equal(f.states.at(-1)?.text, 'first'); assert.equal(f.states.at(-1)?.complete, false); f.close();
});
test('Cluster Info DTO refuses false resource identity, wrong service namespace and unpaired Unicode', async () => {
  const f = await fixture(), page = await f.gateway.readInspection(f.request, signal());
  for (const change of [{ reference: {} }, { serviceNamespace: 'team' }, { text: '\uD800' }, { token: 'SYNTHETIC_SECRET' }, { end: page.end + 1 }]) assert.equal(inspectionPageSchema.safeParse({ ...page, ...change }).success, false); f.close();
});
test('client rejects a resource-output response to Cluster Info without exposing its body', async () => {
  const f = await fixture(), page = await f.gateway.readInspection(f.request, signal()), states: InspectionState[] = [];
  const { serviceNamespace: _namespace, ...common } = page.mode === 'cluster-info' ? page : { ...page, serviceNamespace: 'kube-system' };
  const response = { ...common, mode: 'wide', reference: { type: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' }, namespace: 'team', name: 'sample', uid: 'u', resourceVersion: '1' } };
  const client = new InspectionClient(async () => ({ status: 200, body: JSON.stringify(response) }), state => states.push(state)); await client.read(f.request);
  assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.text, ''); client.dispose(); f.close();
});
test('Cluster Info retains malicious markup and dump hint as data, never an editable buffer or action', async () => {
  const text = '<script>not executable</script>\nhttps://synthetic.invalid/proxy\nuse kubectl cluster-info dump\n', f = await fixture(text); await f.client.read(f.request);
  assert.equal(f.states.at(-1)?.text, text); assert.equal('editor' in (f.states.at(-1) ?? {}), false); assert.equal(f.requests.length, 1); f.close();
});
test('Cluster Info client reset ignores a late read result and does not start a replacement query', async () => {
  const f = await fixture(), page = await f.gateway.readInspection(f.request, signal()), pending = Promise.withResolvers<{ status: number; body: string }>(), states: InspectionState[] = [];
  const client = new InspectionClient(async () => pending.promise, state => states.push(state)), read = client.read(f.request); client.reset(); pending.resolve({ status: 200, body: JSON.stringify(page) }); await read;
  assert.equal(states.at(-1)?.phase, 'idle'); assert.equal(states.at(-1)?.text, ''); client.dispose(); f.close();
});
test('Cluster Info cancellation and closed gateway reject without a transport read', async () => {
  const f = await fixture(); await assert.rejects(f.gateway.readInspection(f.request, AbortSignal.abort()), /QUERY_CANCELLED/); f.gateway.close();
  await assert.rejects(f.gateway.readInspection(f.request, signal()), /SERVICE_CLOSED/); assert.equal(f.requests.length, 0); f.close();
});
test('Cluster Info single-page results do not consume retained snapshot slots', async () => {
  const f = await fixture(); const reader = createInspectionReader({ ...clusterOnly, clusterInfo: async (_t, project) => project(output), verifyTarget: async () => {} });
  for (let n = 0; n < 20; n++) assert.equal((await reader.read(f.request, signal())).nextCursor, null); reader.dispose(); f.close();
});
