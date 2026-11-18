import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigurationClient } from '../../src/host/configuration-client.ts';
import type { ConfigurationState } from '../../src/host/configuration-client.ts';
import type { ConfigSelection } from '../../src/shared/configuration.ts';
import { protocolVersion } from '../../src/shared/protocol.ts';
import { parseConfigReadRequest } from '../../src/service/queries/config-request.ts';

type Response = { status: number; body: string };
type Request = { method: 'GET' | 'POST'; path: string; body?: string };
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function health(generation = 'service-a'): Response {
  return { status: 200, body: JSON.stringify({ protocol: protocolVersion, status: 'ready', serviceGeneration: generation, version: '0.1.0', compatibility: '2.5.1' }) };
}
function page(mode: ConfigSelection['mode'] = 'default', offset = 0, total = 2, generation = 'service-a', identity = 'config-a'): Response {
  const count = Math.min(100, total - offset);
  return { status: 200, body: JSON.stringify({ protocol: protocolVersion, serviceGeneration: generation, configIdentity: identity,
    status: 'ready', sources: { mode, selectedCount: 1, loadedCount: 1, missingCount: 0 }, total, nextOffset: offset + count < total ? offset + count : null, currentContextMissing: false, currentContext: 'context-0',
    currentContextInfo: { name: 'context-0', namespace: 'default', available: true },
    contexts: Array.from({ length: count }, (_, index) => ({ name: `context-${offset + index}`, clusterName: 'cluster', namespace: 'default', active: offset + index === 0, available: true,
      authentication: { methods: ['anonymous'], externalExecution: false, referencedFiles: false, mayUpdateCredentials: false, proxyConfigured: false, evaluated: false } })),
  }) };
}

test('configuration view is inert until requested and uses only approved health/POST-read transport', async () => {
  const requests: Request[] = [], states: ConfigurationState[] = [];
  const client = new ConfigurationClient(async request => {
    requests.push(request);
    if (request.method === 'GET') { assert.equal(request.path, '/health'); return health(); }
    assert.equal(request.path, '/v2/configuration/read');
    const parsed = parseConfigReadRequest(request.body ?? '');
    return page(parsed.selection.mode);
  }, state => states.push(state));
  assert.equal(requests.length, 0);
  assert.equal(client.project('/synthetic/project-a'), true);
  assert.equal(client.project('/synthetic/project-a'), false);
  await client.select({ mode: 'file', path: '/synthetic/a.yaml' });
  assert.equal(states.at(-1)?.phase, 'ready');
  assert.equal(states.at(-1)?.config?.sources.mode, 'file');
  assert.equal(requests[1]?.path.includes('/synthetic'), false, 'paths go in bounded request body, never URL');
  client.dispose();
});

test('configuration view paging sends the same selection and configuration identity, not a mutable global source', async () => {
  const requests: ReturnType<typeof parseConfigReadRequest>[] = [], states: ConfigurationState[] = [];
  const client = new ConfigurationClient(async request => {
    if (request.method === 'GET') return health();
    const parsed = parseConfigReadRequest(request.body ?? ''); requests.push(parsed);
    return page(parsed.selection.mode, parsed.page.offset, 201);
  }, state => states.push(state));
  await client.select({ mode: 'merge', paths: ['/synthetic/a', '/synthetic/b'] });
  await client.next(); await client.next(); await client.next();
  assert.deepEqual(requests.map(request => request.page.offset), [0, 100, 200]);
  assert.equal(requests[1]?.page.configIdentity, 'config-a');
  assert.deepEqual(requests[1]?.selection, requests[0]?.selection);
  assert.equal(states.at(-1)?.config?.contexts[0]?.name, 'context-200');
  assert.equal(states.at(-1)?.config?.nextOffset, null);
  client.dispose();
});

test('project/source switch rejects late read responses and resets to the new project default selection', async () => {
  const pending = Promise.withResolvers<Response>();
  const states: ConfigurationState[] = [], modes: string[] = [];
  const client = new ConfigurationClient(async request => {
    if (request.method === 'GET') return health();
    const parsed = parseConfigReadRequest(request.body ?? ''); modes.push(parsed.selection.mode);
    return modes.length === 1 ? pending.promise : page(parsed.selection.mode, 0, 2, 'service-a', 'new-config');
  }, state => states.push(state));
  client.project('/synthetic/first');
  const old = client.select({ mode: 'file', path: '/synthetic/old.yaml' });
  await flush();
  client.project('/synthetic/second');
  await client.reload();
  pending.resolve(page('file', 0, 2, 'service-a', 'old-config'));
  await old;
  assert.deepEqual(modes, ['file', 'default']);
  assert.equal(states.at(-1)?.config?.configIdentity, 'new-config');
  assert.equal(states.some(state => state.config?.configIdentity === 'old-config'), false);
  client.dispose();
});

test('service restart between pages fails stale without submitting an old continuation to the new generation', async () => {
  let generation = 'service-a', posts = 0;
  const states: ConfigurationState[] = [];
  const client = new ConfigurationClient(async request => {
    if (request.method === 'GET') return health(generation);
    posts++;
    return page('default', 0, 101, generation, `${generation}-config`);
  }, state => states.push(state));
  await client.reload(); generation = 'service-b'; await client.next();
  assert.equal(posts, 1);
  assert.equal(states.at(-1)?.error, 'STALE_TARGET');
  assert.equal(states.at(-1)?.stale, true);
  await client.next();
  assert.equal(posts, 1, 'stale pages require an explicit restart, not automatic continuation');
  await client.reload();
  assert.equal(states.at(-1)?.phase, 'ready');
  assert.equal(states.at(-1)?.config?.serviceGeneration, 'service-b');
  client.dispose();
});

test('fixed server errors preserve stale diagnostics; untrusted response bodies never become display errors', async () => {
  const states: ConfigurationState[] = [];
  let response = page();
  const client = new ConfigurationClient(async request => request.method === 'GET' ? health() : response, state => states.push(state));
  await client.reload();
  response = { status: 409, body: JSON.stringify({ error: { code: 'STALE_TARGET' } }) };
  await client.reload();
  assert.equal(states.at(-1)?.error, 'STALE_TARGET');
  assert.equal(states.at(-1)?.stale, true);
  await client.select({ mode: 'default' });
  assert.equal(states.at(-1)?.stale, true, 'explicit re-read of the same selection must retain visibly stale diagnostics');
  response = { status: 400, body: JSON.stringify({ error: { code: 'CONFIG_INVALID', message: 'SYNTHETIC_SECRET' } }) };
  await client.reload();
  assert.equal(states.at(-1)?.error, 'STATE_UNAVAILABLE');
  assert.equal(JSON.stringify(states).includes('SYNTHETIC_SECRET'), false);
  client.dispose();
});

test('invalid response generations, selection modes, protocols and page bounds are rejected', async () => {
  for (const response of [page('default', 0, 2, 'wrong-service'), page('file'),
    { status: 200, body: JSON.stringify({ protocol: 1 }) }, { status: 200, body: 'SYNTHETIC_SECRET_NOT_JSON' }]) {
    const states: ConfigurationState[] = [];
    const client = new ConfigurationClient(async request => request.method === 'GET' ? health() : response, state => states.push(state));
    await client.reload(); assert.equal(states.at(-1)?.phase, 'error');
    assert.equal(states.at(-1)?.config, undefined);
    client.dispose();
  }
  const invalid: unknown = JSON.parse(page('default', 0, 101).body);
  assert.ok(typeof invalid === 'object' && invalid !== null);
  const states: ConfigurationState[] = [];
  const client = new ConfigurationClient(async request => request.method === 'GET' ? health() : { status: 200, body: JSON.stringify({ ...invalid, nextOffset: 99 }) }, state => states.push(state));
  await client.reload(); assert.equal(states.at(-1)?.error, 'STATE_UNAVAILABLE');
  client.dispose();
});

test('Stop waiting and dispose invalidate UI delivery without claiming that the host proxy was cancelled', async () => {
  const pending = Promise.withResolvers<Response>(), states: ConfigurationState[] = [];
  let posts = 0;
  const client = new ConfigurationClient(async request => { if (request.method === 'GET') return pending.promise; posts++; return page(); }, state => states.push(state));
  const reading = client.reload(); client.cancel();
  assert.equal(states.at(-1)?.error, 'QUERY_CANCELLED');
  const count = states.length;
  pending.resolve(health()); await reading;
  assert.equal(posts, 0); assert.equal(states.length, count);
  client.dispose(); await client.reload(); await client.select({ mode: 'file', path: '/synthetic/a' });
  assert.equal(states.length, count);
});

test('read-only view boundary rejects oversized request/response bodies without displaying source text', async () => {
  const states: ConfigurationState[] = [];
  const client = new ConfigurationClient(async request => request.method === 'GET' ? health() : { status: 200, body: 'x'.repeat(512_001) }, state => states.push(state));
  await client.reload(); assert.equal(states.at(-1)?.error, 'BUDGET_EXCEEDED');
  assert.equal(states.at(-1)?.config, undefined);
  client.dispose();
});
