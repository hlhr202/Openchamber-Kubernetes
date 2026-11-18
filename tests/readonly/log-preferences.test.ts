// Pure settings snapshots/read-only get and decision state only. Never import writer, bridge, SDK/UI or run a log/session.
import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultLogPreferences, logPreferencesSchema, readLogPreferences, logPreferenceKey, logPreferenceNumber, logOptionsFromPreferences, LogOpenDefaults } from '../../src/shared/log-preferences.ts';
import { LogPreferenceReader } from '../../src/host/log-preference-reader.ts';
import type { LogPreferenceState } from '../../src/host/log-preference-reader.ts';
test('upstream default log settings remain false/-1/Webview with a single versioned instance key', () => {
  assert.deepEqual(defaultLogPreferences, { version: 1, follow: false, timestamp: false, wrap: false, autorun: false, since: -1, tail: -1, destination: 'Webview' }); assert.equal(logPreferenceKey, 'log-viewer.v1');
});
test('missing preference yields immutable safe defaults without a write/migration or autorun', () => {
  const value = readLogPreferences(undefined); assert.equal(value, defaultLogPreferences); assert.equal(Object.isFrozen(value), true); assert.equal(value.autorun, false);
});
test('valid non-sensitive saved fields roundtrip in a fresh immutable snapshot', () => {
  const input = { ...defaultLogPreferences, follow: true, timestamp: true, wrap: true, autorun: true, since: 3600, tail: 100 };
  const value = readLogPreferences(input); assert.deepEqual(value, input); assert.notEqual(value, input); assert.equal(Object.isFrozen(value), true); input.since = 1; assert.equal(value.since, 3600);
});
test('stored Terminal choice remains distinct and never silently normalizes to Webview', () => {
  assert.equal(readLogPreferences({ ...defaultLogPreferences, destination: 'Terminal' }).destination, 'Terminal');
});
test('unknown fields reject logs/search/source/container/config identity rather than saving or ignoring them', () => {
  for (const key of ['text', 'query', 'filter', 'source', 'container', 'target', 'reference', 'token', 'kubeconfig', 'path']) assert.throws(() => readLogPreferences({ ...defaultLogPreferences, [key]: 'SYNTHETIC_SECRET' }), /^BoundaryError: INVALID_INPUT$/);
});
test('malformed/versioned/unbounded settings are fixed invalid, not permissively coerced', () => {
  for (const input of [null, [], 'SYNTHETIC_SECRET', {}, { ...defaultLogPreferences, version: 2 }, { ...defaultLogPreferences, autorun: 'true' }, { ...defaultLogPreferences, follow: 1 }, { ...defaultLogPreferences, since: null }, { ...defaultLogPreferences, destination: 'shell' }]) assert.equal(logPreferencesSchema.safeParse(input).success, false);
});
test('stored since/tail use -1 or positive bounded integer, never zero/fraction/unlimited positive size', () => {
  for (const change of [{ since: 0 }, { since: -2 }, { since: 31_536_001 }, { tail: 0 }, { tail: 1_000_001 }, { tail: 1.5 }, { tail: Infinity }]) assert.equal(logPreferencesSchema.safeParse({ ...defaultLogPreferences, ...change }).success, false);
});
test('blank/zero/negative user numeric input means no filter, not --since=0 or a negative CLI argument', () => {
  for (const value of ['', '0', '-1', '-100']) assert.equal(logPreferenceNumber(value, 1000), -1);
  assert.equal(logPreferenceNumber('001', 1000), 1); assert.equal(logPreferenceNumber('1000', 1000), 1000);
});
test('malformed or too-large numeric drafts fail without preserving the original text in errors', () => {
  for (const value of ['1.2', '1e2', ' 2 ', '1001', 'SYNTHETIC_SECRET', '123456789']) assert.throws(() => logPreferenceNumber(value, 1000), /^BoundaryError: INVALID_INPUT$/);
});
test('setting conversion emits only the existing validated read options and no follow/autorun/storage content', () => {
  assert.deepEqual(logOptionsFromPreferences(defaultLogPreferences), { timestamps: false, sinceSeconds: null, tailLines: null });
  assert.deepEqual(logOptionsFromPreferences({ ...defaultLogPreferences, timestamp: true, since: 20, tail: 3 }), { timestamps: true, sinceSeconds: 20, tailLines: 3 });
});
test('autorun decision needs both a successful preference read and actual ready containers', () => {
  const gate = new LogOpenDefaults(), saved = { ...defaultLogPreferences, autorun: true };
  assert.equal(gate.take(false, 1, saved), null); assert.equal(gate.take(true, 0, saved), null); assert.equal(gate.take(true, 1, saved)?.autorun, true);
});
test('empty/invalid/unbounded container counts cannot produce an automatic read decision', () => {
  for (const count of [-1, 0, NaN, Infinity, 129, 1.5]) assert.equal(new LogOpenDefaults().take(true, count, { ...defaultLogPreferences, autorun: true }), null);
});
test('autorun decision preserves Terminal destination for the read-only output consumer rather than switching modes', () => {
  const decision = new LogOpenDefaults().take(true, 1, { ...defaultLogPreferences, autorun: true, destination: 'Terminal' }); assert.equal(decision?.autorun, true); assert.equal(decision?.settings.destination, 'Terminal');
});
test('defaults apply once per open, so readiness/poll/theme updates never create repeated automatic runs', () => {
  const gate = new LogOpenDefaults(); assert.equal(gate.take(true, 1, defaultLogPreferences)?.autorun, false); assert.equal(gate.take(true, 1, { ...defaultLogPreferences, autorun: true }), null);
});
test('user editing or manual Run/Clear before late preference arrival prevents late overwrite/autorun', () => {
  const gate = new LogOpenDefaults(); gate.touch(); assert.equal(gate.touched, true); assert.equal(gate.take(true, 1, { ...defaultLogPreferences, autorun: true }), null);
});
test('reset decision invalidates pending old autorun revisions and permits defaults only for a later open', () => {
  const gate = new LogOpenDefaults(), first = gate.take(true, 1, { ...defaultLogPreferences, autorun: true }); assert.ok(first); gate.reset(); assert.notEqual(gate.revision, first.revision); assert.equal(gate.touched, false); assert.ok(gate.take(true, 2, defaultLogPreferences));
});
test('explicit Reset applies known preferences but consumes autorun instead of starting a read', () => {
  const gate = new LogOpenDefaults(); gate.touch(); const value = readLogPreferences({ ...defaultLogPreferences, autorun: true }); assert.equal(value.autorun, true); assert.equal(gate.take(true, 1, value), null);
});
test('read-only adapter calls exactly the fixed key and publishes only a validated clone', async () => {
  const states: LogPreferenceState[] = [], keys: string[] = []; const reader = new LogPreferenceReader(async key => { keys.push(key); return { ...defaultLogPreferences, tail: 7 }; }, state => states.push(state));
  await reader.read(); assert.deepEqual(keys, [logPreferenceKey]); assert.equal(states.at(-1)?.phase, 'ready'); assert.equal(states.at(-1)?.settings.tail, 7); assert.equal(Object.isFrozen(states.at(-1)?.settings), true); reader.dispose();
});
test('read-only missing storage snapshot is ready defaults, not an implicit set', async () => {
  const states: LogPreferenceState[] = []; const reader = new LogPreferenceReader(async () => undefined, state => states.push(state)); await reader.read(); assert.equal(states.at(-1)?.phase, 'ready'); assert.equal(states.at(-1)?.settings.autorun, false); reader.dispose();
});
test('invalid stored extra sensitive data fails closed with fixed error and no autorun', async () => {
  const states: LogPreferenceState[] = []; const reader = new LogPreferenceReader(async () => ({ ...defaultLogPreferences, text: 'SYNTHETIC_SECRET', autorun: true }), state => states.push(state));
  await reader.read(); assert.equal(states.at(-1)?.error, 'INVALID_INPUT'); assert.equal(states.at(-1)?.settings.autorun, false); assert.equal(JSON.stringify(states).includes('SYNTHETIC_SECRET'), false); reader.dispose();
});
test('host storage read failures reveal no original text and do not retry or apply earlier autorun', async () => {
  const states: LogPreferenceState[] = []; let calls = 0; const reader = new LogPreferenceReader(async () => { calls++; throw new Error('SYNTHETIC_SECRET'); }, state => states.push(state));
  await reader.read(); assert.equal(calls, 1); assert.equal(states.at(-1)?.error, 'STATE_UNAVAILABLE'); assert.equal(JSON.stringify(states).includes('SYNTHETIC_SECRET'), false); reader.dispose();
});
test('late storage snapshot after reset cannot overwrite a new view or enable its autorun', async () => {
  const response = Promise.withResolvers<unknown>(), states: LogPreferenceState[] = []; const reader = new LogPreferenceReader(() => response.promise, state => states.push(state));
  const pending = reader.read(); reader.reset(); response.resolve({ ...defaultLogPreferences, autorun: true }); await pending; assert.equal(states.at(-1)?.phase, 'idle'); assert.equal(states.at(-1)?.settings.autorun, false); reader.dispose();
});
test('newer storage read wins without letting the older response re-enable autorun', async () => {
  const responses = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()], states: LogPreferenceState[] = []; let calls = 0;
  const reader = new LogPreferenceReader(() => responses[calls++]!.promise, state => states.push(state)); const a = reader.read(), b = reader.read(); responses[1]!.resolve(defaultLogPreferences); await b; responses[0]!.resolve({ ...defaultLogPreferences, autorun: true }); await a; assert.equal(states.at(-1)?.settings.autorun, false); reader.dispose();
});
test('four actual unsettled storage get slots remain charged through reset, with no phantom cancellation', async () => {
  const response = Promise.withResolvers<unknown>(), states: LogPreferenceState[] = []; let calls = 0; const reader = new LogPreferenceReader(() => { calls++; return response.promise; }, state => states.push(state));
  const pending: Promise<void>[] = []; for (let n = 0; n < 5; n++) { reader.reset(); pending.push(reader.read()); } assert.equal(calls, 4); assert.equal(states.at(-1)?.error, 'QUERY_LIMIT'); response.resolve(undefined); await Promise.all(pending); reader.dispose();
});
test('dispose suppresses late read projection without executing a storage/session cleanup path', async () => {
  const response = Promise.withResolvers<unknown>(), states: LogPreferenceState[] = []; const reader = new LogPreferenceReader(() => response.promise, state => states.push(state)); const pending = reader.read(); reader.dispose(); const count = states.length; response.resolve({ ...defaultLogPreferences, autorun: true }); await pending; assert.equal(states.length, count);
});
