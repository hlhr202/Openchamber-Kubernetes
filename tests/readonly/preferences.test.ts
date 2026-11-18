// Independent READ projection/storage get+keys only. Never import or construct the preference writer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { preferencePrefix, projectPreferenceLedger } from '../../src/shared/preference-protocol.ts';
import { PreferenceReader } from '../../src/host/preference-reader.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const generation = async () => id(99);
const preferences = { active: { mode: 'file', path: '/synthetic/one' }, known: [{ mode: 'file', path: '/synthetic/one' }] };
const fixture = (n: number, parents: string[] = [], fields = {}) => ({ key: `${preferencePrefix}${id(n)}`, value: { schemaVersion: 1, id: id(n), parents, preferences, ...fields } });
const fail = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;

test('empty ledger has no saved source; a linear revision chain exposes one current head without ordering by wall clock', () => {
  assert.equal(projectPreferenceLedger([]).preferences, undefined);
  const value = projectPreferenceLedger([fixture(2, [id(1)]), fixture(1)]);
  assert.equal(value.conflict, false); assert.equal(value.heads[0]?.id, id(2)); assert.deepEqual(value.preferences, preferences);
});
test('concurrent siblings and concurrent genesis are explicit conflicts, never timestamp or lexical last-writer wins', () => {
  for (const entries of [[fixture(1), fixture(2)], [fixture(1), fixture(2, [id(1)]), fixture(3, [id(1)])]]) {
    const value = projectPreferenceLedger(entries); assert.equal(value.conflict, true); assert.equal(value.heads.length, 2); assert.equal(value.preferences, undefined);
  }
});
test('a read snapshot of explicit resolution referencing all heads has one effective source; unreferenced sibling stays conflicted', () => {
  const branches = [fixture(1), fixture(2, [id(1)]), fixture(3, [id(1)])];
  assert.equal(projectPreferenceLedger([...branches, fixture(4, [id(2), id(3)])]).heads[0]?.id, id(4));
  assert.equal(projectPreferenceLedger([...branches, fixture(4, [id(2)])]).conflict, true);
});
test('wrong key, duplicate revision, repeated/self/missing parents and cycles reject the whole snapshot', () => {
  assert.throws(() => projectPreferenceLedger([{ ...fixture(1), key: `${preferencePrefix}${id(9)}` }]), fail('CONFIG_INVALID'));
  assert.throws(() => projectPreferenceLedger([fixture(1), fixture(1)]), fail('CONFIG_INVALID'));
  assert.throws(() => projectPreferenceLedger([fixture(1, [id(1)])]), fail('CONFIG_INVALID'));
  assert.throws(() => projectPreferenceLedger([fixture(1), fixture(2, [id(1), id(1)])]), fail('CONFIG_INVALID'));
  assert.throws(() => projectPreferenceLedger([fixture(2, [id(1)])]), fail('STALE_TARGET'));
  assert.throws(() => projectPreferenceLedger([fixture(1, [id(2)]), fixture(2, [id(1)])]), fail('CONFIG_INVALID'));
});
test('stored preferences reject credential/config text extensions, duplicate known selections, relative paths and unknown formats', () => {
  for (const pref of [{ ...preferences, token: 'SYNTHETIC_SECRET' }, { ...preferences, known: [preferences.active, preferences.active] }, { ...preferences, active: { mode: 'file', path: 'relative' } }]) {
    assert.throws(() => projectPreferenceLedger([fixture(1, [], { preferences: pref })]), fail('CONFIG_INVALID'));
  }
  assert.throws(() => projectPreferenceLedger([fixture(1, [], { schemaVersion: 2 })]), fail('CONFIG_INVALID'));
});
test('ordered merge choices remain exact preference data, deeply immutable, and input iteration order does not change snapshot identity', () => {
  const a = fixture(1, [], { preferences: { active: { mode: 'merge', paths: ['/synthetic/b', '/synthetic/a'] }, known: [] } }), b = fixture(2, [id(1)]);
  const value = projectPreferenceLedger([b, a]); assert.equal(value.identity, projectPreferenceLedger([a, b]).identity);
  assert.equal(Object.isFrozen(value.heads[0]?.preferences.known), true); assert.equal(Object.isFrozen(value.revisions), true);
  assert.ok(value.identity.includes('/synthetic/b')); // Only explicit non-secret preference paths, never credentials/configuration response data.
});
test('revision count and per-value UTF-8 limits fail without partial saved-source success', () => {
  assert.throws(() => projectPreferenceLedger(Array.from({ length: 65 }, (_, n) => fixture(n + 1))), fail('QUERY_LIMIT'));
  const paths = Array.from({ length: 15 }, (_, n) => `/${n}${'x'.repeat(3990)}`);
  assert.throws(() => projectPreferenceLedger([fixture(1, [], { preferences: { active: { mode: 'merge', paths }, known: [] } })]), fail('BUDGET_EXCEEDED'));
});
test('reader performs only selected-prefix GETs bracketed by keys and never accepts a new revision arriving during reading', async () => {
  const entry = fixture(1), calls: string[] = [];
  const reader = new PreferenceReader({ generation, keys: async value => { assert.equal(value, id(99)); calls.push('keys'); return ['unrelated', entry.key]; }, get: async (key, value) => { assert.equal(value, id(99)); calls.push(key); return entry.value; } });
  assert.equal((await reader.read()).heads.length, 1); assert.deepEqual(calls, ['keys', entry.key, 'keys']);
  let snapshots = 0;
  await assert.rejects(new PreferenceReader({ generation, keys: async () => ++snapshots === 1 ? [entry.key] : [entry.key, fixture(2).key], get: async () => entry.value }).read(), fail('STALE_TARGET'));
});
test('missing values, duplicate keys, excessive namespaces and arbitrary storage errors become fixed failures without raw echoes', async () => {
  await assert.rejects(new PreferenceReader({ generation, keys: async () => [fixture(1).key], get: async () => undefined }).read(), fail('STALE_TARGET'));
  await assert.rejects(new PreferenceReader({ generation, keys: async () => ['a', 'a'], get: async () => undefined }).read(), fail('CONFIG_INVALID'));
  await assert.rejects(new PreferenceReader({ generation, keys: async () => Array.from({ length: 2001 }, (_, n) => String(n)), get: async () => undefined }).read(), fail('CONFIG_INVALID'));
  await assert.rejects(new PreferenceReader({ generation, keys: async () => { throw new Error('SYNTHETIC_SECRET'); }, get: async () => undefined }).read(), fail('STATE_UNAVAILABLE'));
});
test('cancelled non-cooperating read holds its admission slot until actual keys settlement, and never starts get or a late snapshot', async () => {
  const resolvers: ((value: string[]) => void)[] = [], controllers = Array.from({ length: 4 }, () => new AbortController()); let gets = 0;
  const reader = new PreferenceReader({ generation, keys: () => new Promise<string[]>(resolve => resolvers.push(resolve)), get: async () => { gets++; return undefined; } });
  const requests = controllers.map(controller => assert.rejects(reader.read(controller.signal), fail('QUERY_CANCELLED')));
  await Promise.resolve(); assert.equal(resolvers.length, 4);
  for (const controller of controllers) controller.abort();
  await assert.rejects(reader.read(), fail('QUERY_LIMIT'));
  for (const resolve of resolvers) resolve([]);
  await Promise.all(requests); assert.equal(gets, 0);
});
test('pre-aborted reads issue no storage call and snapshot identity changes when an immutable-key value was externally modified', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  await assert.rejects(new PreferenceReader({ generation, keys: async () => { calls++; return []; }, get: async () => undefined }).read(controller.signal), fail('QUERY_CANCELLED'));
  assert.equal(calls, 0);
  const a = projectPreferenceLedger([fixture(1)]), b = projectPreferenceLedger([fixture(1, [], { preferences: { ...preferences, active: { mode: 'default' } } })]);
  assert.notEqual(a.identity, b.identity);
});
