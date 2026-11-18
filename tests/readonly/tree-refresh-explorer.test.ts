// Independent synthetic reads and the pure headless controller only. No real adapters/SDK/DOM or write chain.
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';
import { TreeController } from '../../src/host/tree-controller.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { projectConfigPage } from '../../src/service/queries/config-page.ts';
import { createResourceGateway } from '../../src/service/queries/resource-gateway.ts';
import { resourceDescriptors } from '../../src/shared/tree.ts';
const signal = () => new AbortController().signal;
async function fixture(reply?: (request: ResourceReadRequest) => unknown | Promise<unknown>) {
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active',
    clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const configRead = await config.read({ mode: 'default' }), requests: ResourceReadRequest[] = [];
  let failNext = false;
  const gateway = createResourceGateway({ config, serviceGeneration: 's', outbound: { tokensPerSecond: 1000, burst: 16 }, read: async (_selection, request) => {
    requests.push(request);
    if (failNext) { failNext = false; throw new BoundaryError('FORBIDDEN'); }
    if (reply) return (async () => { const body = JSON.stringify(await reply(request)); return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(body); } }, close: async () => {} }; })();
    const descriptor = Object.values(resourceDescriptors).find(type => request.path.endsWith(`/${type.resource}`) || request.path.endsWith(`/${type.resource}/sample`)); assert.ok(descriptor, request.path);
    const single = request.path.includes('/sample'), apiVersion = descriptor.group ? `${descriptor.group}/${descriptor.version}` : descriptor.version;
    const item = { apiVersion, kind: descriptor.kind, metadata: { name: 'sample', uid: 'uid-1', resourceVersion: '10', ...(descriptor.scope === 'namespace' ? { namespace: 'default' } : {}) }, data: { key: 'value' } };
    const body = JSON.stringify(single ? item : { apiVersion, kind: `${descriptor.kind}List`, metadata: { resourceVersion: '20' }, items: [item] });
    return { status: 200, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(body); } }, close: async () => {} };
  } });
  const transport = async (request: { method: 'POST'; path: string; body: string }) => {
    try { return { status: 200, body: JSON.stringify(await (request.path === '/v2/resources/read' ? gateway.read(JSON.parse(request.body) as unknown, signal()) : gateway.readTree(JSON.parse(request.body) as unknown, signal()))) }; }
    catch (error) { return { status: 400, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; }
  };
  const tree = new TreeController(transport, undefined, callback => { callback(); return () => {}; }); // immediate queue window: deterministic refresh
  const page = () => projectConfigPage(configRead, 's', { offset: 0, limit: 100 });
  tree.configure(page(), { mode: 'default' }, 'view');
  const label = (text: string, parent?: string) => { const found = tree.snapshot.rows.find(row => row.entry.node.label === text && (parent === undefined || row.parent === parent)); assert.ok(found, text); return found; };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  // The context root expands locally; the first NETWORK query is the Namespaces resources folder.
  const opened = async () => { const context = label('active'); await tree.expand(context.id); const namespaces = label('Namespaces'); await tree.expand(namespaces.id); await settle(); return namespaces; };
  return { tree, requests, label, opened, settle, failNext() { failNext = true; }, close: () => { tree.dispose(); gateway.close(); } };
}
describe('explorer refresh (tree invalidation only)', { timeout: 10_000 }, () => {
test('refreshAll invalidates every query row and re-reads only VISIBLE EXPANDED branches', async () => {
  const f = await fixture();
  await f.opened();
  const before = f.requests.length; assert.ok(before > 0);
  f.tree.refreshAll();
  assert.ok(f.tree.snapshot.rows.some(row => row.stale)); // invalidation is visible immediately
  await f.settle(); await f.settle();
  assert.ok(f.requests.length > before, 'the expanded Namespaces branch is re-read'); f.close();
});
test('a collapsed branch is invalidated but never re-read by the toolbar refresh', async () => {
  const f = await fixture();
  const namespaces = await f.opened();
  const expandedChild = f.tree.snapshot.rows.find(row => row.parent === namespaces.id); assert.ok(expandedChild);
  f.tree.collapse(namespaces.id); const before = f.requests.length;
  f.tree.refreshAll(); await f.settle(); await f.settle(); await f.settle();
  assert.equal(f.requests.length, before, 'the collapsed folder list is not fetched again'); f.close();
});
test('refresh failure keeps stale rows and a fixed error, never a healthy empty tree', async () => {
  const f = await fixture();
  const namespaces = await f.opened();
  f.failNext(); f.tree.refreshAll(); await f.settle(); await f.settle(); await f.settle();
  const refreshed = f.tree.snapshot.rows.find(row => row.id === namespaces.id);
  assert.ok(refreshed); assert.equal(refreshed.phase, 'error'); assert.equal(refreshed.error, 'FORBIDDEN');
  assert.ok(f.tree.snapshot.rows.some(row => row.stale || row.error)); f.close();
});
test('refreshAll is inert before the tree is ready and never touches configuration', async () => {
  const f = await fixture();
  await f.opened(); const before = f.requests.length;
  f.tree.suspend(); f.tree.refreshAll(); await f.settle(); await f.settle();
  assert.equal(f.requests.length, before); // suspended: no re-read
  f.tree.clear(); f.tree.refreshAll(); await f.settle();
  assert.equal(f.requests.length, before); // cleared: inert
  f.close();
});
test('refreshAll issues only GET reads through the original tree transport', async () => {
  const f = await fixture();
  await f.opened(); f.tree.refreshAll(); await f.settle(); await f.settle();
  assert.ok(f.requests.length > 0); assert.ok(f.requests.every(request => request.method === 'GET')); f.close();
});
});
