// Synthetic configuration/DTO/client only. No SDK, bridge, actual filesystem/authentication or write handlers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigurationClient } from '../../src/host/configuration-client.ts';
import type { ConfigurationState } from '../../src/host/configuration-client.ts';
import { configurationReadTarget, configPageSchema } from '../../src/shared/protocol.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { projectConfigPage } from '../../src/service/queries/config-page.ts';
import { projectContextChoices } from '../../src/service/queries/context-choices.ts';
import { ContextChoiceClient } from '../../src/host/context-choice-client.ts';
import type { ContextChoiceState } from '../../src/host/context-choice-client.ts';

async function fixture(current = 'context-200', available = true) {
  let changed = false;
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': current,
    clusters: [{ name: 'cluster', cluster: { server: changed ? 'https://changed.invalid' : 'https://synthetic.invalid' } }],
    users: [{ name: 'user', user: { token: 'SYNTHETIC_CREDENTIAL' } }], contexts: Array.from({ length: 201 }, (_, n) => ({ name: `context-${String(n).padStart(3, '0')}`,
      context: { cluster: available ? 'cluster' : 'missing', user: 'user', namespace: n === 200 ? 'team' : 'default' } })) }) }));
  const snapshot = await config.read({ mode: 'default' });
  return { snapshot, config, change: () => { changed = true; }, page: (offset = 0) => projectConfigPage(snapshot, 's', { offset, limit: 100 }),
    transport: async (request: { method: 'GET' | 'POST'; path: string; body?: string }) => {
      if (request.method === 'GET') return { status: 200, body: JSON.stringify({ protocol: 2, serviceGeneration: 's', status: 'ready', version: '0.1.0', compatibility: '2.5.1' }) };
      assert.equal(request.path, '/v2/configuration/read');
      const body = JSON.parse(request.body ?? '{}') as { page: { offset: number; limit: number; configIdentity?: string } };
      return { status: 200, body: JSON.stringify(projectConfigPage(snapshot, 's', body.page)) };
    } };
}

test('global current-context metadata is projected before pagination even when the active row is off-page', async () => {
  const f = await fixture(), page = f.page(); assert.equal(page.contexts.some(c => c.active), false);
  assert.deepEqual(page.currentContextInfo, { name: 'context-200', namespace: 'team', available: true, authentication: f.snapshot.snapshot.contexts.find(context => context.active)?.authentication });
});
test('all pages yield the same read target instead of falling back to a visible inactive row or default namespace', async () => {
  const f = await fixture(), first = configurationReadTarget(f.page(), 'view'); assert.ok(first);
  for (const offset of [100, 200]) assert.deepEqual(configurationReadTarget(f.page(offset), 'view'), first);
  assert.equal(first.context, 'context-200'); assert.equal(first.namespace, 'team');
});
test('unavailable current context is disclosed but never becomes an available read target', async () => {
  const f = await fixture('context-200', false), page = f.page(); assert.equal(page.currentContextInfo?.available, false); assert.equal(configurationReadTarget(page, 'view'), undefined);
});
test('missing current stanza has a null summary and does not borrow the first available context', async () => {
  const f = await fixture('absent'), page = f.page(); assert.equal(page.currentContextMissing, true); assert.equal(page.currentContextInfo, null); assert.equal(configurationReadTarget(page, 'view'), undefined);
});
test('empty current-context and completely missing source both have no read target', async () => {
  const f = await fixture(''); assert.equal(f.page().currentContextInfo, null); assert.equal(configurationReadTarget(f.page(), 'view'), undefined);
  const config = createConfigReader('/synthetic/absent', async () => null), page = projectConfigPage(await config.read({ mode: 'default' }), 's', { offset: 0, limit: 100 });
  assert.equal(page.currentContextInfo, null); assert.equal(configurationReadTarget(page, 'view'), undefined);
});
test('strict public page rejects an old response missing the global summary instead of guessing from page rows', async () => {
  const f = await fixture(), { currentContextInfo: _summary, ...old } = f.page(); assert.equal(configPageSchema.safeParse(old).success, false);
});
test('current summary must agree with global name and any active row namespace/availability', async () => {
  const f = await fixture(), page = f.page(200);
  for (const summary of [null, { name: 'context-000', namespace: 'team', available: true }, { name: 'context-200', namespace: 'other', available: true }, { name: 'context-200', namespace: 'team', available: false }]) assert.equal(configPageSchema.safeParse({ ...page, currentContextInfo: summary }).success, false);
});
test('configuration client exposes a usable off-page current target on every page without an extra query or auto-switch', async () => {
  const f = await fixture(), states: ConfigurationState[] = [], client = new ConfigurationClient(f.transport, state => states.push(state));
  await client.reload(); assert.equal(configurationReadTarget(states.at(-1)?.config, 'view')?.namespace, 'team');
  await client.next(); await client.next(); assert.equal(states.at(-1)?.phase, 'ready'); assert.equal(configurationReadTarget(states.at(-1)?.config, 'view')?.context, 'context-200'); client.dispose();
});
test('same-identity continuation rejects changed off-page current summary and retains old metadata only as stale', async () => {
  const f = await fixture(), states: ConfigurationState[] = []; let posts = 0;
  const client = new ConfigurationClient(async request => {
    const response = await f.transport(request); if (request.method === 'POST' && ++posts === 2) {
      const page = JSON.parse(response.body) as ReturnType<typeof f.page>; return { ...response, body: JSON.stringify({ ...page, currentContextInfo: { ...page.currentContextInfo, available: false } }) };
    } return response;
  }, state => states.push(state));
  await client.reload(); await client.next(); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(states.at(-1)?.stale, true); client.dispose();
});
test('current-context summary includes only auth disclosure, never credentials, endpoint or source paths', async () => {
  const f = await fixture(), summary = f.page().currentContextInfo; assert.ok(summary); assert.deepEqual(Object.keys(summary).sort(), ['authentication', 'available', 'name', 'namespace']);
  assert.equal(JSON.stringify(f.page()).includes('SYNTHETIC_CREDENTIAL'), false); assert.equal(JSON.stringify(summary).includes('synthetic.invalid'), false);
  assert.equal(configPageSchema.safeParse({ ...f.page(), currentContextInfo: { ...summary, token: 'SYNTHETIC_CREDENTIAL' } }).success, false);
});
test('global read target uses the new configuration identity after source content changes', async () => {
  const f = await fixture(), before = configurationReadTarget(f.page(), 'view'); f.change();
  const after = configurationReadTarget(projectConfigPage(await f.config.read({ mode: 'default' }), 's', { offset: 0, limit: 100 }), 'view');
  assert.ok(before && after); assert.notEqual(before.configIdentity, after.configIdentity); assert.equal(before.context, after.context);
});
test('global read target remains project-partitioned and rejects an invalid correlation identity', async () => {
  const f = await fixture(); assert.equal(configurationReadTarget(f.page(), '') , undefined);
  assert.notDeepEqual(configurationReadTarget(f.page(), 'first'), configurationReadTarget(f.page(), 'second')); assert.equal(configurationReadTarget(undefined, 'view'), undefined);
});
test('inactive Context picker filters only rows and preserves the original global current summary', async () => {
  const f = await fixture(), page = projectContextChoices(f.snapshot, 's', { search: 'context-1', page: { offset: 0, limit: 100 } });
  assert.ok(page.contexts.every(context => !context.active)); assert.deepEqual(page.currentContextInfo, f.page().currentContextInfo);
  assert.equal(configurationReadTarget(page, 'view')?.namespace, 'team');
});
test('inactive Context picker client rejects global summary drift between filtered pages', async () => {
  const f = await fixture(), states: ContextChoiceState[] = []; let posts = 0;
  const client = new ContextChoiceClient(async request => {
    if (request.method === 'GET') return f.transport(request);
    assert.equal(request.path, '/v2/configuration/contexts'); const offset = posts++ ? 100 : 0;
    const page = projectContextChoices(f.snapshot, 's', { search: '', page: { offset, limit: 100 } });
    if (offset && page.currentContextInfo) page.currentContextInfo.namespace = 'other';
    return { status: 200, body: JSON.stringify(page) };
  }, state => states.push(state));
  await client.read({ mode: 'default' }, ''); await client.next(); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(client.pick('context-100'), undefined); client.dispose();
});
