import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { hasWellFormedUnicode } from '../../src/shared/identity.ts';
import { keyContentBytes, keyContentChunkCharacters, keyReferenceFromNode } from '../../src/shared/key-content-protocol.ts';
import { KeyContentClient } from '../../src/host/key-content-client.ts';
import type { KeyContentState } from '../../src/host/key-content-client.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { createResourceReader } from '../../src/service/queries/resource-reader.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import type { ReadResponse } from '../../src/service/queries/bounded-response.ts';
import { createKeyContentReader } from '../../src/service/queries/key-content.ts';
import { validateResourceReadTransportRequest } from '../../src/service/queries/kubectl-plan.ts';

const marker = 'SYNTHETIC_EXPLICIT_SECRET_VALUE';
const signal = () => new AbortController().signal;
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;
async function fixture(resource: 'secrets' | 'configmaps' = 'secrets', initial: unknown = { value: Buffer.from(marker).toString('base64') }) {
  let data: unknown = initial, uid = 'parent-uid', rv = '10', content = JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] });
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content })), readConfig = await config.read({ mode: 'default' });
  const target = { serviceGeneration: 's', projectId: 'view', configIdentity: readConfig.snapshot.configIdentity, context: 'active', namespace: 'default' };
  const reference = { parent: { resource, name: 'sample', namespace: 'default', uid, resourceVersion: rv }, key: 'value' };
  const binding = { protocol: 2 as const, selection: { mode: 'default' as const }, target, reference };
  const requests: ResourceReadRequest[] = [];
  let wait: (() => Promise<void>) | undefined;
  let response: (() => ReadResponse) | undefined;
  function object() { return { apiVersion: 'v1', kind: resource === 'secrets' ? 'Secret' : 'ConfigMap', metadata: { name: 'sample', namespace: 'default', uid, resourceVersion: rv, annotations: { private: marker } }, data, stringData: { private: marker }, unknown: marker }; }
  const read = async (request: ResourceReadRequest) => {
    validateResourceReadTransportRequest(request); requests.push(request); await wait?.();
    if (response) return response();
    const value = request.purpose === 'resource-list' ? { apiVersion: 'v1', kind: `${object().kind}List`, metadata: { resourceVersion: '30' }, items: [object()] } : object();
    const body = JSON.stringify(value);
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(body); } }, close: async () => {} };
  };
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: (_selection, request) => read(request) });
  const states: KeyContentState[] = [];
  const transport = async (request: { method: 'POST'; path: string; body: string }) => {
    assert.equal(request.path, '/v2/keys/read'); assert.equal(request.body.includes(marker), false);
    try { return { status: 200, body: JSON.stringify(await gateway.readKey(JSON.parse(request.body) as unknown, signal())) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  };
  const client = new KeyContentClient(transport, state => states.push(state));
  return { binding, gateway, client, states, requests, read, transport, object,
    data: (value: unknown) => { data = value; }, identity: (newUid: string, newRv: string) => { uid = newUid; rv = newRv; },
    config: () => { content = JSON.stringify({ 'current-context': 'other' }); }, wait: (value: (() => Promise<void>) | undefined) => { wait = value; },
    response: (value: () => ReadResponse) => { response = value; },
    close: () => { client.dispose(); gateway.close(); } };
}

test('only explicit key-content path returns a decoded Secret value; list/branch DTOs still contain no values', async () => {
  const f = await fixture(); assert.equal(f.requests.length, 0);
  const list = await f.gateway.read({ ...f.binding, reference: undefined, resource: 'secrets' }, signal()).catch(() => undefined);
  assert.equal(list, undefined); // Public resource schema rejects unrelated input; no accidental content mode.
  const base = { protocol: 2, selection: f.binding.selection, target: f.binding.target };
  const resources = await f.gateway.read({ ...base, resource: 'secrets' }, signal());
  const branches = await f.gateway.readTree({ ...base, kind: 'children', parent: f.binding.reference.parent }, signal());
  for (const value of [resources, branches]) for (const unsafe of [marker, Buffer.from(marker).toString('base64'), 'stringData']) assert.equal(JSON.stringify(value).includes(unsafe), false);
  await f.client.read(f.binding); assert.equal(f.states.at(-1)?.phase, 'ready'); assert.equal(f.states.at(-1)?.text, marker); assert.equal(f.states.at(-1)?.complete, true);
  assert.equal(f.states.at(-1)?.encoding, 'utf8'); f.client.reset(); assert.equal(f.states.at(-1)?.text, ''); f.close();
});

test('ConfigMap UTF-8, BOM, line endings, XML/script-looking text and astral code points are preserved as inert text', async () => {
  const text = '\ufeff<script>synthetic()</script>\r\n中文🎉\t'; const f = await fixture('configmaps', { value: text });
  await f.client.read(f.binding); assert.equal(f.states.at(-1)?.text, text); assert.equal(f.states.at(-1)?.totalBytes, Buffer.byteLength(text)); assert.equal(f.states.at(-1)?.encoding, 'utf8'); f.close();
});

test('binary/non-UTF8/control-bearing bytes are displayed losslessly as base64 rather than replacement text', async () => {
  for (const bytes of [Buffer.from([0xff, 0xfe, 0, 255]), Buffer.from('plain\0control'), Buffer.from('\u001b[31m')]) {
    const f = await fixture('secrets', { value: bytes.toString('base64') }); await f.client.read(f.binding);
    assert.equal(f.states.at(-1)?.phase, 'ready'); assert.equal(f.states.at(-1)?.encoding, 'base64'); assert.equal(f.states.at(-1)?.text, bytes.toString('base64'));
    assert.equal(f.states.at(-1)?.totalBytes, bytes.byteLength); f.close();
  }
});

test('empty values are complete valid content; absent data or absent keys are NOT_FOUND, not empty success', async () => {
  for (const resource of ['secrets', 'configmaps'] as const) {
    const f = await fixture(resource, { value: '' }); await f.client.read(f.binding); assert.equal(f.states.at(-1)?.phase, 'ready'); assert.equal(f.states.at(-1)?.complete, true); assert.equal(f.states.at(-1)?.text, '');
    for (const value of [undefined, null, {}, { different: '' }]) { f.data(value); await assert.rejects(f.gateway.readKey(f.binding, signal()), fails('NOT_FOUND')); }
    f.close();
  }
});

test('prototype-like own keys work without reading Object.prototype or exposing unrelated keys', async () => {
  const f = await fixture('configmaps', JSON.parse(`{"__proto__":"${marker}","toString":"own-value"}`) as unknown);
  const page = await f.gateway.readKey({ ...f.binding, reference: { ...f.binding.reference, key: '__proto__' } }, signal()); assert.equal(page.text, marker);
  f.data({}); await assert.rejects(f.gateway.readKey({ ...f.binding, reference: { ...f.binding.reference, key: 'toString' } }, signal()), fails('NOT_FOUND')); f.close();
});

test('invalid base64, padding and pad bits are fixed CONTENT_INVALID, never permissively decoded or echoed', async () => {
  const f = await fixture();
  for (const value of ['a', 'Zg=', 'Zh==', 'Zm9=', '!bad', ' Zg==', 'Zg==\n', '====', 'Zg===']) {
    f.data({ value }); await assert.rejects(f.gateway.readKey(f.binding, signal()), fails('CONTENT_INVALID'));
  }
  f.close();
});

test('invalid data types and lone surrogates fail without weakening the ES2022 shared/browser target', async () => {
  const f = await fixture('configmaps');
  for (const value of [null, {}, [], 1, false, '\ud800', '\udc00']) { f.data({ value }); await assert.rejects(f.gateway.readKey(f.binding, signal()), fails('CONTENT_INVALID')); }
  assert.equal(hasWellFormedUnicode('🎉'), true); assert.equal(hasWellFormedUnicode('\ud800'), false); assert.equal(hasWellFormedUnicode('\udc00'), false); f.close();
});

test('chunk paging is explicit, never splits surrogate pairs, marks partial content and assembles exact bytes', async () => {
  const text = 'a'.repeat(keyContentChunkCharacters - 1) + '🎉中文' + 'end'; const f = await fixture('configmaps', { value: text });
  await f.client.read(f.binding); assert.equal(f.states.at(-1)?.complete, false); assert.equal(f.states.at(-1)?.text.length, keyContentChunkCharacters - 1); assert.equal(f.requests.length, 1);
  await f.client.next(); assert.equal(f.states.at(-1)?.complete, true); assert.equal(f.states.at(-1)?.text, text); assert.equal(f.requests.length, 2); f.close();
});

test('binary pages preserve canonical base64 across boundaries and decoded byte length', async () => {
  const bytes = Buffer.alloc(70_001, 255), text = bytes.toString('base64'), f = await fixture('secrets', { value: text });
  await f.client.read(f.binding); assert.equal(f.states.at(-1)?.complete, false); await f.client.next(); assert.equal(f.states.at(-1)?.complete, true);
  assert.equal(f.states.at(-1)?.text, text); assert.equal(f.states.at(-1)?.totalBytes, bytes.byteLength); f.close();
});

test('selected decoded key size is capped at 1MiB, with exact-boundary values supported and over-limit data rejected', async () => {
  const f = await fixture('secrets', { value: Buffer.alloc(keyContentBytes, 255).toString('base64') });
  const first = await f.gateway.readKey(f.binding, signal()); assert.equal(first.totalBytes, keyContentBytes); assert.ok(first.nextCursor);
  f.data({ value: Buffer.alloc(keyContentBytes + 1, 255).toString('base64') }); await assert.rejects(f.gateway.readKey(f.binding, signal()), fails('BUDGET_EXCEEDED'));
  f.close();
});

test('complete 1MiB binary content is assembled in twenty-two explicit chunks with exact canonical bytes', async () => {
  const text = Buffer.alloc(keyContentBytes, 255).toString('base64'), f = await fixture('secrets', { value: text });
  await f.client.read(f.binding);
  for (let page = 1; page < 22; page++) { assert.equal(f.states.at(-1)?.phase, 'ready'); assert.equal(f.states.at(-1)?.complete, false); await f.client.next(); }
  assert.equal(f.states.at(-1)?.complete, true); assert.equal(f.states.at(-1)?.text, text); assert.equal(f.requests.length, 22); f.close();
});

test('key GET error bodies are never iterated and whole-object byte budgets apply even to a tiny selected key', async () => {
  const f = await fixture(); let iterated = 0, closed = 0;
  for (const [status, code] of [[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [410, 'CONTINUATION_EXPIRED']] as const) {
    f.response(() => ({ status, body: { async *[Symbol.asyncIterator]() { iterated++; yield Buffer.from(marker); } }, close: async () => { closed++; } }));
    await assert.rejects(f.gateway.readKey(f.binding, signal()), fails(code));
  }
  assert.equal(iterated, 0); assert.equal(closed, 4);
  f.response(() => ({ status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ ...f.object(), unrelated: 'x'.repeat(2_000_000) })); } }, close: async () => { closed++; } }));
  await assert.rejects(f.gateway.readKey(f.binding, signal()), fails('BUDGET_EXCEEDED')); assert.equal(closed, 5); f.close();
});

test('a chunk finishing at its fixed deadline and a configuration change during GET are rejected after the read', async () => {
  const f = await fixture('configmaps', { value: 'a'.repeat(140_000) }); let clock = 0;
  const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => target, read: f.read });
  const pager = createKeyContentReader(reader, () => clock), first = await pager.read(f.binding, signal());
  f.wait(async () => { clock = 60_000; });
  await assert.rejects(pager.read({ ...f.binding, cursor: first.nextCursor }, signal()), fails('CONTINUATION_EXPIRED'));
  f.wait(async () => { f.config(); });
  await assert.rejects(f.gateway.readKey(f.binding, signal()), fails('STALE_TARGET'));
  pager.dispose(); reader.close(); f.close();
});

test('cross-namespace keys are rejected before GET; closed and pre-cancelled gateways never read', async () => {
  const f = await fixture();
  await assert.rejects(f.gateway.readKey({ ...f.binding, reference: { ...f.binding.reference, parent: { ...f.binding.reference.parent, namespace: 'other' } } }, signal()), fails('STALE_TARGET'));
  const abort = new AbortController(); abort.abort(); await assert.rejects(f.gateway.readKey(f.binding, abort.signal), fails('QUERY_CANCELLED'));
  f.close(); await assert.rejects(f.gateway.readKey(f.binding, signal()), fails('SERVICE_CLOSED')); assert.equal(f.requests.length, 0);
});

test('duplicate key consumers share only the in-flight read and cancelling one leaves its peer alive', async () => {
  const f = await fixture(); let release: (() => void) | undefined, start: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { start = resolve; });
  f.wait(async () => { start?.(); await gate; }); const abort = new AbortController();
  const cancelled = f.gateway.readKey(f.binding, abort.signal).catch(error => error instanceof BoundaryError ? error.code : 'unexpected');
  await started; const peer = f.gateway.readKey(f.binding, signal()); abort.abort(); assert.equal(await cancelled, 'QUERY_CANCELLED');
  release?.(); assert.equal((await peer).text, marker); assert.equal(f.requests.length, 1);
  await f.gateway.readKey(f.binding, signal()); assert.equal(f.requests.length, 2); f.close();
});

test('client rejects replayed offsets, changed identities and repeated older cursors without appending a bad page', async () => {
  const f = await fixture('configmaps', { value: 'a'.repeat(220_000) });
  const first = await f.gateway.readKey(f.binding, signal()), second = await f.gateway.readKey({ ...f.binding, cursor: first.nextCursor }, signal());
  const third = await f.gateway.readKey({ ...f.binding, cursor: second.nextCursor }, signal());
  for (const bad of [{ ...second, offset: 0 }, { ...second, contentIdentity: '0'.repeat(64) }, { ...second, nextCursor: first.nextCursor }]) {
    let calls = 0; const states: KeyContentState[] = [], client = new KeyContentClient(async () => ({ status: 200, body: JSON.stringify(++calls === 1 ? first : bad) }), state => states.push(state));
    await client.read(f.binding); await client.next(); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.text, first.text); client.dispose();
  }
  let calls = 0; const states: KeyContentState[] = [], pages = [first, second, { ...third, nextCursor: first.nextCursor }];
  const client = new KeyContentClient(async () => ({ status: 200, body: JSON.stringify(pages[calls++]) }), state => states.push(state));
  await client.read(f.binding); await client.next(); await client.next(); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.text, first.text + second.text);
  client.dispose(); f.close();
});

test('client validates canonical binary pad bits and response size and clears when switching keys or targets', async () => {
  const f = await fixture(), original = await f.gateway.readKey(f.binding, signal());
  for (const [text, bytes] of [['Zh==', 1], ['Zm9=', 2], ['====', 1], ['Zg==', 2]] as const) {
    const states: KeyContentState[] = [], client = new KeyContentClient(async () => ({ status: 200, body: JSON.stringify({ ...original, encoding: 'base64', text, totalBytes: bytes, totalCharacters: text.length, end: text.length }) }), state => states.push(state));
    await client.read(f.binding); assert.equal(states.at(-1)?.error, 'CONTENT_INVALID'); assert.equal(states.at(-1)?.text, ''); client.dispose();
  }
  const states: KeyContentState[] = []; let oversized = false;
  const client = new KeyContentClient(async request => oversized ? { status: 200, body: 'x'.repeat(512_001) } : f.transport(request), state => states.push(state));
  await client.read(f.binding); assert.equal(states.at(-1)?.text, marker); oversized = true;
  await client.read({ ...f.binding, target: { ...f.binding.target, serviceGeneration: 'other' } }); assert.equal(states.at(-1)?.error, 'BUDGET_EXCEEDED'); assert.equal(states.at(-1)?.text, '');
  oversized = false; await client.read(f.binding); await client.read({ ...f.binding, reference: { ...f.binding.reference, key: 'absent' } });
  assert.equal(states.at(-1)?.error, 'NOT_FOUND'); assert.equal(states.at(-1)?.text, ''); client.dispose(); f.close();
});

test('sealed cursors bind key/parent/namespace/target and do not expose content or offset as public input', async () => {
  const f = await fixture('configmaps', { value: marker.repeat(4000), other: 'other' });
  const page = await f.gateway.readKey(f.binding, signal()); assert.ok(page.nextCursor); assert.equal(page.nextCursor.includes(marker), false); const count = f.requests.length;
  for (const change of [{ cursor: `${page.nextCursor}x` }, { cursor: 'bad' }, { cursor: page.nextCursor, reference: { ...f.binding.reference, key: 'other' } }, { cursor: page.nextCursor, reference: { ...f.binding.reference, parent: { ...f.binding.reference.parent, uid: 'new' } } }]) {
    await assert.rejects(f.gateway.readKey({ ...f.binding, ...change }, signal()), fails('STALE_TARGET'));
  }
  assert.equal(f.requests.length, count); await assert.rejects(f.gateway.readKey({ ...f.binding, offset: 1 }, signal()), fails('INVALID_INPUT')); f.close();
});

test('every continued chunk rechecks parent UID/RV and a keyed content identity, including same-RV body mutation', async () => {
  for (const change of ['uid', 'rv', 'content'] as const) {
    const f = await fixture('configmaps', { value: 'a'.repeat(70_000) }); const first = await f.gateway.readKey(f.binding, signal()); assert.ok(first.nextCursor);
    if (change === 'uid') f.identity('new', '10'); else if (change === 'rv') f.identity('parent-uid', '11'); else f.data({ value: 'b'.repeat(70_000) });
    await assert.rejects(f.gateway.readKey({ ...f.binding, cursor: first.nextCursor }, signal()), fails('STALE_TARGET')); assert.equal(f.requests.length, 2); f.close();
  }
});

test('cursor lifetime is fixed at sixty seconds, with no reads after expiry or across reader instances', async () => {
  const f = await fixture('configmaps', { value: 'a'.repeat(70_000) });
  const reader = createResourceReader({ serviceGeneration: 's', currentTarget: async target => target, read: f.read }); let clock = 0;
  const pager = createKeyContentReader(reader, () => clock), other = createKeyContentReader(reader, () => clock);
  const first = await pager.read(f.binding, signal()); assert.ok(first.nextCursor);
  await assert.rejects(other.read({ ...f.binding, cursor: first.nextCursor }, signal()), fails('STALE_TARGET'));
  clock = 60_000; await assert.rejects(pager.read({ ...f.binding, cursor: first.nextCursor }, signal()), fails('CONTINUATION_EXPIRED')); assert.equal(f.requests.length, 1);
  pager.dispose(); other.dispose(); reader.close(); f.close();
});

test('changed configuration fails before reading content and arbitrary resource/URL/command input never starts a read', async () => {
  const f = await fixture();
  for (const input of [{ ...f.binding, url: 'https://synthetic.invalid' }, { ...f.binding, command: 'exec' }, { ...f.binding, data: marker }, { ...f.binding, reference: { ...f.binding.reference, parent: { ...f.binding.reference.parent, resource: 'pods' } } }]) await assert.rejects(f.gateway.readKey(input, signal()), fails('INVALID_INPUT'));
  assert.equal(f.requests.length, 0); f.config(); await assert.rejects(f.gateway.readKey(f.binding, signal()), fails('STALE_TARGET')); assert.equal(f.requests.length, 0); f.close();
});

test('ConfigMap binaryData and Secret stringData do not silently replace a missing data key', async () => {
  const f = await fixture('configmaps', {}); await assert.rejects(f.gateway.readKey(f.binding, signal()), fails('NOT_FOUND')); f.close();
});

test('key client rejects wrong target/reference, sensitive extensions and offset/encoding/byte inconsistencies before display', async () => {
  const f = await fixture(); const original = await f.gateway.readKey(f.binding, signal());
  for (const value of [{ ...original, target: { ...original.target, projectId: 'other' } }, { ...original, reference: { ...original.reference, key: 'other' } },
    { ...original, data: marker }, { ...original, offset: 1 }, { ...original, totalBytes: 0 }, { ...original, encoding: 'utf8', text: '\0', totalCharacters: 1, end: 1 }, { ...original, text: '\ud800' }]) {
    const states: KeyContentState[] = [], client = new KeyContentClient(async () => ({ status: 200, body: JSON.stringify(value) }), state => states.push(state));
    await client.read(f.binding); assert.equal(states.at(-1)?.phase, 'error'); assert.equal(states.at(-1)?.text, ''); client.dispose();
  }
  f.close();
});

test('late reset/cancel/dispose deliveries cannot reveal an old Secret, and clear releases the current display value', async () => {
  const f = await fixture(), page = await f.gateway.readKey(f.binding, signal());
  for (const action of ['reset', 'cancel', 'dispose'] as const) {
    let release: (() => void) | undefined; const states: KeyContentState[] = [];
    const client = new KeyContentClient(async () => { await new Promise<void>(resolve => { release = resolve; }); return { status: 200, body: JSON.stringify(page) }; }, state => states.push(state));
    const pending = client.read(f.binding); client[action](); release?.(); await pending;
    assert.equal(states.some(state => state.text.includes(marker)), false); client.dispose();
  }
  await f.client.read(f.binding); f.client.reset(); assert.equal(f.states.at(-1)?.text, ''); assert.equal(f.states.at(-1)?.reference, undefined); f.close();
});

test('fixed read errors retain explicitly stale partial content and disable implicit paging/retries', async () => {
  const f = await fixture('configmaps', { value: 'a'.repeat(70_000) }); let calls = 0; const states: KeyContentState[] = [];
  const client = new KeyContentClient(async request => ++calls === 1 ? f.transport(request) : { status: 403, body: JSON.stringify({ error: { code: 'FORBIDDEN' } }) }, state => states.push(state));
  await client.read(f.binding); await client.next(); assert.equal(states.at(-1)?.error, 'FORBIDDEN'); assert.equal(states.at(-1)?.stale, true); assert.equal(states.at(-1)?.complete, false);
  await client.next(); assert.equal(calls, 2); client.dispose(); f.close();
});

test('client admission retains four cancelled SDK calls until actual settlement, without exposing raw errors', async () => {
  const f = await fixture(), releases: (() => void)[] = [], states: KeyContentState[] = [];
  const client = new KeyContentClient(async () => { await new Promise<void>(resolve => { releases.push(resolve); }); return { status: 500, body: marker }; }, state => states.push(state));
  const pending: Promise<void>[] = [];
  for (let index = 0; index < 4; index++) { pending.push(client.read(f.binding)); client.cancel(); }
  await client.read(f.binding); assert.equal(states.at(-1)?.error, 'QUERY_LIMIT'); assert.equal(releases.length, 4);
  for (const release of releases) release(); await Promise.all(pending); assert.equal(states.at(-1)?.text, ''); assert.equal(JSON.stringify(states).includes(marker), false); client.dispose(); f.close();
});

test('only stable builtin key nodes produce content references; custom GVR or missing identity is not promoted', async () => {
  const f = await fixture(); const page = await f.gateway.readTree({ protocol: 2, selection: f.binding.selection, target: f.binding.target, kind: 'children', parent: f.binding.reference.parent }, signal());
  const node = page.nodes[0]; assert.ok(node?.type === 'config-key'); assert.ok(keyReferenceFromNode(node));
  assert.equal(keyReferenceFromNode({ ...node, resource: { ...node.resource, group: 'custom.test' } }), null);
  assert.equal(keyReferenceFromNode({ ...node, resource: { ...node.resource, uid: undefined } }), null); f.close();
});

test('key and resource reads share the existing global pool of two rather than creating an extra CLI scheduler', async () => {
  const f = await fixture(); let release: (() => void) | undefined, started: (() => void) | undefined, active = 0, maximum = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), two = new Promise<void>(resolve => { started = resolve; });
  f.wait(async () => { active++; maximum = Math.max(maximum, active); if (active === 2) started?.(); await gate; active--; });
  const a = f.gateway.readKey(f.binding, signal()), b = f.gateway.read({ protocol: 2, selection: f.binding.selection, target: f.binding.target, resource: 'secrets' }, signal());
  const c = f.gateway.readKey({ ...f.binding, reference: { ...f.binding.reference, key: 'absent' } }, signal()).catch(error => error instanceof BoundaryError ? error.code : 'unexpected');
  await two; assert.equal(f.requests.length, 2); release?.(); await Promise.all([a, b]); assert.equal(await c, 'NOT_FOUND'); assert.equal(maximum, 2); f.close();
});
