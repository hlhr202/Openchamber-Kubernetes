// Only synthetic service-input strings, health JSON and file-read callbacks. No environment/filesystem/SDK/CLI.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { discoverHelmRepositories } from '../../src/service/queries/helm-repository-discovery.ts';
import { createHelmRepositoryReader } from '../../src/service/queries/helm-repositories.ts';
import { HelmRepositoryClient, validateHelmRepositoryPage } from '../../src/host/helm-repository-client.ts';
import type { HelmRepositoryState } from '../../src/host/helm-repository-client.ts';
import { helmRepositoryPageSchema, helmRepositoryRequestSchema } from '../../src/shared/helm-repository-protocol.ts';
const environment = { home: '/synthetic/home', cwd: '/synthetic/service-package', platform: 'linux' };
const defaultBinding = { serviceGeneration: 's', projectId: 'p', selection: { mode: 'default' as const } };
const root = { protocol: 2, binding: defaultBinding, branch: { kind: 'repositories' } };
const signal = () => new AbortController().signal;
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;
const healthy = (generation = 's') => ({ status: 200, body: JSON.stringify({ protocol: 2, status: 'ready', serviceGeneration: generation, version: '0.1.0', compatibility: '2.5.1' }) });
const config = JSON.stringify({ apiVersion: 'v1', repositories: [{ name: 'sample', url: 'https://synthetic.invalid' }] });
test('Linux service defaults use HOME .config/.cache, without filesystem or Helm execution', () => {
  assert.deepEqual(discoverHelmRepositories(environment), { paths: { repositoryFile: '/synthetic/home/.config/helm/repositories.yaml', indexDirectory: '/synthetic/home/.cache/helm/repository' }, origins: { repositoryFile: 'platform-default', indexDirectory: 'platform-default' } });
});
test('macOS defaults are Library Preferences/Caches, not Linux dot directories', () => {
  assert.deepEqual(discoverHelmRepositories({ ...environment, platform: 'darwin' }).paths, { repositoryFile: '/synthetic/home/Library/Preferences/helm/repositories.yaml', indexDirectory: '/synthetic/home/Library/Caches/helm/repository' });
});
test('XDG config/cache roots independently append helm and override platform defaults on both targets', () => {
  for (const platform of ['linux', 'darwin']) {
    const value = discoverHelmRepositories({ ...environment, platform, xdgConfigHome: '/synthetic/config', xdgCacheHome: '/synthetic/cache' });
    assert.deepEqual(value.paths, { repositoryFile: '/synthetic/config/helm/repositories.yaml', indexDirectory: '/synthetic/cache/helm/repository' }); assert.deepEqual(value.origins, { repositoryFile: 'XDG_CONFIG_HOME', indexDirectory: 'XDG_CACHE_HOME' });
  }
});
test('HELM_CONFIG/CACHE_HOME are already Helm roots, not another helm subdirectory', () => {
  const value = discoverHelmRepositories({ ...environment, configHome: '/synthetic/custom', cacheHome: '/synthetic/cache', xdgConfigHome: '/ignored', xdgCacheHome: '/ignored' });
  assert.deepEqual(value.paths, { repositoryFile: '/synthetic/custom/repositories.yaml', indexDirectory: '/synthetic/cache/repository' }); assert.deepEqual(value.origins, { repositoryFile: 'HELM_CONFIG_HOME', indexDirectory: 'HELM_CACHE_HOME' });
});
test('exact repository overrides win independently, including when ignored HOME or lower-priority values are invalid', () => {
  const value = discoverHelmRepositories({ ...environment, home: '', repositoryConfig: '/synthetic/repos.yml', repositoryCache: '/synthetic/indexes', configHome: '\nignored', cacheHome: '\nignored' });
  assert.deepEqual(value.paths, { repositoryFile: '/synthetic/repos.yml', indexDirectory: '/synthetic/indexes' }); assert.deepEqual(value.origins, { repositoryFile: 'HELM_REPOSITORY_CONFIG', indexDirectory: 'HELM_REPOSITORY_CACHE' });
});
test('empty overrides fall through without whitespace trimming or inventing a missing source fallback', () => {
  assert.deepEqual(discoverHelmRepositories({ ...environment, repositoryConfig: '', repositoryCache: '', configHome: '', cacheHome: '', xdgConfigHome: '', xdgCacheHome: '' }).paths, discoverHelmRepositories(environment).paths);
  assert.equal(discoverHelmRepositories({ ...environment, repositoryConfig: '   ' }).paths.repositoryFile, '/synthetic/service-package/   ');
});
test('relative service path variables resolve against frozen service cwd, not project/browser cwd', () => {
  const value = discoverHelmRepositories({ ...environment, repositoryConfig: '../repos.yaml', repositoryCache: './cache/../indexes' });
  assert.deepEqual(value.paths, { repositoryFile: '/synthetic/repos.yaml', indexDirectory: '/synthetic/service-package/indexes' });
});
test('default discovery does not expand tilde, dollar variables or perform shell/user-database lookup', () => {
  const value = discoverHelmRepositories({ ...environment, repositoryConfig: '~/repos.yaml', repositoryCache: '$HOME/cache' });
  assert.equal(value.paths.repositoryFile, '/synthetic/service-package/~/repos.yaml'); assert.equal(value.paths.indexDirectory, '/synthetic/service-package/$HOME/cache');
});
test('malformed selected paths/cwd and unsupported platform fail fixed without printing values', () => {
  for (const change of [{ cwd: 'relative' }, { cwd: '//unc' }, { home: '' }, { repositoryConfig: '/synthetic/\nprivate' }, { repositoryCache: '/synthetic/\ud800' }, { configHome: 'x'.repeat(4097) }, { repositoryCache: 'C:\\secret' }]) assert.throws(() => discoverHelmRepositories({ ...environment, ...change }), fails('INVALID_INPUT'));
  assert.throws(() => discoverHelmRepositories({ ...environment, platform: 'win32' }), fails('CLI_INCOMPATIBLE'));
});
test('resolution returns immutable non-secret path metadata and changes neither inputs nor external state', () => {
  const value = discoverHelmRepositories(Object.freeze({ ...environment })); assert.ok(Object.isFrozen(value.paths)); assert.ok(Object.isFrozen(value.origins)); assert.ok(Object.isFrozen(value));
});
test('reader default mode is explicit, resolves lazily and HMAC-binds actual paths before any file request', async () => {
  let resolutions = 0; const calls: string[] = [], expected = discoverHelmRepositories(environment);
  const reader = createHelmRepositoryReader('s', async path => { calls.push(path); return { content: config, version: 'c1' }; }, () => { resolutions++; return expected; });
  try { assert.equal(resolutions, 0); assert.equal(calls.length, 0); const page = await reader.read(root, signal()); assert.equal(resolutions, 1); assert.deepEqual(page.resolvedSelection, expected.paths); assert.deepEqual(page.sourceOrigins, expected.origins); assert.deepEqual(calls, [expected.paths.repositoryFile, expected.paths.repositoryFile]); } finally { reader.close(); }
});
test('explicit paths bypass invalid or unavailable default resolution instead of blocking the service', async () => {
  const reader = createHelmRepositoryReader('s', async () => ({ content: config, version: 'c1' }), () => { throw new BoundaryError('INVALID_INPUT'); });
  try { const page = await reader.read({ ...root, binding: { ...defaultBinding, selection: { repositoryFile: '/synthetic/explicit.yaml', indexDirectory: '/synthetic/cache' } } }, signal()); assert.equal(page.sourceOrigins.repositoryFile, 'explicit');
    await assert.rejects(reader.read(root, signal()), fails('INVALID_INPUT'));
  } finally { reader.close(); }
});
test('missing default file is final and never probes alternate config locations or a CLI', async () => {
  const calls: string[] = [], reader = createHelmRepositoryReader('s', async path => { calls.push(path); return null; }, () => discoverHelmRepositories(environment));
  try { await assert.rejects(reader.read(root, signal()), fails('CONFIG_NOT_FOUND')); assert.deepEqual(calls, ['/synthetic/home/.config/helm/repositories.yaml']); } finally { reader.close(); }
});
test('same content/file stamp at different resolved default paths cannot reuse an old configuration identity', async () => {
  let home = environment.home; const reader = createHelmRepositoryReader('s', async () => ({ content: config, version: 'same' }), () => discoverHelmRepositories({ ...environment, home }));
  try { const first = await reader.read(root, signal()); home = '/synthetic/other';
    await assert.rejects(reader.read({ ...root, branch: { kind: 'charts', repository: 'sample', configurationId: first.configurationId } }, signal()), fails('STALE_TARGET'));
    assert.notEqual((await reader.read(root, signal())).configurationId, first.configurationId);
  } finally { reader.close(); }
});
test('new response requires resolved paths/origins, and old missing shapes do not silently acquire defaults', async () => {
  const reader = createHelmRepositoryReader('s', async () => ({ content: config, version: 'c1' }), () => discoverHelmRepositories(environment));
  try { const page = await reader.read(root, signal()); for (const change of [{ resolvedSelection: undefined }, { sourceOrigins: undefined }, { sourceOrigins: { repositoryFile: 'explicit', indexDirectory: 'explicit' } }]) assert.throws(() => validateHelmRepositoryPage({ ...page, ...change }, helmRepositoryRequestSchema.parse(root)));
    assert.equal(helmRepositoryPageSchema.safeParse({ ...page, sourceOrigins: undefined }).success, false);
  } finally { reader.close(); }
});
test('client construction does no health/file read; explicit connect checks health then reads without kubeconfig state', async () => {
  const reader = createHelmRepositoryReader('s', async () => ({ content: config, version: 'c1' }), () => discoverHelmRepositories(environment)), calls: string[] = [], states: HelmRepositoryState[] = [];
  const client = new HelmRepositoryClient(async request => { calls.push('files'); return { status: 200, body: JSON.stringify(await reader.read(JSON.parse(request.body) as unknown, signal())) }; }, state => states.push(state), async () => { calls.push('health'); return healthy(); });
  try { assert.equal(calls.length, 0); await client.connect({ mode: 'default' }, 'p'); assert.deepEqual(calls, ['health', 'files']); assert.equal(states.at(-1)?.phase, 'ready'); assert.equal(states.at(-1)?.page?.binding.serviceGeneration, 's'); } finally { client.dispose(); reader.close(); }
});
test('invalid selection or project is rejected before the independent health request', async () => {
  let calls = 0; const states: HelmRepositoryState[] = [], client = new HelmRepositoryClient(async () => { calls++; return { status: 200, body: '{}' }; }, state => states.push(state), async () => { calls++; return healthy(); });
  try { await client.connect({ mode: 'default', secret: 'SYNTHETIC' }, 'p'); assert.equal(states.at(-1)?.error, 'INVALID_INPUT'); await client.connect({ mode: 'default' }, '');
    await client.connect({ repositoryFile: '/synthetic/\ud800.yaml', indexDirectory: '/synthetic/cache' }, 'p'); assert.equal(states.at(-1)?.error, 'INVALID_INPUT'); assert.equal(calls, 0);
  } finally { client.dispose(); }
});
test('health auth/invalid/oversized/host failure cannot start a file read or reflect unknown diagnostics', async () => {
  for (const result of [{ status: 403, body: '{"error":{"code":"FORBIDDEN"}}' }, { status: 200, body: '{"token":"SYNTHETIC_PRIVATE"}' }, { status: 200, body: 'x'.repeat(4097) }, { status: 200, body: '{bad' }]) {
    let reads = 0; const states: HelmRepositoryState[] = [], client = new HelmRepositoryClient(async () => { reads++; return { status: 200, body: '{}' }; }, state => states.push(state), async () => result);
    try { await client.connect({ mode: 'default' }, 'p'); assert.equal(reads, 0); assert.equal(states.at(-1)?.phase, 'error'); assert.equal(JSON.stringify(states).includes('SYNTHETIC_PRIVATE'), false); } finally { client.dispose(); }
  }
});
test('health protocol and fixed host compatibility are validated before deriving service generation', async () => {
  for (const change of [{ protocol: 1 }, { compatibility: 'other' }, { status: 'starting' }, { serviceGeneration: '' }]) {
    let reads = 0; const client = new HelmRepositoryClient(async () => { reads++; return { status: 200, body: '{}' }; }, () => {}, async () => ({ status: 200, body: JSON.stringify({ ...JSON.parse(healthy().body), ...change }) }));
    try { await client.connect({ mode: 'default' }, 'p'); assert.equal(reads, 0); } finally { client.dispose(); }
  }
});
test('cancel/reset/dispose while health is pending prevents a late health response from reading any file', async () => {
  for (const action of ['cancel', 'reset', 'dispose'] as const) {
    const pending = Promise.withResolvers<{ status: number; body: string }>(); let reads = 0;
    const client = new HelmRepositoryClient(async () => { reads++; return { status: 200, body: '{}' }; }, () => {}, () => pending.promise);
    const read = client.connect({ mode: 'default' }, 'p'); client[action](); pending.resolve(healthy()); await read; assert.equal(reads, 0); client.dispose();
  }
});
test('new project/connect supersedes old pending health and only the new binding can reach files', async () => {
  const pending: Array<ReturnType<typeof Promise.withResolvers<{ status: number; body: string }>>> = [], projects: string[] = [];
  const client = new HelmRepositoryClient(async request => { const input = helmRepositoryRequestSchema.parse(JSON.parse(request.body) as unknown); projects.push(input.binding.projectId); return { status: 400, body: '{"error":{"code":"CONFIG_NOT_FOUND"}}' }; }, () => {}, () => { const item = Promise.withResolvers<{ status: number; body: string }>(); pending.push(item); return item.promise; });
  const old = client.connect({ mode: 'default' }, 'old'), current = client.connect({ mode: 'default' }, 'new'); pending[0]?.resolve(healthy('old-generation')); await old; assert.deepEqual(projects, []); pending[1]?.resolve(healthy()); await current; assert.deepEqual(projects, ['new']); client.dispose();
});
test('four unsettled health requests remain charged across reset and share admission with file requests', async () => {
  const pending: Array<ReturnType<typeof Promise.withResolvers<{ status: number; body: string }>>> = [], states: HelmRepositoryState[] = []; let reads = 0;
  const client = new HelmRepositoryClient(async () => { reads++; return { status: 200, body: '{}' }; }, state => states.push(state), () => { const item = Promise.withResolvers<{ status: number; body: string }>(); pending.push(item); return item.promise; });
  const waits: Promise<void>[] = []; for (let n = 0; n < 4; n++) { waits.push(client.connect({ mode: 'default' }, 'p')); client.reset(); }
  await client.read(root); assert.equal(reads, 0); assert.equal(states.at(-1)?.error, 'QUERY_LIMIT'); await client.connect({ mode: 'default' }, 'p'); assert.equal(pending.length, 4); client.dispose(); for (const item of pending) item.resolve(healthy()); await Promise.all(waits);
});
test('service restart between health and file response fails stale without an automatic health or file retry', async () => {
  const reader = createHelmRepositoryReader('new-service', async () => ({ content: config, version: 'c1' }), () => discoverHelmRepositories(environment)); let healthCalls = 0, fileCalls = 0; const states: HelmRepositoryState[] = [];
  const client = new HelmRepositoryClient(async request => { fileCalls++; try { return { status: 200, body: JSON.stringify(await reader.read(JSON.parse(request.body) as unknown, signal())) }; } catch (error) { return { status: 409, body: JSON.stringify({ error: { code: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' } }) }; } }, state => states.push(state), async () => { healthCalls++; return healthy('old-service'); });
  try { await client.connect({ mode: 'default' }, 'p'); assert.equal(states.at(-1)?.error, 'STALE_TARGET'); assert.equal(healthCalls, 1); assert.equal(fileCalls, 1); } finally { client.dispose(); reader.close(); }
});
test('independently observed new service generation clears old file bindings without requiring a new kubeconfig lookup', async () => {
  const reader = createHelmRepositoryReader('s', async () => ({ content: config, version: 'c1' }), () => discoverHelmRepositories(environment)), states: HelmRepositoryState[] = [];
  const client = new HelmRepositoryClient(async request => ({ status: 200, body: JSON.stringify(await reader.read(JSON.parse(request.body) as unknown, signal())) }), state => states.push(state), async () => healthy());
  try { await client.connect({ mode: 'default' }, 'p'); client.observeGeneration('s'); assert.equal(states.at(-1)?.phase, 'ready'); client.observeGeneration('new-service'); assert.equal(states.at(-1)?.phase, 'idle'); assert.equal(states.at(-1)?.page, undefined); } finally { client.dispose(); reader.close(); }
});
