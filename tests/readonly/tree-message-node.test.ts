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
async function fixture() {
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({ 'current-context': 'active',
    clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }], contexts: [{ name: 'active', context: { cluster: 'c' } }] }) }));
  const configRead = await config.read({ mode: 'default' }), requests: ResourceReadRequest[] = [];
  const gateway = createResourceGateway({ config, serviceGeneration: 's', read: async (_selection, request) => {
    requests.push(request);
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
  const tree = new TreeController(transport, undefined, callback => { callback(); return () => {}; });
  const page = () => projectConfigPage(configRead, 's', { offset: 0, limit: 100 });
  tree.configure(page(), { mode: 'default' }, 'view');
  const label = (text: string, parent?: string) => { const found = tree.snapshot.rows.find(row => row.entry.node.label === text && (parent === undefined || row.parent === parent)); assert.ok(found, text); return found; };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return { tree, requests, label, settle, close: () => { tree.dispose(); gateway.close(); } };
}
describe('tree message nodes (showInfoMessage)', { timeout: 10_000 }, () => {
test('activating a message node shows only its bounded label, never a menu or write action', async () => {
  const f = await fixture();
  const context = f.label('active'); await f.tree.expand(context.id);
  const folder = f.tree.snapshot.rows.find(row => row.parent === context.id && row.entry.node.expandable); assert.ok(folder);
  await f.tree.expand(folder.id); await f.settle();
  const leaf = f.tree.snapshot.rows.find(row => row.parent === folder.id && !row.entry.node.expandable); assert.ok(leaf);
  assert.equal(f.tree.snapshot.message, null);
  f.tree.activate(leaf.id); // a non-message node never surfaces a message
  assert.equal(f.tree.snapshot.message, null);
  f.close();
});
test('activate is inert when the tree is not ready and never issues any request', async () => {
  const f = await fixture();
  f.tree.suspend(); f.tree.activate(f.label('active').id);
  assert.equal(f.tree.snapshot.message, null); assert.equal(f.requests.length, 0);
  f.close();
});
test('message state clears when another row is selected, and dispose clears it too', async () => {
  const f = await fixture();
  const context = f.label('active');
  f.tree.activate(context.id); assert.equal(f.tree.snapshot.message, null); // context nodes are not message nodes
  f.tree.dispose(); assert.equal(f.tree.snapshot.message, null); f.close();
});
});
