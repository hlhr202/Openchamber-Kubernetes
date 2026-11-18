// Public DTOs and independent read-only configuration parsing/paging only. No write client/controller/planner/adapter/hook import or invocation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeConfigSources, publicConfigSnapshot } from '../../src/service/queries/kubeconfig.ts';
import { projectConfigPage } from '../../src/service/queries/config-page.ts';
import { configPageSchema } from '../../src/shared/protocol.ts';
import { namespaceRequestSchema, namespaceOutcomeSchema } from '../../src/shared/namespace-protocol.ts';

test('querying the original Namespace outcome accepts only the exact grant envelope', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const request = { protocol: 2, kind: 'status', grant: { id, serviceGeneration: id, capability: 'a'.repeat(64), expiresAt: 1 } };
  assert.equal(namespaceRequestSchema.safeParse(request).success, true);
  assert.equal(namespaceRequestSchema.safeParse({ ...request, grant: undefined }).success, false);
  assert.equal(namespaceRequestSchema.safeParse({ ...request, namespace: 'payments' }).success, false);
});
import { ConfigurationClient } from '../../src/host/configuration-client.ts';

const generation = '00000000-0000-4000-8000-000000000001';
function read(current = 'context-100', total = 101) {
  const merged = mergeConfigSources([{ sourcePath: '/synthetic/config', content: JSON.stringify({ 'current-context': current,
    contexts: Array.from({ length: total }, (_, index) => ({ name: `context-${index}`, context: { cluster: 'missing-cluster', user: 'missing-user', namespace: 'old' } })) }) }]);
  return { status: 'ready' as const, sources: { mode: 'file' as const, selectedCount: 1, loadedCount: 1, missingCount: 0 }, snapshot: publicConfigSnapshot(merged, 'synthetic-identity') };
}
const configuration = { serviceGeneration: generation, projectId: 'synthetic-view', configIdentity: 'synthetic-identity' };
const outcome = () => ({ id: generation, serviceGeneration: generation, configuration, contextAction: 'update', context: 'context-100', path: '/synthetic/config', contextOrigin: '/synthetic/config', version: 'synthetic-version', previous: 'old', namespace: 'next',
  sources: [{ path: '/synthetic/config', status: 'present', version: 'synthetic-version', currentContext: 'context-100', definesContext: true }], step: 'set-namespace', dependencies: [], phase: 'prepared', cleanup: 'none', createdAt: 1, updatedAt: 2 });

test('configuration snapshots retain an existing current context with missing cluster/user references without fabricating a connected resource target', () => {
  const value = read('context-0', 1), page = projectConfigPage(value, generation, { offset: 0, limit: 100 });
  assert.equal(page.currentContext, 'context-0'); assert.equal(page.currentContextMissing, false);
  assert.equal(page.contexts[0]?.active, true); assert.equal(page.contexts[0]?.available, false); assert.equal(page.contexts[0]?.authentication.evaluated, false);
});
test('effective current context is global metadata on every bounded page, even when the current row is not on that page', () => {
  const value = read(), first = projectConfigPage(value, generation, { offset: 0, limit: 100 }), last = projectConfigPage(value, generation, { offset: 100, limit: 100, configIdentity: 'synthetic-identity' });
  assert.equal(first.currentContext, 'context-100'); assert.equal(first.contexts.some(entry => entry.active), false);
  assert.equal(last.currentContext, first.currentContext); assert.equal(last.contexts[0]?.active, true); assert.equal(last.contexts[0]?.available, false);
});
test('config-page DTO rejects missing global metadata, contradictory row activity and dangling-current metadata claiming an active row', () => {
  const page = projectConfigPage(read('context-0', 1), generation, { offset: 0, limit: 100 });
  for (const fields of [{ currentContext: undefined }, { currentContext: 'different' }, { currentContextMissing: true }, { contexts: page.contexts.map(entry => ({ ...entry, active: false })) }]) {
    assert.equal(configPageSchema.safeParse({ ...page, ...fields }).success, false);
  }
  assert.equal(projectConfigPage(read('missing-name', 1), generation, { offset: 0, limit: 100 }).currentContextMissing, true);
  assert.equal(projectConfigPage(read('', 1), generation, { offset: 0, limit: 100 }).currentContext, '');
});
test('read-only configuration client rejects a changed global current context hidden off-page under an unchanged source identity', async () => {
  let posts = 0, error: string | undefined;
  const value = read();
  const client = new ConfigurationClient(async request => {
    if (request.method === 'GET') return { status: 200, body: JSON.stringify({ protocol: 2, status: 'ready', serviceGeneration: generation, version: '0.1.0', compatibility: '2.5.1' }) };
    const offset = posts++ ? 100 : 0, page = projectConfigPage(value, generation, { offset, limit: 100 });
    if (offset) { page.currentContext = 'context-99'; page.currentContextInfo = { name: 'context-99', namespace: 'old', available: false }; for (const context of page.contexts) context.active = false; }
    return { status: 200, body: JSON.stringify(page) };
  }, state => { error = state.error; });
  await client.select({ mode: 'file', path: '/synthetic/config' }); await client.next();
  assert.equal(error, 'STALE_TARGET'); assert.equal(posts, 2); client.dispose();
});
test('Use Namespace prepare DTO binds only configuration identity and explicit context; old target-shaped or replaced-context inputs cannot slip through', () => {
  const request = { protocol: 2, kind: 'prepare', selection: { mode: 'merge', paths: ['/synthetic/config'] }, configuration, context: 'context-100', namespace: 'next' };
  assert.equal(namespaceRequestSchema.safeParse(request).success, true);
  assert.equal(namespaceRequestSchema.safeParse({ ...request, target: { context: 'context-100', namespace: 'old' } }).success, false);
  assert.equal(namespaceRequestSchema.safeParse({ ...request, configuration: undefined }).success, false);
  assert.equal(namespaceRequestSchema.safeParse({ ...request, context: '' }).success, false);
  assert.equal(namespaceOutcomeSchema.safeParse(outcome()).success, true);
});
test('configuration-only original outcome retains previous namespace and sources but rejects fabricated resource targets, unknown references or changed current context', () => {
  const value = outcome();
  for (const fields of [{ context: 'different' }, { configuration: { ...configuration, serviceGeneration: '00000000-0000-4000-8000-000000000002' } },
    { target: { context: 'context-100', namespace: 'old' } }, { cluster: { token: 'SYNTHETIC_SECRET' } }, { sources: undefined }]) {
    assert.equal(namespaceOutcomeSchema.safeParse({ ...value, ...fields }).success, false);
  }
});
