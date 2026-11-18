// Synthetic transport/metadata/output only. No real adapters, CLI, filesystem, bridge, auth or write-chain imports/calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { inspectionBytes, inspectionPageSchema, inspectionRequestSchema } from '../../src/shared/inspection-protocol.ts';
import { InspectionClient } from '../../src/host/inspection-client.ts';
import type { InspectionState } from '../../src/host/inspection-client.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { createInspectionReader } from '../../src/service/queries/inspection-output.ts';
import { createResourceReader } from '../../src/service/queries/resource-reader.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';
import { parseReadWorkerStart } from '../../src/service/queries/read-worker-protocol.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';

const signal = () => new AbortController().signal;
const reference = { type: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' as const }, namespace: 'default', name: 'sample', uid: 'u', resourceVersion: '1' };
const object = () => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'sample', namespace: 'default', uid: 'u', resourceVersion: '1' }, spec: {}, status: {} });
const resourceOnly = { clusterInfo: async () => { throw new Error('Unexpected Cluster Info'); }, verifyTarget: async () => { throw new Error('Unexpected target-only verification'); } };
async function fixture(output = 'NAME READY STATUS AGE\nsample 1/1 Running 1m\n') {
  let raw = object(), text = output, status = 200, iteratedError = false, changeAfter = false, changedConfig = false;
  const requests: ResourceReadRequest[] = [], states: InspectionState[] = [];
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active',
    clusters: [{ name: 'c', cluster: { server: changedConfig ? 'https://changed.invalid' : 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const readConfig = await config.read({ mode: 'default' }), target = { serviceGeneration: 's', projectId: 'view', configIdentity: readConfig.snapshot.configIdentity, context: 'active', namespace: 'default' };
  const request = { protocol: 2 as const, selection: { mode: 'default' as const }, target, reference, mode: 'wide' as const };
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => {
    kubectlReadArguments(request, '/synthetic/configuration.pipe'); requests.push(request);
    const cli = request.purpose === 'resource-wide' || request.purpose === 'resource-describe', body = cli ? text : JSON.stringify(raw);
    if (cli && changeAfter) raw = { ...raw, metadata: { ...raw.metadata, uid: 'replacement' } };
    return { status, body: { async *[Symbol.asyncIterator]() { if (status !== 200) iteratedError = true; yield Buffer.from(body); } }, close: async () => {} };
  } });
  const transport = async (input: { method: 'POST'; path: string; body: string }) => {
    assert.equal(input.path, '/v2/inspection/read');
    try { return { status: 200, body: JSON.stringify(await gateway.readInspection(JSON.parse(input.body) as unknown, signal())) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  };
  const client = new InspectionClient(transport, value => states.push(value));
  return { target, request, gateway, client, states, requests, transport, setOutput: (value: string) => { text = value; }, setStatus: (value: number) => { status = value; },
    replace: () => { raw = { ...raw, metadata: { ...raw.metadata, uid: 'replacement' } }; }, after: () => { changeAfter = true; }, configChange: () => { changedConfig = true; }, errorRead: () => iteratedError,
    close() { client.dispose(); gateway.close(); } };
}

test('inspection named-reference admission rejects arbitrary argv/URLs/all and unpinned custom resources', async () => {
  const f = await fixture();
  for (const change of [{ mode: 'apply' }, { command: ['describe'] }, { url: 'https://synthetic.invalid' }, { reference: { ...reference, name: '' } }, { reference: { ...reference, type: { ...reference.type, group: 'custom.invalid' } } }]) assert.equal(inspectionRequestSchema.safeParse({ ...f.request, ...change }).success, false);
  f.close();
});
test('wide plan has real get output flags, full GVR/name, original context/namespace and fixed non-directory cache sentinel', async () => {
  const f = await fixture(); await f.gateway.readInspection(f.request, signal()); const request = f.requests.find(item => item.purpose === 'resource-wide'); assert.ok(request);
  const args = kubectlReadArguments(request, '/synthetic/pipe');
  assert.ok(args.includes('get') && args.includes('pods.v1./sample') && args.includes('--output=wide') && args.includes('--server-print=true') && args.includes('--cache-dir=/dev/null'));
  assert.ok(args.includes('--context=active') && args.includes('--namespace=default')); assert.equal(args.some(arg => arg.startsWith('--raw=')), false); f.close();
});
test('Describe uses one slash TYPE/NAME to suppress prefix fallback, explicit events and no wide flag', async () => {
  const f = await fixture('Name: sample\nEvents: none\n'); await f.gateway.readInspection({ ...f.request, mode: 'describe' }, signal());
  const request = f.requests.find(item => item.purpose === 'resource-describe'); assert.ok(request); const args = kubectlReadArguments(request, '/synthetic/pipe');
  assert.ok(args.includes('describe') && args.includes('pods.v1./sample') && args.includes('--show-events=true') && args.includes('--chunk-size=100')); assert.equal(args.includes('--output=wide'), false); f.close();
});
test('private worker start validation admits only whitelisted named inspection purposes and never new arguments', async () => {
  const f = await fixture(); await f.gateway.readInspection(f.request, signal()); const request = f.requests.find(item => item.purpose === 'resource-wide'); assert.ok(request);
  const start = { protocol: 1, kind: 'read', request, snapshot: new Uint8Array([123]), path: '/synthetic/bin' }; assert.equal(parseReadWorkerStart(start).request.purpose, 'resource-wide');
  for (const change of [{ path: '/api/v1/pods' }, { path: '/api/v1/namespaces/default/pods/sample/exec' }, { query: { watch: 'true' } }, { command: ['get'] }]) assert.throws(() => parseReadWorkerStart({ ...start, request: { ...request, ...change } })); f.close();
});
test('real reader orchestration brackets output with original metadata GETs and preserves printer text rather than a JSON/Load conversion', async () => {
  const output = 'NAME\tAGE\r\nsample\t1m\r\n', f = await fixture(output); const page = await f.gateway.readInspection(f.request, signal());
  assert.equal(page.text, output); assert.equal(page.kind, 'inspection-output'); assert.deepEqual(f.requests.map(item => item.purpose), ['resource-object', 'resource-wide', 'resource-object']); f.close();
});
test('Describe retains a distinct read-only mode without opening an edit buffer', async () => {
  const f = await fixture('Name: sample\nDescription: <script>not HTML</script>\n'); await f.client.read({ ...f.request, mode: 'describe' });
  assert.equal(f.states.at(-1)?.source?.mode, 'describe'); assert.equal(f.states.at(-1)?.complete, true); assert.equal('editor' in (f.states.at(-1) ?? {}), false); f.close();
});
test('changed UID before printing prevents CLI-purpose dispatch', async () => {
  const f = await fixture(); f.replace(); await assert.rejects(f.gateway.readInspection(f.request, signal()), /STALE_TARGET/);
  assert.deepEqual(f.requests.map(item => item.purpose), ['resource-object']); f.close();
});
test('changed UID after printing discards all output instead of publishing a same-name replacement', async () => {
  const f = await fixture('SYNTHETIC_OUTPUT'); f.after(); await assert.rejects(f.gateway.readInspection(f.request, signal()), /STALE_TARGET/); assert.equal(f.requests.length, 3); f.close();
});
test('changed configuration invalidates inspection without starting a transport read', async () => {
  const f = await fixture(); f.configChange(); await assert.rejects(f.gateway.readInspection(f.request, signal()), /STALE_TARGET/); assert.equal(f.requests.length, 0); f.close();
});
test('permission errors never consume or echo sensitive raw response bodies', async () => {
  const f = await fixture('SYNTHETIC_SECRET'); f.setStatus(403); await f.client.read(f.request);
  assert.equal(f.errorRead(), false); assert.equal(f.states.at(-1)?.error, 'FORBIDDEN'); assert.equal(JSON.stringify(f.states).includes('SYNTHETIC_SECRET'), false); f.close();
});
test('continuation reads the exact retained printer snapshot without rerunning changing CLI AGE text', async () => {
  const text = 'a'.repeat(70_000), f = await fixture(text), first = await f.gateway.readInspection(f.request, signal()); assert.ok(first.nextCursor);
  f.setOutput('entirely different live AGE'); const next = await f.gateway.readInspection({ ...f.request, cursor: first.nextCursor }, signal());
  assert.equal(first.text + next.text, text); assert.equal(f.requests.filter(item => item.purpose === 'resource-wide').length, 1); assert.equal(f.requests.length, 4); f.close();
});
test('continued printer output still rejects a changed reference or changed mode/selection/project binding', async () => {
  const f = await fixture('a'.repeat(70_000)), first = await f.gateway.readInspection(f.request, signal()); assert.ok(first.nextCursor);
  for (const change of [{ mode: 'describe' }, { target: { ...f.target, projectId: 'other' } }, { selection: { mode: 'file', path: '/synthetic/other' } }]) await assert.rejects(f.gateway.readInspection({ ...f.request, cursor: first.nextCursor, ...change }, signal()), /STALE_TARGET/);
  f.replace(); await assert.rejects(f.gateway.readInspection({ ...f.request, cursor: first.nextCursor }, signal()), /STALE_TARGET/); f.close();
});
test('ephemeral inspection snapshot expires at its fixed deadline without starting another CLI output', async () => {
  const f = await fixture(), reads: string[] = []; let clock = 1000;
  const reader = createInspectionReader({ ...resourceOnly, inspect: async (_target, _reference, _mode, project) => { reads.push('print'); return project('a'.repeat(70_000)); }, verifyReference: async () => { reads.push('metadata'); } }, () => clock);
  const first = await reader.read(f.request, signal()); assert.ok(first.nextCursor); clock += 60_000;
  await assert.rejects(reader.read({ ...f.request, cursor: first.nextCursor }, signal()), /CONTINUATION_EXPIRED/); assert.deepEqual(reads, ['print']); reader.dispose(); f.close();
});
test('per-output and total retained output byte budgets fail without silently truncating', async () => {
  const f = await fixture();
  const huge = createInspectionReader({ ...resourceOnly, inspect: async (_t, _r, _m, project) => project('a'.repeat(inspectionBytes + 1)), verifyReference: async () => {} });
  await assert.rejects(huge.read(f.request, signal()), /BUDGET_EXCEEDED/); huge.dispose();
  const retained = createInspectionReader({ ...resourceOnly, inspect: async (_t, _r, _m, project) => project('a'.repeat(inspectionBytes)), verifyReference: async () => {} });
  for (let n = 0; n < 4; n++) await retained.read(f.request, signal()); await assert.rejects(retained.read(f.request, signal()), /QUERY_LIMIT/); retained.dispose(); f.close();
});
test('client accumulates surrogate-safe chunks as complete read-only text without auto-paging', async () => {
  const text = '😀'.repeat(40_000), f = await fixture(text); await f.client.read(f.request); assert.equal(f.states.at(-1)?.complete, false);
  assert.equal(f.requests.filter(item => item.purpose === 'resource-wide').length, 1); await f.client.next(); assert.equal(f.states.at(-1)?.text, text); assert.equal(f.states.at(-1)?.complete, true); f.close();
});
test('explicit refresh reruns original printer mode and does not mix the previous snapshot', async () => {
  const f = await fixture('first'); await f.client.read(f.request); f.setOutput('second'); await f.client.refresh();
  assert.equal(f.states.at(-1)?.text, 'second'); assert.equal(f.requests.filter(item => item.purpose === 'resource-wide').length, 2); f.close();
});
test('failed refresh retains stale old text with a fixed error, not an empty healthy output', async () => {
  const f = await fixture('first'); await f.client.read(f.request); f.setStatus(404); await f.client.refresh();
  assert.equal(f.states.at(-1)?.stale, true); assert.equal(f.states.at(-1)?.text, 'first'); assert.equal(f.states.at(-1)?.complete, false); f.close();
});
test('reset/dispose ignores late read delivery without a write/session cancellation path', async () => {
  const f = await fixture(), page = await f.gateway.readInspection(f.request, signal()), deferred = Promise.withResolvers<{ status: number; body: string }>(), states: InspectionState[] = [];
  const client = new InspectionClient(async () => deferred.promise, state => states.push(state)); const pending = client.read(f.request); client.reset(); deferred.resolve({ status: 200, body: JSON.stringify(page) }); await pending;
  assert.equal(states.at(-1)?.phase, 'idle'); assert.equal(states.at(-1)?.text, ''); client.dispose(); f.close();
});
test('output DTO refuses malformed chunk bounds, unpaired Unicode or body/token/argv extensions', async () => {
  const f = await fixture(), page = await f.gateway.readInspection(f.request, signal());
  for (const change of [{ end: page.end + 1 }, { text: '\uD800' }, { content: 'SYNTHETIC_SECRET' }, { argv: ['get'] }, { token: 'SYNTHETIC_SECRET' }]) assert.equal(inspectionPageSchema.safeParse({ ...page, ...change }).success, false); f.close();
});
test('a closed independent resource reader cannot start a printer request and cancelled inputs cannot publish output', async () => {
  let calls = 0; const f = await fixture(); const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async value => value, read: async () => { calls++; throw new Error('must not read'); } });
  reader.close(); await assert.rejects(reader.inspect(f.target, reference, 'wide', () => { throw new Error('must not project'); }, signal())); assert.equal(calls, 0);
  await assert.rejects(f.gateway.readInspection(f.request, AbortSignal.abort()), /QUERY_CANCELLED/); f.close();
});
test('tampered sealed cursors never dispatch a metadata or printer read', async () => {
  const f = await fixture('a'.repeat(70_000)), first = await f.gateway.readInspection(f.request, signal()); assert.ok(first.nextCursor);
  const count = f.requests.length, cursor = first.nextCursor, index = Math.floor(cursor.length / 2);
  await assert.rejects(f.gateway.readInspection({ ...f.request, cursor: cursor.slice(0, index) + (cursor[index] === 'A' ? 'B' : 'A') + cursor.slice(index + 1) }, signal()));
  assert.equal(f.requests.length, count); f.close();
});
test('fixed expiry is checked again after a slow continuation metadata verification', async () => {
  const f = await fixture(); let clock = 1000, checks = 0;
  const reader = createInspectionReader({ ...resourceOnly, inspect: async (_t, _r, _m, project) => project('a'.repeat(70_000)), verifyReference: async () => { checks++; clock += 60_000; } }, () => clock);
  const first = await reader.read(f.request, signal()); assert.ok(first.nextCursor);
  await assert.rejects(reader.read({ ...f.request, cursor: first.nextCursor }, signal()), /CONTINUATION_EXPIRED/); assert.equal(checks, 1); reader.dispose(); f.close();
});
test('single-page outputs do not exhaust retained snapshot slots and expired multi-page entries release capacity', async () => {
  const f = await fixture(); let clock = 1000, text = 'single';
  const reader = createInspectionReader({ ...resourceOnly, inspect: async (_t, _r, _m, project) => project(text), verifyReference: async () => {} }, () => clock);
  for (let n = 0; n < 20; n++) assert.equal((await reader.read(f.request, signal())).nextCursor, null);
  text = 'a'.repeat(70_000); for (let n = 0; n < 16; n++) assert.ok((await reader.read(f.request, signal())).nextCursor);
  await assert.rejects(reader.read(f.request, signal()), /QUERY_LIMIT/); clock += 60_000;
  assert.ok((await reader.read(f.request, signal())).nextCursor); reader.dispose(); f.close();
});
test('reader disposal while printing rejects late projection and cannot publish or retain output', async () => {
  const f = await fixture(), printed = Promise.withResolvers<string>();
  const reader = createInspectionReader({ ...resourceOnly, inspect: async (_t, _r, _m, project) => project(await printed.promise), verifyReference: async () => {} });
  const pending = reader.read(f.request, signal()); reader.dispose(); printed.resolve('late synthetic output');
  await assert.rejects(pending, /SERVICE_CLOSED/); await assert.rejects(reader.read(f.request, signal()), /SERVICE_CLOSED/); f.close();
});
test('client rejects cross-target, cross-mode and inconsistent byte totals before exposing printer text', async () => {
  const f = await fixture(), page = await f.gateway.readInspection(f.request, signal());
  for (const change of [{ target: { ...page.target, context: 'other' } }, { mode: 'describe' }, { reference: { ...reference, uid: 'replacement' } }, { totalBytes: page.totalBytes + 1 }]) {
    const states: InspectionState[] = [], client = new InspectionClient(async () => ({ status: 200, body: JSON.stringify({ ...page, ...change }) }), state => states.push(state));
    await client.read(f.request); assert.equal(states.at(-1)?.phase, 'error'); assert.equal(states.at(-1)?.text, ''); client.dispose();
  }
  f.close();
});
test('client rejects changed continuation snapshot identity without appending mixed output', async () => {
  const f = await fixture('a'.repeat(70_000)), first = await f.gateway.readInspection(f.request, signal()); assert.ok(first.nextCursor);
  const second = await f.gateway.readInspection({ ...f.request, cursor: first.nextCursor }, signal()), states: InspectionState[] = []; let calls = 0;
  const client = new InspectionClient(async () => ({ status: 200, body: JSON.stringify(++calls === 1 ? first : { ...second, contentIdentity: '0'.repeat(64) }) }), state => states.push(state));
  await client.read(f.request); await client.next(); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.text, first.text); assert.equal(states.at(-1)?.stale, true); client.dispose(); f.close();
});
test('client stop-waiting rejects a late result and dispose suppresses all later UI delivery', async () => {
  const f = await fixture(), page = await f.gateway.readInspection(f.request, signal()), deferred = Promise.withResolvers<{ status: number; body: string }>(), states: InspectionState[] = [];
  const client = new InspectionClient(async () => deferred.promise, state => states.push(state)), pending = client.read(f.request); client.cancel();
  assert.equal(states.at(-1)?.error, 'QUERY_CANCELLED'); const count = states.length; client.dispose(); deferred.resolve({ status: 200, body: JSON.stringify(page) }); await pending;
  assert.equal(states.length, count); assert.equal(states.at(-1)?.text, ''); f.close();
});
test('client caps actual unsettled transport reads even when newer revisions replace older requests', async () => {
  const f = await fixture(), page = await f.gateway.readInspection(f.request, signal()), deferred = Promise.withResolvers<{ status: number; body: string }>(), states: InspectionState[] = []; let calls = 0;
  const client = new InspectionClient(async () => { calls++; return deferred.promise; }, state => states.push(state)), pending = [];
  for (let n = 0; n < 5; n++) pending.push(client.read(f.request));
  assert.equal(calls, 4); assert.equal(states.at(-1)?.error, 'QUERY_LIMIT'); deferred.resolve({ status: 200, body: JSON.stringify(page) }); await Promise.all(pending);
  assert.equal(states.at(-1)?.error, 'QUERY_LIMIT'); assert.equal(states.at(-1)?.text, ''); client.dispose(); f.close();
});
