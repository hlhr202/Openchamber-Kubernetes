// Synthetic directory metadata and read-only client transport only. Never import/call the real filesystem adapter, bridge, preference or config writers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourcePicker } from '../../src/service/queries/source-picker.ts';
import { SourcePickerClient } from '../../src/host/source-picker-client.ts';
import type { SourcePickerState } from '../../src/host/source-picker-client.ts';
import { sourcePickerRequestSchema, sourcePickerPageSchema, sourceChildPath, parentDirectory, pickedSource } from '../../src/shared/source-picker-protocol.ts';
import type { SourcePickerRequest } from '../../src/shared/source-picker-protocol.ts';

const generation = '00000000-0000-4000-8000-000000000001', signal = () => new AbortController().signal;
const request = (fields: Partial<SourcePickerRequest> = {}): SourcePickerRequest => ({ protocol: 2, serviceGeneration: generation, directory: '/synthetic', showHidden: false, offset: 0, ...fields });
const fails = (code: string) => (error: unknown) => error instanceof Error && error.message === code;
const health = { status: 200, body: JSON.stringify({ protocol: 2, status: 'ready', serviceGeneration: generation, version: '0.1.0', compatibility: '2.5.1' }) };

test('source picker schema requires explicit canonical directories, bounded paging and no body/credential or shell fields', () => {
  for (const directory of ['', 'relative', '//synthetic', '/a/../b', '/a/./b', '/a//b', '/a/', '/a\u0000b', '/a\\b']) assert.equal(sourcePickerRequestSchema.safeParse(request({ directory })).success, false);
  assert.equal(sourcePickerRequestSchema.safeParse(request({ directory: '/' })).success, true);
  for (const fields of [{ offset: 1 }, { offset: 2001 }, { token: 'SYNTHETIC_SECRET' }, { content: 'SYNTHETIC_SECRET' }]) assert.equal(sourcePickerRequestSchema.safeParse({ ...request(), ...fields }).success, false);
});
test('metadata projection sorts and filters hidden names without returning any file body, and includes blocked links as non-selectable metadata', async () => {
  let calls = 0;
  const picker = createSourcePicker(generation, async () => { calls++; return { generation: 'raw-version', entries: [{ name: 'z.yaml', kind: 'file' }, { name: '.hidden', kind: 'file' }, { name: 'a', kind: 'directory' }, { name: 'link', kind: 'blocked' }] }; });
  assert.equal(calls, 0); const page = await picker.read(request(), signal()); assert.deepEqual(page.entries.map(entry => entry.name), ['a', 'link', 'z.yaml']);
  const hidden = await picker.read(request({ showHidden: true }), signal()); assert.equal(hidden.entries[0]?.name, '.hidden');
  assert.notEqual(page.listingIdentity, hidden.listingIdentity); assert.equal(page.parent, '/'); assert.equal(JSON.stringify(page).includes('raw-version'), false); picker.close();
});
test('metadata pagination binds all 2000-or-fewer entries and the physical generation, not just the visible page', async () => {
  let revision = 'one';
  const picker = createSourcePicker(generation, async () => ({ generation: revision, entries: Array.from({ length: 101 }, (_, n) => ({ name: `file-${String(n).padStart(3, '0')}`, kind: 'file' as const })) }));
  const first = await picker.read(request(), signal()); assert.equal(first.nextOffset, 100);
  const second = await picker.read(request({ offset: 100, listingIdentity: first.listingIdentity }), signal()); assert.equal(second.entries.length, 1);
  revision = 'two'; await assert.rejects(picker.read(request({ offset: 100, listingIdentity: first.listingIdentity }), signal()), fails('CONFIG_CHANGED')); picker.close();
});
test('generation/entry-count/duplicate boundaries reject before exposing an ambiguous or truncated file selection', async () => {
  let calls = 0;
  const picker = createSourcePicker(generation, async () => { calls++; return { generation: 'one', entries: [] }; });
  await assert.rejects(picker.read(request({ serviceGeneration: '00000000-0000-4000-8000-000000000002' }), signal()), fails('STALE_TARGET')); assert.equal(calls, 0); picker.close();
  for (const entries of [Array.from({ length: 2001 }, (_, n) => ({ name: `f${n}`, kind: 'file' as const })), [{ name: 'same', kind: 'file' as const }, { name: 'same', kind: 'file' as const }]]) {
    const value = createSourcePicker(generation, async () => ({ generation: 'one', entries })); await assert.rejects(value.read(request(), signal())); value.close();
  }
});
test('path selection helpers neither parse nor persist a configuration; append preserves order, deduplicates and rejects overflow', () => {
  assert.equal(sourceChildPath('/', 'config'), '/config'); assert.equal(sourceChildPath('/synthetic', 'a.yaml'), '/synthetic/a.yaml'); assert.equal(parentDirectory('/'), null);
  assert.deepEqual(pickedSource({ mode: 'merge', paths: ['/synthetic/b', '/synthetic/a'] }, '/synthetic/b', true), { mode: 'merge', paths: ['/synthetic/b', '/synthetic/a'] });
  assert.deepEqual(pickedSource({ mode: 'file', path: '/synthetic/a' }, '/synthetic/b', true), { mode: 'merge', paths: ['/synthetic/a', '/synthetic/b'] });
  assert.deepEqual(pickedSource({ mode: 'default' }, '/synthetic/a', false), { mode: 'file', path: '/synthetic/a' });
  assert.throws(() => pickedSource({ mode: 'merge', paths: Array.from({ length: 64 }, (_, n) => `/synthetic/${n}`) }, '/synthetic/new', true));
  for (const name of ['..', 'a/b', 'a\\b']) assert.throws(() => sourceChildPath('/synthetic', name));
});
test('source client is inert, sends paths only in POST body and selection only returns an existing regular file path', async () => {
  const requests: string[] = [], states: SourcePickerState[] = [], picker = createSourcePicker(generation, async () => ({ generation: 'one', entries: [{ name: 'file', kind: 'file' }, { name: 'dir', kind: 'directory' }, { name: 'link', kind: 'blocked' }] }));
  const client = new SourcePickerClient(async input => { requests.push(input.path); return input.method === 'GET' ? health : { status: 200, body: JSON.stringify(await picker.read(JSON.parse(input.body ?? '{}'), signal())) }; }, state => states.push(state));
  assert.equal(requests.length, 0); assert.equal(client.pick('file'), undefined); await client.read('/synthetic'); assert.equal(states.at(-1)?.phase, 'ready');
  assert.equal(client.pick('file'), '/synthetic/file'); for (const name of ['dir', 'link', 'missing', '../file']) assert.equal(client.pick(name), undefined);
  assert.deepEqual(requests, ['/health', '/v2/configuration/files']); client.dispose(); picker.close();
});
test('reset rejects late read responses and removes every selectable path without contacting a writer', async () => {
  const waiting = Promise.withResolvers<{ status: number; body: string }>(), states: SourcePickerState[] = [];
  const picker = createSourcePicker(generation, async () => ({ generation: 'one', entries: [{ name: 'file', kind: 'file' }] })), page = await picker.read(request(), signal());
  const client = new SourcePickerClient(async input => input.method === 'GET' ? health : waiting.promise, state => states.push(state));
  const pending = client.read('/synthetic'); await Promise.resolve(); await Promise.resolve(); client.reset(); waiting.resolve({ status: 200, body: JSON.stringify(page) }); await pending;
  assert.equal(states.at(-1)?.phase, 'idle'); assert.equal(client.pick('file'), undefined); client.dispose(); picker.close();
});
test('public directory pages reject body extensions, invalid parent/order/duplicates and mixed hidden policy', async () => {
  const picker = createSourcePicker(generation, async () => ({ generation: 'one', entries: [{ name: 'a', kind: 'file' }, { name: 'b', kind: 'file' }] }));
  const page = await picker.read(request(), signal());
  for (const fields of [{ parent: '/different' }, { entries: [...page.entries].reverse() }, { entries: [page.entries[0], page.entries[0]] }, { content: 'SYNTHETIC_SECRET' }, { entries: [{ name: '.hidden', kind: 'file' }] }]) {
    assert.equal(sourcePickerPageSchema.safeParse({ ...page, ...fields }).success, false);
  }
  picker.close();
});
