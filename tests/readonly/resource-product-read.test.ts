import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { protocolVersion } from '../../src/shared/protocol.ts';
import { resourceReadResponseSchema } from '../../src/shared/resource-protocol.ts';
import { resourceDescriptors } from '../../src/shared/tree.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import { ResourceClient } from '../../src/host/resource-client.ts';
import type { ResourceState } from '../../src/host/resource-client.ts';

const marker = 'SYNTHETIC_SECRET_CONTENT';
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;
async function fixture() {
  let content = JSON.stringify({ 'current-context': 'active', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }],
    users: [{ name: 'u', user: { token: marker } }], contexts: [{ name: 'active', context: { cluster: 'c', user: 'u' } }] });
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content }));
  const parsed = await config.read({ mode: 'default' });
  const target = { serviceGeneration: 's', projectId: 'view:1', configIdentity: parsed.snapshot.configIdentity, context: 'active', namespace: 'default' };
  const requests: ResourceReadRequest[] = [];
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => {
    requests.push(request);
    const type = request.path.endsWith('/secrets') ? resourceDescriptors.secrets : resourceDescriptors.pods;
    const body = JSON.stringify({ apiVersion: 'v1', kind: `${type.kind}List`, metadata: { resourceVersion: '10', continue: requests.length === 1 ? 'synthetic-next' : '' },
      items: [{ apiVersion: 'v1', kind: type.kind, metadata: { name: 'sample', uid: 'uid', resourceVersion: '8', namespace: 'default', annotations: { secret: marker } },
        data: { value: Buffer.from(marker).toString('base64') }, stringData: { value: marker }, unknown: marker }] });
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(body); } }, close: async () => {} };
  } });
  const binding = { protocol: protocolVersion, selection: { mode: 'default' as const }, target, resource: 'pods' };
  return { gateway, requests, binding, setContent: (value: string) => { content = value; } };
}

test('explicit product-read protocol uses the actual gateway and projection on synthetic READ responses only', async () => {
  const { gateway, requests, binding } = await fixture();
  const states: ResourceState[] = [];
  const client = new ResourceClient(async request => {
    assert.equal(request.method, 'POST'); assert.equal(request.path, '/v2/resources/read');
    return { status: 200, body: JSON.stringify(await gateway.read(JSON.parse(request.body) as unknown, new AbortController().signal)) };
  }, state => states.push(state));
  assert.equal(requests.length, 0);
  await client.read(binding);
  assert.equal(states.at(-1)?.phase, 'ready'); assert.equal(requests.length, 1);
  assert.equal(states.at(-1)?.page?.nodes[0]?.resource.name, 'sample');
  assert.equal(JSON.stringify(states).includes(marker), false);
  assert.equal(JSON.stringify(states).includes(Buffer.from(marker).toString('base64')), false);
  client.dispose(); gateway.close();
});

test('public route schema rejects arbitrary executable/URL/filter/credential input before the injected read', async () => {
  const { gateway, requests, binding } = await fixture();
  for (const value of [{ ...binding, command: 'exec' }, { ...binding, url: 'https://evil.invalid' }, { ...binding, credentials: marker }, { ...binding, resource: 'pods/exec' }, { ...binding, protocol: 1 }]) {
    await assert.rejects(gateway.read(value, new AbortController().signal), fails('INVALID_INPUT'));
  }
  await assert.rejects(gateway.read({ ...binding, target: { ...binding.target, namespace: 'other' } }, new AbortController().signal), fails('STALE_TARGET'));
  assert.equal(requests.length, 0); gateway.close();
});

test('resource client preserves source and encrypted cursor across exact list snapshot pages without revealing Secret values', async () => {
  const { gateway, requests, binding } = await fixture(); const states: ResourceState[] = [];
  const client = new ResourceClient(async request => ({ status: 200, body: JSON.stringify(await gateway.read(JSON.parse(request.body) as unknown, new AbortController().signal)) }), state => states.push(state));
  await client.read({ ...binding, resource: 'secrets' });
  const first = states.at(-1)?.page;
  assert.ok(first?.nextCursor); assert.equal(JSON.stringify(first).includes('synthetic-next'), false);
  await client.next();
  assert.equal(states.at(-1)?.phase, 'ready'); assert.equal(states.at(-1)?.page?.nextCursor, null);
  assert.equal(requests[1]?.query.continue, 'synthetic-next');
  for (const unsafe of [marker, Buffer.from(marker).toString('base64'), 'annotations', 'stringData']) assert.equal(JSON.stringify(states).includes(unsafe), false);
  client.dispose(); gateway.close();
});

test('configuration changes before the next resource page fail stale rather than mixing targets', async () => {
  const { gateway, binding, setContent, requests } = await fixture();
  const first = await gateway.read(binding, new AbortController().signal); assert.ok(first.nextCursor);
  setContent(JSON.stringify({ 'current-context': 'other' }));
  await assert.rejects(gateway.read({ ...binding, cursor: first.nextCursor }, new AbortController().signal), fails('STALE_TARGET'));
  assert.equal(requests.length, 1); gateway.close();
});

test('reset/project change and Stop waiting both reject late UI delivery without asserting SDK proxy cancellation', async () => {
  const { gateway, binding } = await fixture();
  const page = await gateway.read(binding, new AbortController().signal);
  for (const mode of ['reset', 'cancel'] as const) {
    const states: ResourceState[] = [];
    let release: (() => void) | undefined;
    const client = new ResourceClient(async () => { await new Promise<void>(resolve => { release = resolve; }); return { status: 200, body: JSON.stringify(page) }; }, state => states.push(state));
    const pending = client.read(binding);
    if (mode === 'reset') client.reset(); else client.cancel();
    release?.(); await pending;
    assert.equal(states.at(-1)?.phase, mode === 'reset' ? 'idle' : 'error');
    if (mode === 'cancel') assert.equal(states.at(-1)?.error, 'QUERY_CANCELLED');
    assert.equal(states.at(-1)?.page, undefined); client.dispose();
  }
  gateway.close();
});

test('response Secret extensions and target/GVR/identity mismatches never become UI rows', async () => {
  const { gateway, binding } = await fixture(); const original = await gateway.read(binding, new AbortController().signal);
  const wrong = resourceReadResponseSchema.parse(original); const node = wrong.nodes[0]; assert.ok(node); node.resource.namespace = 'other';
  for (const value of [{ ...original, data: marker }, { ...original, nodes: original.nodes.map(item => ({ ...item, data: { secret: marker } })) }, wrong]) {
    const states: ResourceState[] = [];
    const client = new ResourceClient(async () => ({ status: 200, body: JSON.stringify(value) }), state => states.push(state));
    await client.read(binding); assert.equal(states.at(-1)?.phase, 'error'); assert.equal(states.at(-1)?.page, undefined);
    assert.equal(JSON.stringify(states).includes(marker), false); client.dispose();
  }
  gateway.close();
});

test('fixed CLI/auth errors retain stale rows and disable next page; raw error text is ignored', async () => {
  const { gateway, binding } = await fixture(); const page = await gateway.read(binding, new AbortController().signal);
  let calls = 0; const states: ResourceState[] = [];
  const client = new ResourceClient(async () => ++calls === 1 ? { status: 200, body: JSON.stringify(page) } : { status: 400, body: JSON.stringify({ error: { code: 'AUTHENTICATION_UNAVAILABLE' } }) }, state => states.push(state));
  await client.read(binding); await client.next();
  assert.equal(states.at(-1)?.error, 'AUTHENTICATION_UNAVAILABLE'); assert.equal(states.at(-1)?.stale, true);
  await client.next(); assert.equal(calls, 2); client.dispose(); gateway.close();
});

test('gateway close and malformed service errors do not invoke another resource read or disclose source data', async () => {
  const { gateway, binding, requests } = await fixture(); gateway.close();
  await assert.rejects(gateway.read(binding, new AbortController().signal), fails('SERVICE_CLOSED')); assert.equal(requests.length, 0);
  const states: ResourceState[] = [];
  const client = new ResourceClient(async () => ({ status: 500, body: JSON.stringify({ error: marker }) }), state => states.push(state));
  await client.read(binding); assert.equal(states.at(-1)?.error, 'STATE_UNAVAILABLE'); assert.equal(JSON.stringify(states).includes(marker), false); client.dispose();
});
