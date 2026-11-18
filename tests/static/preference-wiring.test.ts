// Text only. Never import or construct PreferenceClient/storage writer/prepare/submit/cancel.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const file = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ordered = (text: string, ...parts: string[]) => { let offset = -1; for (const part of parts) { const next = text.indexOf(part, offset + 1); assert.ok(next > offset, part); offset = next; } };

test('pinned SDK storage lacks a plugin generation parameter; kubeconfig-source preferences still use authenticated generation-bound service routes', async () => {
  const api = await file('tests/fixtures/baseline/openchamber/packages/sdk/API.md.txt'), storage = await file('tests/fixtures/baseline/openchamber/packages/web/server/lib/guests/storage.js.txt');
  assert.ok(api.includes('Storage belongs to the extension on the connected server') && api.includes('writes are atomic'));
  ordered(storage, 'withStorageLock(file, async () =>', 'await authorize()', 'await fs.writeFile(temporary, data', 'await fs.rename(temporary, file)');
  const bridge = await file('src/host/bridge.ts'), transport = await file('src/host/preference-transport.ts'), http = await file('src/service/runtime/http.ts');
  const sourcePreferences = bridge.slice(bridge.indexOf('const preferences = new PreferenceClient('), bridge.indexOf('const stopReady ='));
  assert.ok(sourcePreferences.includes('createPreferenceTransport(request => host.serviceRequest(request))') && !sourcePreferences.includes('host.storage.'));
  assert.ok(!transport.includes('host.storage.') && (bridge.match(/host\.storage\./g) ?? []).length === 2); // Only the separately reviewed scalar log get/set adapters use SDK storage.
  ordered(http, 'if (!authorized(', "'/v2/preferences/read'", 'value.serviceGeneration !== options.serviceGeneration', 'Date.now() >= value.notAfter', 'options.config.privateRead(value.selection, value.configIdentity', 'options.lock.run(appendSignal', 'options.preferences.append(value.revision, value.step, verify');
  assert.ok(http.includes('preferenceShutdown.abort()') && http.includes('AbortSignal.any([controller.signal, preferenceShutdown.signal])'));
  assert.ok(transport.includes("rpc('/v2/preferences/append', parsed.data)") && !storage.includes('compareAndSet'));
});
test('unique immutable revision keys capture every current head and recheck baseline before storing, with explicit sibling conflict and no pruning or overwrite', async () => {
  const client = await file('src/host/preference-client.ts'), read = await file('src/shared/preference-protocol.ts');
  ordered(client.slice(client.indexOf('async #publish(')), 'await this.#reader.read()', 'fresh.serviceGeneration !== intent.outcome.serviceGeneration', 'fresh.identity !== base.identity', 'id: crypto.randomUUID()', 'parents: fresh.heads.map(', "[step]: 'storing'", 'await this.#set(request)', "[step]: 'stored'", 'after.conflict || after.heads[0]?.id !== event.id');
  assert.ok(read.includes('heads.length > 1') && client.includes("kind !== 'resolve'") && client.includes("!ledger.conflict || !branch"));
  assert.ok(!/storage\.delete|#delete|\.delete\(|setInterval|\.retry\(/.test(client));
});
test('known addition settles before source/version recheck and active persistence; missing/unknown/cancel cannot start dependent active step', async () => {
  const client = await file('src/host/preference-client.ts');
  const submit = client.slice(client.indexOf('async submit()'));
  ordered(submit, "#publish(intent, base, preferences, 'known')", 'this.#current(intent)', 'if (!intent.source)', 'await this.#inspect(', 'source.identity !== intent.source.identity', "#publish(intent, base, preferences, 'active')", "phase: 'succeeded'", 'await this.#activate(');
  assert.ok(client.includes("active: 'blocked'") && client.includes('CONFIRMATION_EXPIRED') && client.includes("[step]: 'unknown'"));
  assert.ok(client.includes('intent.cancelled') && client.includes('intent.epoch !== this.#epoch') && client.includes('60_000'));
});
test('only source schemas enter persisted revisions, with conservative budgets and original revision IDs/outcomes retained without replay on disposal', async () => {
  const client = await file('src/host/preference-client.ts'), protocol = await file('src/shared/preference-protocol.ts');
  assert.ok(protocol.includes('active: configSelectionSchema, known: z.array(configSelectionSchema).max(64)') && protocol.includes('schemaVersion: z.literal(1)'));
  assert.ok(client.includes('48_000') && client.includes('1_499_900') && client.includes('revisions.length >= 64'));
  assert.ok(client.includes('settled original storage result is recorded even after view cancellation/disposal') && client.includes('intent.outcome.revisions, event.id'));
  assert.ok(!/localStorage|console\.|clipboard|sendMessage|writeFile|service\/operations/.test(client));
});
test('startup restore is read-only and UI/SDK actions are explicit, project resets stop future steps and source form follows saved selection', async () => {
  const client = await file('src/host/preference-client.ts'), bridge = await file('src/host/bridge.ts'), panel = await file('src/panel/preference-view.ts');
  const read = client.slice(client.indexOf('async read('), client.indexOf('async prepare(')); assert.ok(!read.includes('#set(') && !read.includes('#publish('));
  assert.ok(bridge.includes('void preferences.read(true)') && bridge.includes('preferences.reset()') && bridge.includes('preferences.dispose()') && bridge.includes('sourceSelected(selection)'));
  assert.ok(panel.includes("preparePreference('resolve'") && panel.includes('submitPreference()') && panel.includes("variant: 'destructive'"));
  assert.ok(!/innerHTML|setInterval|localStorage/.test(panel));
});
test('read-only graph cannot reach preference controller/view; reader exposes only keys/get and never imports a writer', async () => {
  const reader = await file('src/host/preference-reader.ts'), boundaries = await file('scripts/check-static.ts');
  assert.ok(reader.includes('generation: () => Promise<string>') && reader.includes('get: (key: string, generation: string) => Promise<unknown>'));
  assert.ok(!/\.set\(|\.delete\(|preference-client|operations\//.test(reader));
  for (const name of ['preference-client', 'preference-view', 'preference-store', 'preference-transport']) assert.ok(boundaries.includes(name));
});
test('isolated preference publication is exclusive and immutable, with bounded directory reads, exact owned-stage cleanup and conservative post-publication unknown', async () => {
  const store = await file('src/service/adapters/preference-store.ts'), panel = await file('src/panel/preference-view.ts');
  ordered(store.slice(store.indexOf('async append(')), 'const existing = await get(event.id', 'projectPreferenceLedger(entries)', 'ledger.heads.map(', 'await directory(true', 'constants.O_EXCL', 'await handle.sync()', 'await beforePublish()', 'await link(temporary, destination)', 'published = true', 'await parent.sync()', 'published ? new BoundaryError(\'OPERATION_UNKNOWN\')', 'cleanOwnedStage(temporary, owned)');
  assert.ok(store.includes('++count > 128') && store.includes('0o700n') && store.includes('0o600n') && store.includes('stage.ino !== owned.ino'));
  assert.ok(!/\brename\(|\brm\(|recursive: true|chmod\(/.test(store));
  assert.ok(panel.includes('Preferences are shared by the same Server user') && panel.includes('removing a record does not delete files'));
});
