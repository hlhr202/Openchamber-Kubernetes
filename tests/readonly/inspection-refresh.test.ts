// Synthetic metadata/printer/read protocol only; never runs real worker/CLI/cache, bridge/SDK or any write chain.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { inspectionRequestSchema } from '../../src/shared/inspection-protocol.ts';
import type { InspectionRequest } from '../../src/shared/inspection-protocol.ts';
import { InspectionClient } from '../../src/host/inspection-client.ts';
import type { InspectionState } from '../../src/host/inspection-client.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { createInspectionReader } from '../../src/service/queries/inspection-output.ts';
import { captureInspectionReference } from '../../src/service/queries/inspection-reference.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';

const signal = () => new AbortController().signal;
const reference = { type: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' as const }, namespace: 'default', name: 'sample', uid: 'original', resourceVersion: '1' };
const object = (rv = '1', uid = 'original') => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'sample', namespace: 'default', uid, resourceVersion: rv } });
async function fixture() {
  let raw = object(), after: (() => void) | undefined, text = 'first', changed = false, status = 200;
  const reads: ResourceReadRequest[] = [], calls: InspectionRequest[] = [], states: InspectionState[] = [];
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active',
    clusters: [{ name: 'c', cluster: { server: changed ? 'https://changed.invalid' : 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const current = await config.read({ mode: 'default' }), target = { serviceGeneration: 's', projectId: 'view', configIdentity: current.snapshot.configIdentity, context: 'active', namespace: 'default' };
  const request = { protocol: 2 as const, selection: { mode: 'default' as const }, target, reference, mode: 'describe' as const };
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => {
    reads.push(request); const cli = request.purpose === 'resource-describe' || request.purpose === 'resource-wide', body = cli ? text : JSON.stringify(raw);
    if (cli) after?.(); return { status, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(body); } }, close: async () => {} };
  } });
  const client = new InspectionClient(async input => {
    const value = inspectionRequestSchema.parse(JSON.parse(input.body) as unknown); calls.push(value);
    try { return { status: 200, body: JSON.stringify(await gateway.readInspection(value, signal())) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  }, state => states.push(state));
  return { request, gateway, client, reads, calls, states, version: (rv: string, uid = 'original') => { raw = object(rv, uid); }, text: (value: string) => { text = value; },
    after: (callback: () => void) => { after = callback; }, change: () => { changed = true; }, status: (value: number) => { status = value; }, close() { client.dispose(); gateway.close(); } };
}

test('refresh intent is literal true and cannot combine with a continuation, cluster-info or arbitrary version options', async () => {
  const f = await fixture(); assert.equal(inspectionRequestSchema.safeParse({ ...f.request, refresh: true }).success, true);
  for (const change of [{ refresh: false }, { refresh: 'true' }, { refresh: true, cursor: 'old' }, { latest: true }, { mode: 'cluster-info', refresh: true }]) assert.equal(inspectionRequestSchema.safeParse({ ...f.request, ...change }).success, false); f.close();
});
test('normal exact-reference capture still rejects same-UID resourceVersion changes', () => {
  assert.throws(() => captureInspectionReference(object('2'), reference, false), /STALE_TARGET/);
});
test('read-only refresh captures a new RV only while keeping full original object identity', () => {
  const captured = captureInspectionReference(object('2'), reference, true); assert.equal(captured.resourceVersion, '2'); assert.equal(captured.uid, reference.uid); assert.ok(Object.isFrozen(captured));
});
test('refresh never accepts same-name recreation or changed namespace/name/kind/GVR', () => {
  for (const raw of [object('2', 'replacement'), { ...object('2'), kind: 'Service' }, { ...object('2'), apiVersion: 'apps/v1' },
    { ...object('2'), metadata: { ...object('2').metadata, name: 'other' } }, { ...object('2'), metadata: { ...object('2').metadata, namespace: 'other' } }]) assert.throws(() => captureInspectionReference(raw, reference, true), /STALE_TARGET/);
});
test('missing, empty or invalid resourceVersion is not a valid refresh', () => {
  for (const rv of [undefined, '', 2, 'bad\nvalue']) assert.throws(() => captureInspectionReference({ ...object(), metadata: { ...object().metadata, resourceVersion: rv } }, reference, true));
});
test('real gateway and reader refresh the same UID to its observed RV and bracket printer with exact new-version metadata', async () => {
  const f = await fixture(); f.version('2'); const page = await f.gateway.readInspection({ ...f.request, refresh: true }, signal());
  assert.ok(page.mode !== 'cluster-info'); assert.equal(page.reference.resourceVersion, '2'); assert.deepEqual(f.reads.map(r => r.purpose), ['resource-object', 'resource-describe', 'resource-object']); f.close();
});
test('initial read with old RV cannot silently become a refresh or dispatch a printer', async () => {
  const f = await fixture(); f.version('2'); await assert.rejects(f.gateway.readInspection(f.request, signal()), /STALE_TARGET/); assert.equal(f.reads.length, 1); f.close();
});
test('RV drift during the refreshed printer discards output even though UID remains the same', async () => {
  const f = await fixture(); f.version('2'); f.after(() => f.version('3')); await assert.rejects(f.gateway.readInspection({ ...f.request, refresh: true }, signal()), /STALE_TARGET/); f.close();
});
test('UID recreation during refreshed printing discards all output', async () => {
  const f = await fixture(); f.version('2'); f.after(() => f.version('2', 'replacement')); await assert.rejects(f.gateway.readInspection({ ...f.request, refresh: true }, signal()), /STALE_TARGET/); f.close();
});
test('configuration drift during refresh still invalidates output rather than rebinding to a new cluster', async () => {
  const f = await fixture(); f.version('2'); f.after(f.change); await assert.rejects(f.gateway.readInspection({ ...f.request, refresh: true }, signal()), /STALE_TARGET/); f.close();
});
test('refreshed snapshot cursor binds the observed reference and rejects the old RV without rerunning the CLI', async () => {
  const f = await fixture(); f.version('2'); f.text('a'.repeat(70_000)); const first = await f.gateway.readInspection({ ...f.request, refresh: true }, signal()); assert.ok(first.mode !== 'cluster-info' && first.nextCursor);
  await assert.rejects(f.gateway.readInspection({ ...f.request, cursor: first.nextCursor }, signal()), /STALE_TARGET/);
  const next = await f.gateway.readInspection({ ...f.request, reference: first.reference, cursor: first.nextCursor }, signal()); assert.equal(first.text + next.text, 'a'.repeat(70_000)); assert.equal(f.reads.filter(r => r.purpose === 'resource-describe').length, 1); f.close();
});
test('continuation does not follow a later RV even after an explicit refresh has created the snapshot', async () => {
  const f = await fixture(); f.version('2'); f.text('a'.repeat(70_000)); const first = await f.gateway.readInspection({ ...f.request, refresh: true }, signal()); assert.ok(first.mode !== 'cluster-info' && first.nextCursor); f.version('3');
  await assert.rejects(f.gateway.readInspection({ ...f.request, reference: first.reference, cursor: first.nextCursor }, signal()), /STALE_TARGET/); assert.equal(f.reads.filter(r => r.purpose === 'resource-describe').length, 1); f.close();
});
test('client refresh updates only its private source RV, then continues the captured snapshot without refresh flag', async () => {
  const f = await fixture(); await f.client.read(f.request); f.version('2'); f.text('b'.repeat(70_000)); await f.client.refresh();
  const source = f.states.at(-1)?.source; assert.ok(source && source.mode !== 'cluster-info'); assert.equal(source.reference.resourceVersion, '2'); assert.equal(source.refresh, undefined);
  await f.client.next(); assert.equal(f.states.at(-1)?.text, 'b'.repeat(70_000)); assert.equal(f.states.at(-1)?.complete, true);
  const refresh = f.calls[1], continuation = f.calls[2]; assert.ok(refresh && refresh.mode !== 'cluster-info' && refresh.refresh);
  assert.ok(continuation && continuation.mode !== 'cluster-info'); assert.equal(continuation.refresh, undefined); f.close();
});
test('failed refresh retains old source/reference/text as stale, never claims a new healthy version', async () => {
  const f = await fixture(); await f.client.read(f.request); f.version('2'); f.status(403); await f.client.refresh(); const state = f.states.at(-1);
  assert.equal(state?.stale, true); assert.equal(state?.text, 'first'); const source = state?.source; assert.ok(source && source.mode !== 'cluster-info'); assert.equal(source.reference.resourceVersion, '1'); f.close();
});
test('client refresh rejects a response for a replacement UID even when service response otherwise looks valid', async () => {
  const f = await fixture(), first = await f.gateway.readInspection(f.request, signal()), states: InspectionState[] = []; assert.ok(first.mode !== 'cluster-info'); let calls = 0;
  const client = new InspectionClient(async () => ({ status: 200, body: JSON.stringify(++calls === 1 ? first : { ...first, reference: { ...first.reference, uid: 'replacement', resourceVersion: '2' } }) }), state => states.push(state));
  await client.read(f.request); await client.refresh(); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.text, first.text); client.dispose(); f.close();
});
test('client initial read never accepts an unrequested new RV', async () => {
  const f = await fixture(), page = await f.gateway.readInspection(f.request, signal()), states: InspectionState[] = []; assert.ok(page.mode !== 'cluster-info');
  const client = new InspectionClient(async () => ({ status: 200, body: JSON.stringify({ ...page, reference: { ...page.reference, resourceVersion: '2' } }) }), state => states.push(state));
  await client.read(f.request); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.text, ''); client.dispose(); f.close();
});
test('wide output uses the same explicit refresh identity semantics without switching to Describe', async () => {
  const f = await fixture(); await f.client.read({ ...f.request, mode: 'wide' }); f.version('2'); await f.client.refresh();
  assert.equal(f.states.at(-1)?.source?.mode, 'wide'); assert.equal(f.reads.filter(r => r.purpose === 'resource-wide').length, 2); assert.equal(f.reads.some(r => r.purpose === 'resource-describe'), false); f.close();
});
test('public client read does not accept a refresh flag as an implicit initial action', async () => {
  const f = await fixture(); await f.client.read({ ...f.request, refresh: true }); assert.equal(f.states.at(-1)?.error, 'INVALID_INPUT'); assert.equal(f.calls.length, 0); f.close();
});
test('a disposed view cannot accept a late refreshed reference or overwrite another target', async () => {
  const f = await fixture(), first = await f.gateway.readInspection(f.request, signal()), deferred = Promise.withResolvers<{ status: number; body: string }>(), states: InspectionState[] = []; let calls = 0;
  const client = new InspectionClient(async () => ++calls === 1 ? { status: 200, body: JSON.stringify(first) } : deferred.promise, state => states.push(state));
  await client.read(f.request); const pending = client.refresh(); client.dispose(); const count = states.length; deferred.resolve({ status: 200, body: JSON.stringify(first) }); await pending; assert.equal(states.length, count); f.close();
});
test('refresh makes a new content identity and replaces rather than appends old printer output', async () => {
  const f = await fixture(); await f.client.read(f.request); const id = f.states.at(-1)?.page?.contentIdentity; f.version('2'); f.text('second'); await f.client.refresh();
  assert.notEqual(f.states.at(-1)?.page?.contentIdentity, id); assert.equal(f.states.at(-1)?.text, 'second'); f.close();
});
test('refresh requires an observed reference from the reader instead of trusting the stale request RV', async () => {
  const f = await fixture(), reader = createInspectionReader({ inspect: async (_t, _r, _m, project) => project('synthetic'), verifyReference: async () => {}, clusterInfo: async () => { throw new Error('unused'); }, verifyTarget: async () => {} });
  await assert.rejects(reader.read({ ...f.request, refresh: true }, signal()), /STATE_UNAVAILABLE/); reader.dispose(); f.close();
});
test('same-name replacement before refresh prevents CLI-purpose dispatch', async () => {
  const f = await fixture(); f.version('2', 'replacement'); await assert.rejects(f.gateway.readInspection({ ...f.request, refresh: true }, signal()), /STALE_TARGET/); assert.equal(f.reads.length, 1); f.close();
});
