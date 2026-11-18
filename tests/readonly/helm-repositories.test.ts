// Synthetic file contents/DTOs only. Never real filesystem/HOME, Helm, SDK, HTTP runtime or operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { projectHelmIndex, projectHelmRepositories } from '../../src/service/queries/helm-repository-source.ts';
import { createHelmRepositoryReader } from '../../src/service/queries/helm-repositories.ts';
import { helmRepositoryRequestSchema } from '../../src/shared/helm-repository-protocol.ts';
import type { HelmRepositoryPage } from '../../src/shared/helm-repository-protocol.ts';
import { HelmRepositoryClient, validateHelmRepositoryPage } from '../../src/host/helm-repository-client.ts';
import type { HelmRepositoryState } from '../../src/host/helm-repository-client.ts';
const secret = 'SYNTHETIC_REPO_CREDENTIAL', signal = () => new AbortController().signal;
const binding = { serviceGeneration: 's', projectId: 'p', selection: { repositoryFile: '/synthetic/repositories.yaml', indexDirectory: '/synthetic/cache' } };
const root = { protocol: 2, binding, branch: { kind: 'repositories' } };
const config = (names = ['z-last', 'alpha']) => JSON.stringify({ apiVersion: 'v1', repositories: names.map(name => ({ name, url: `https://user:${secret}@synthetic.invalid/?token=${secret}`, username: secret, password: secret, keyFile: secret, cache: `/elsewhere/${secret}` })) });
const version = (value = '1.0.0', extra: Record<string, unknown> = {}) => ({ name: 'chart', version: value, appVersion: '1.2', description: 'synthetic\nsecond line', urls: [`https://synthetic.invalid/${secret}`], annotations: { private: secret }, ...extra });
const index = (versions: unknown[] = [version('1.0.0'), version('2.0.0'), version('3.0.0-beta.1'), version('0.0.0')]) => JSON.stringify({ apiVersion: 'v1', entries: { chart: versions }, annotations: { secret }, publicKeys: [secret] });
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;
function fixture() {
  const files = new Map<string, { content: string; version: string }>([[binding.selection.repositoryFile, { content: config(), version: 'c1' }], ['/synthetic/cache/alpha-index.yaml', { content: index(), version: 'i1' }]]), calls: string[] = [];
  let intercept: ((path: string) => void | Promise<void>) | undefined;
  const reader = createHelmRepositoryReader('s', async (path, limit) => { calls.push(path); assert.ok(limit === 1_000_000 || limit === 8_000_000); await intercept?.(path); return files.get(path) ?? null; });
  const charts = (page: HelmRepositoryPage) => ({ protocol: 2, binding, branch: { kind: 'charts', repository: 'alpha', configurationId: page.configurationId } });
  const versions = (page: HelmRepositoryPage) => ({ protocol: 2, binding, branch: { kind: 'versions', repository: 'alpha', chart: 'chart', configurationId: page.configurationId, indexId: page.indexId } });
  return { reader, files, calls, charts, versions, intercept(value: typeof intercept) { intercept = value; }, close() { reader.close(); } };
}
test('repository projection preserves source order and strips every credential/URL/path extension', () => {
  const names = projectHelmRepositories(config()); assert.deepEqual(names, ['z-last', 'alpha']); assert.equal(JSON.stringify(names).includes(secret), false); assert.ok(Object.isFrozen(names));
});
test('malformed/duplicate names and path traversal fail fixed without reflecting source or credentials', () => {
  for (const value of [config(['same', 'same']), config(['../escape']), config(['x/y']), '{bad', 'repositories: [!unreviewed value]', 'repositories: []\nrepositories: []', 'apiVersion: v2\nrepositories: []']) assert.throws(() => projectHelmRepositories(value), fails('CONTENT_INVALID'));
});
test('empty repository list is a real empty success rather than missing configuration', () => { assert.deepEqual(projectHelmRepositories(config([])), []); });
test('canonical index sorts stable versions descending, excludes prerelease/zero, and omits raw URLs/annotations', () => {
  const charts = projectHelmIndex(index()); assert.equal(charts[0]?.name, 'chart'); assert.deepEqual(charts[0]?.versions.map(row => row.version), ['2.0.0', '1.0.0']); assert.equal(JSON.stringify(charts).includes(secret), false); assert.ok(Object.isFrozen(charts[0]?.versions));
});
test('numeric version ordering is not lexical and canonical large integers do not lose precision', () => {
  assert.deepEqual(projectHelmIndex(index([version('1.10.0'), version('1.2.0'), version('9007199254740993.0.0'), version('9007199254740992.0.0')]))[0]?.versions.map(row => row.version), ['9007199254740993.0.0', '9007199254740992.0.0', '1.10.0', '1.2.0']);
});
test('chart names sort ASCII while displayed labels have no repository prefix or extra group', () => {
  const content = JSON.stringify({ apiVersion: 'v1', entries: { zebra: [version('1.0.0', { name: 'zebra' })], alpha: [version('1.0.0', { name: 'alpha' })] } });
  assert.deepEqual(projectHelmIndex(content).map(chart => chart.name), ['alpha', 'zebra']);
});
test('fixed Helm search accepts coerced stable versions and excludes malformed/overflow ones without losing valid rows', () => {
  assert.deepEqual(projectHelmIndex(index(['1', '1.2', '01.0.0', '1.0.0-01', '1.0.0+a..b', 'x.y.z', '9'.repeat(21) + '.0.0'].map(value => version(value))))[0]?.versions.map(row => row.version), ['1.2', '1', '01.0.0']);
});
test('duplicate exact version, mismatched chart name, non-string appVersion and malformed Unicode fail whole', () => {
  for (const versions of [[version(), version()], [version('1.0.0', { name: 'other' })], [version('1.0.0', { appVersion: 1.2 })], [version('1.0.0', { description: '\ud800' })], [version('1.0.0', { description: 'x'.repeat(8193) })]]) assert.throws(() => projectHelmIndex(index(versions)), fails('CONTENT_INVALID'));
});
test('source bytes and structural budgets reject unsafe documents, never silently truncate', () => {
  assert.throws(() => projectHelmRepositories(' '.repeat(1_000_001)), fails('BUDGET_EXCEEDED')); assert.throws(() => projectHelmIndex(' '.repeat(8_000_001)), fails('BUDGET_EXCEEDED'));
  assert.throws(() => projectHelmIndex('apiVersion: v1\nentries: &a {x: *a}')); assert.throws(() => projectHelmIndex('apiVersion: v1\nentries: {}\n---\nentries: {}'), fails('CONTENT_INVALID'));
});
test('reader construction does not read files and root request reads only explicitly selected configuration', async () => {
  const f = fixture(); try { assert.equal(f.calls.length, 0); const page = await f.reader.read(root, signal()); assert.deepEqual(page.nodes.map(row => row.label), ['z-last', 'alpha']); assert.deepEqual(f.calls, [binding.selection.repositoryFile, binding.selection.repositoryFile]); assert.equal(page.indexId, null); } finally { f.close(); }
});
test('explicit repository/chart reads use only joined <repo>-index.yaml and expose exact version tooltip metadata', async () => {
  const f = fixture(); try { const roots = await f.reader.read(root, signal()), charts = await f.reader.read(f.charts(roots), signal()), versions = await f.reader.read(f.versions(charts), signal());
    assert.equal(charts.nodes[0]?.label, 'chart'); assert.deepEqual(versions.nodes.map(row => row.label), ['2.0.0', '1.0.0']); const row = versions.nodes[0]; assert.ok(row?.kind === 'version'); assert.equal(row.tooltip, 'synthetic\nsecond line\nApp version: 1.2');
    assert.equal(JSON.stringify(versions).includes(secret), false); assert.ok(f.calls.every(path => path === binding.selection.repositoryFile || path === '/synthetic/cache/alpha-index.yaml')); assert.equal(Object.isFrozen(versions.binding.selection), true);
  } finally { f.close(); }
});
test('missing config and missing existing index are distinct and never trigger fallback/network/download', async () => {
  const f = fixture(); try { const roots = await f.reader.read(root, signal()); f.files.delete('/synthetic/cache/alpha-index.yaml'); await assert.rejects(f.reader.read(f.charts(roots), signal()), fails('HELM_INDEX_MISSING'));
    f.files.delete(binding.selection.repositoryFile); await assert.rejects(f.reader.read(root, signal()), fails('CONFIG_NOT_FOUND')); assert.equal(f.calls.some(path => path.includes(secret)), false);
  } finally { f.close(); }
});
test('config credential/source changes invalidate old repository selection even when displayed names do not change', async () => {
  const f = fixture(); try { const roots = await f.reader.read(root, signal()); f.files.set(binding.selection.repositoryFile, { content: config().replaceAll(secret, 'CHANGED'), version: 'c2' }); await assert.rejects(f.reader.read(f.charts(roots), signal()), fails('STALE_TARGET')); } finally { f.close(); }
});
test('configuration change during index read rejects rows before they can be shown', async () => {
  const f = fixture(); try { const roots = await f.reader.read(root, signal()); f.intercept(path => { if (path.endsWith('-index.yaml')) f.files.set(binding.selection.repositoryFile, { content: config(['alpha']), version: 'c2' }); }); await assert.rejects(f.reader.read(f.charts(roots), signal()), fails('STALE_TARGET')); } finally { f.close(); }
});
test('index content or metadata change invalidates an old chart version binding', async () => {
  const f = fixture(); try { const charts = await f.reader.read(f.charts(await f.reader.read(root, signal())), signal()); f.files.set('/synthetic/cache/alpha-index.yaml', { content: index(), version: 'i2' }); await assert.rejects(f.reader.read(f.versions(charts), signal()), fails('STALE_TARGET')); } finally { f.close(); }
});
test('project/service/path changes cannot reuse an old opaque snapshot identity', async () => {
  const f = fixture(); try { const roots = await f.reader.read(root, signal()), input = f.charts(roots); await assert.rejects(f.reader.read({ ...input, binding: { ...binding, projectId: 'other' } }, signal()), fails('STALE_TARGET')); await assert.rejects(f.reader.read({ ...root, binding: { ...binding, serviceGeneration: 'other' } }, signal()), fails('STALE_TARGET'));
    await assert.rejects(f.reader.read({ ...root, binding: { ...binding, selection: { ...binding.selection, indexDirectory: '/synthetic/../cache' } } }, signal()), fails('INVALID_INPUT'));
  } finally { f.close(); }
});
test('100-item pagination is snapshot-bound and cannot combine new versions with the old first page', async () => {
  const f = fixture(); try { f.files.set('/synthetic/cache/alpha-index.yaml', { content: index(Array.from({ length: 101 }, (_, n) => version(`1.0.${n}`))), version: 'i1' }); const roots = await f.reader.read(root, signal()), charts = await f.reader.read(f.charts(roots), signal()), input = f.versions(charts), first = await f.reader.read(input, signal());
    assert.equal(first.nodes.length, 100); assert.equal(first.nextOffset, 100); const next = { ...input, offset: 100, snapshotId: first.snapshotId }; const last = await f.reader.read(next, signal()); assert.equal(last.nodes.length, 1); assert.equal(last.nextOffset, null);
    f.files.set('/synthetic/cache/alpha-index.yaml', { content: index(), version: 'i2' }); await assert.rejects(f.reader.read(next, signal()), fails('STALE_TARGET'));
  } finally { f.close(); }
});
test('new service reader key cannot accept previous reader HMAC snapshots and never reveals raw file digest', async () => {
  const first = fixture(), second = fixture(); try { const roots = await first.reader.read(root, signal()); await assert.rejects(second.reader.read(first.charts(roots), signal()), fails('STALE_TARGET')); assert.match(roots.configurationId, /^helm-[a-f0-9]{64}$/); } finally { first.close(); second.close(); }
});
test('cancelled or closed readers reject without executing any new file read', async () => {
  const f = fixture(); try { const controller = new AbortController(); controller.abort(); await assert.rejects(f.reader.read(root, controller.signal), fails('QUERY_CANCELLED')); assert.equal(f.calls.length, 0); f.close(); await assert.rejects(f.reader.read(root, signal()), fails('SERVICE_CLOSED')); } finally { f.close(); }
});
test('request schema rejects traversal repository names, arbitrary commands/URLs, missing page snapshots and unknown fields', () => {
  for (const change of [{ branch: { kind: 'update' } }, { command: 'repo update' }, { url: `https://${secret}` }, { offset: 100 }, { binding: { ...binding, selection: { ...binding.selection, url: secret } } }]) assert.equal(helmRepositoryRequestSchema.safeParse({ ...root, ...change }).success, false);
});
test('client explicitly navigates repository/chart pages without opening a version leaf or Inspect/download', async () => {
  const f = fixture(), states: HelmRepositoryState[] = []; const client = new HelmRepositoryClient(async request => ({ status: 200, body: JSON.stringify(await f.reader.read(JSON.parse(request.body) as unknown, signal())) }), state => states.push(state));
  try { await client.read(root); const repo = states.at(-1)?.page?.nodes.find(row => row.label === 'alpha'); assert.ok(repo); await client.open(repo.id); const chart = states.at(-1)?.page?.nodes[0]; assert.ok(chart); await client.open(chart.id); assert.equal(states.at(-1)?.page?.branch.kind, 'versions'); const leaf = states.at(-1)?.page?.nodes[0]; assert.ok(leaf); const count = f.calls.length; await client.open(leaf.id); assert.equal(f.calls.length, count); await client.back(); assert.equal(states.at(-1)?.page?.branch.kind, 'charts'); } finally { client.dispose(); f.close(); }
});
test('client rejects foreign source, invalid row shape, pagination and raw error text without exposing originals', async () => {
  const f = fixture(); try { const page = await f.reader.read(root, signal()), request = helmRepositoryRequestSchema.parse(root);
    for (const change of [{ binding: { ...binding, projectId: 'other' } }, { total: 99 }, { indexId: page.configurationId }, { nodes: [{ ...page.nodes[0], password: secret }] }]) assert.throws(() => validateHelmRepositoryPage({ ...page, ...change }, request));
    const states: HelmRepositoryState[] = [], client = new HelmRepositoryClient(async () => ({ status: 500, body: JSON.stringify({ error: { code: 'unknown', message: secret } }) }), state => states.push(state)); await client.read(root); assert.equal(states.at(-1)?.error, 'STATE_UNAVAILABLE'); assert.equal(JSON.stringify(states).includes(secret), false); client.dispose();
  } finally { f.close(); }
});
test('client reset/cancel/dispose discard late pages; a new source cannot show old source rows as current', async () => {
  const f = fixture(); try { const page = await f.reader.read(root, signal()), pending = Promise.withResolvers<{ status: number; body: string }>(), states: HelmRepositoryState[] = [];
    const client = new HelmRepositoryClient(() => pending.promise, state => states.push(state)); const read = client.read(root); client.reset(); pending.resolve({ status: 200, body: JSON.stringify(page) }); await read; assert.equal(states.at(-1)?.phase, 'idle'); client.dispose();
  } finally { f.close(); }
});
test('client actual pending admissions remain charged across reset, never more than four requests', async () => {
  const waits: Array<ReturnType<typeof Promise.withResolvers<{ status: number; body: string }>>> = [], states: HelmRepositoryState[] = [];
  const client = new HelmRepositoryClient(() => { const wait = Promise.withResolvers<{ status: number; body: string }>(); waits.push(wait); return wait.promise; }, state => states.push(state));
  const reads: Promise<void>[] = []; for (let n = 0; n < 4; n++) { reads.push(client.read(root)); client.reset(); } await client.read(root); assert.equal(waits.length, 4); assert.equal(states.at(-1)?.error, 'QUERY_LIMIT'); client.dispose(); for (const wait of waits) wait.resolve({ status: 400, body: '{}' }); await Promise.all(reads);
});
test('filename cache association is explicitly unverified even after fresh config/index HMAC binding', async () => {
  const f = fixture(); try { const roots = await f.reader.read(root, signal()), charts = await f.reader.read(f.charts(roots), signal()); assert.equal(charts.provenance, 'filename-only-unverified-origin');
    assert.equal(charts.versionPolicy, 'helm-v3.19.0-semver-v3.4.0-stable-gt-zero'); assert.equal(JSON.stringify(charts).includes('https://'), false);
  } finally { f.close(); }
});
test('prerelease-only or empty index is genuinely empty, while unsupported API/duplicate YAML is an explicit failure', () => {
  assert.deepEqual(projectHelmIndex(index([version('1.0.0-beta')])), []); assert.deepEqual(projectHelmIndex('apiVersion: v1\nentries: {}'), []);
  for (const content of ['apiVersion: v2\nentries: {}', 'apiVersion: v1\nentries: {}\nentries: {}']) assert.throws(() => projectHelmIndex(content), fails('CONTENT_INVALID'));
});
