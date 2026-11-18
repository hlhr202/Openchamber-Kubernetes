// Synthetic read-only configuration choices only. No bridge, ContextClient, preference or configuration writer imports/calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeConfigSources, publicConfigSnapshot } from '../../src/service/queries/kubeconfig.ts';
import { projectContextChoices } from '../../src/service/queries/context-choices.ts';
import { contextChoicePageSchema } from '../../src/shared/context-choice-protocol.ts';
import { ContextChoiceClient } from '../../src/host/context-choice-client.ts';
import type { ContextChoiceState } from '../../src/host/context-choice-client.ts';

const generation = '00000000-0000-4000-8000-000000000001', selection = { mode: 'file' as const, path: '/synthetic/config' };
function config() {
  const merged = mergeConfigSources([{ sourcePath: selection.path, content: JSON.stringify({ 'current-context': 'ctx-000', contexts: Array.from({ length: 202 }, (_, n) => ({ name: `ctx-${String(n).padStart(3, '0')}`, context: { cluster: 'missing', namespace: 'default' } })) }) }]);
  return { status: 'ready' as const, sources: { mode: 'file' as const, selectedCount: 1, loadedCount: 1, missingCount: 0 }, snapshot: publicConfigSnapshot(merged, 'synthetic-identity') };
}
const health = { status: 200, body: JSON.stringify({ protocol: 2, status: 'ready', serviceGeneration: generation, version: '0.1.0', compatibility: '2.5.1' }) };
test('inactive context projection searches the whole merged snapshot, includes missing-reference choices and never exposes the active name as a picker choice', () => {
  const page = projectContextChoices(config(), generation, { search: 'ctx-20', page: { offset: 0, limit: 100 } });
  assert.deepEqual(page.contexts.map(entry => entry.name), ['ctx-200', 'ctx-201']); assert.equal(page.contexts[0]?.available, false); assert.equal(page.currentContext, 'ctx-000');
  assert.equal(projectContextChoices(config(), generation, { search: 'ctx-000', page: { offset: 0, limit: 100 } }).total, 0);
});
test('filtered context paging retains original configuration identity and root current metadata, with no case-insensitive or cross-page guesswork', () => {
  const first = projectContextChoices(config(), generation, { search: 'ctx-', page: { offset: 0, limit: 100 } }); assert.equal(first.total, 201); assert.equal(first.nextOffset, 100);
  const second = projectContextChoices(config(), generation, { search: 'ctx-', page: { offset: 100, limit: 100, configIdentity: first.configIdentity } }); assert.equal(second.contexts[0]?.name, 'ctx-101');
  assert.equal(projectContextChoices(config(), generation, { search: 'CTX', page: { offset: 0, limit: 100 } }).total, 0);
  assert.throws(() => projectContextChoices(config(), generation, { search: '', page: { offset: 100, limit: 100, configIdentity: 'stale' } }));
});
test('choice DTOs reject active, nonmatching and credential/body extensions', () => {
  const page = projectContextChoices(config(), generation, { search: 'ctx-20', page: { offset: 0, limit: 100 } });
  for (const fields of [{ search: 'other' }, { token: 'SYNTHETIC_SECRET' }, { contexts: page.contexts.map(entry => ({ ...entry, active: true })) }]) assert.equal(contextChoicePageSchema.safeParse({ ...page, ...fields }).success, false);
});
test('context choice client only reads health/configuration and returns exact currently visible choice metadata without switching anything', async () => {
  const calls: string[] = [], states: ContextChoiceState[] = [];
  const client = new ContextChoiceClient(async input => {
    calls.push(input.path); if (input.method === 'GET') return health;
    const request = JSON.parse(input.body ?? '{}'); return { status: 200, body: JSON.stringify(projectContextChoices(config(), generation, request)) };
  }, state => states.push(state));
  assert.equal(calls.length, 0); assert.equal(client.pick('ctx-200'), undefined);
  await client.read(selection, 'ctx-20'); assert.equal(states.at(-1)?.phase, 'ready');
  assert.deepEqual(client.pick('ctx-200'), { serviceGeneration: generation, configIdentity: 'synthetic-identity', selection, context: 'ctx-200' });
  assert.equal(client.pick('ctx-000'), undefined); assert.equal(client.pick('ctx-100'), undefined); assert.deepEqual(calls, ['/health', '/v2/configuration/contexts']); client.dispose();
});
test('client paging remains bounded and a changed filtered generation cannot become a selectable context', async () => {
  let posts = 0; const states: ContextChoiceState[] = [];
  const client = new ContextChoiceClient(async input => {
    if (input.method === 'GET') return health; const request = JSON.parse(input.body ?? '{}'), page = projectContextChoices(config(), generation, request);
    if (posts++) page.configIdentity = 'changed'; return { status: 200, body: JSON.stringify(page) };
  }, state => states.push(state));
  await client.read(selection, 'ctx-'); await client.next(); assert.equal(posts, 2); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(client.pick('ctx-101'), undefined); client.dispose();
});
test('choice reset/dispose drops late responses and raw server error details never become picker output', async () => {
  const waiting = Promise.withResolvers<{ status: number; body: string }>(), states: ContextChoiceState[] = [];
  const client = new ContextChoiceClient(async input => input.method === 'GET' ? health : waiting.promise, state => states.push(state));
  const pending = client.read(selection, ''); await Promise.resolve(); await Promise.resolve(); client.reset();
  waiting.resolve({ status: 400, body: JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'SYNTHETIC_SECRET' } }) }); await pending;
  assert.equal(states.at(-1)?.phase, 'idle'); assert.equal(JSON.stringify(states).includes('SYNTHETIC_SECRET'), false); assert.equal(client.pick('ctx-001'), undefined); client.dispose();
});
