// Pure synthetic version/index strings only. No Go/Helm execution, filesystem, SDK or operation imports.
import assert from 'node:assert/strict';
import test from 'node:test';
import { helmSearchVersion, compareHelmStableVersions } from '../../src/service/queries/helm-search-version.ts';
import { projectHelmIndex } from '../../src/service/queries/helm-repository-source.ts';
import { createHelmRepositoryReader } from '../../src/service/queries/helm-repositories.ts';
import { helmRepositoryRequestSchema } from '../../src/shared/helm-repository-protocol.ts';
import { validateHelmRepositoryPage } from '../../src/host/helm-repository-client.ts';
const index = (versions: string[]) => JSON.stringify({ apiVersion: 'v1', entries: { sample: versions.map(version => ({ name: 'sample', version, appVersion: 'synthetic', description: 'synthetic' })) } });
const labels = (versions: string[]) => projectHelmIndex(index(versions))[0]?.versions.map(row => row.version) ?? [];
test('Helm loose search fills missing minor/patch with zero, preserving original version spelling', () => {
  for (const value of ['1', '1.0', '1.0.0', 'v1', 'v1.0', 'v1.0.0']) assert.deepEqual(helmSearchVersion(value), [1n, 0n, 0n]);
  assert.deepEqual(labels(['v2', '1.2', '1']), ['v2', '1.2', '1']);
});
test('CoerceNewVersion allows numeric leading zeros and CalVer without octal or floating point', () => {
  assert.deepEqual(helmSearchVersion('v0002026.010.0025'), [2026n, 10n, 25n]); assert.deepEqual(helmSearchVersion('0001.0002'), [1n, 2n, 0n]);
  assert.deepEqual(helmSearchVersion('0'.repeat(200) + '1.0.0'), [1n, 0n, 0n]);
});
test('default >0.0.0 excludes all coerced zero spellings, even with build metadata', () => {
  for (const value of ['0', 'v0', '00.00', '0.0.0', 'v000.00.000+build.001']) assert.equal(helmSearchVersion(value), null);
  assert.deepEqual(helmSearchVersion('0.0.01'), [0n, 0n, 1n]);
});
test('all prereleases are excluded without enabling devel, including partial/CalVer/high version prereleases', () => {
  for (const value of ['1-alpha', '1.2-rc.1', 'v01.02.03-beta+build', '18446744073709551615.0.0-0', '0.0.1-0', '1.0.0--', '1.0.0-9999999999999999999999999999999999999']) assert.equal(helmSearchVersion(value), null);
});
test('build identifiers are accepted on partial/coerced versions but do not alter precedence', () => {
  for (const value of ['1+a', 'v01.00+000.abc-DEF', '1.0.0+01.002', '1.0.0+-']) assert.deepEqual(helmSearchVersion(value), [1n, 0n, 0n]);
  assert.deepEqual(labels(['1+z', '01.0.0+a', '1.0+001']), ['1+z', '01.0.0+a', '1.0+001']);
});
test('uint64 maximum is accepted exactly and each numeric component over maximum is excluded', () => {
  const max = '18446744073709551615', overflow = '18446744073709551616';
  assert.deepEqual(helmSearchVersion(`${max}.${max}.${max}`), [BigInt(max), BigInt(max), BigInt(max)]);
  assert.deepEqual(helmSearchVersion(`000${max}.0.0`), [BigInt(max), 0n, 0n]);
  for (const value of [`${overflow}.0.0`, `1.${overflow}.0`, `1.0.${overflow}`, `${'9'.repeat(21)}.0.0`]) assert.equal(helmSearchVersion(value), null);
});
test('numeric comparison stays exact above Number.MAX_SAFE_INTEGER and compares major/minor/patch in order', () => {
  assert.deepEqual(labels(['9007199254740992.0.0', '9007199254740993', '2.1.0', '2.0.999', '2.10.0', '2.1.1']), ['9007199254740993', '9007199254740992.0.0', '2.10.0', '2.1.1', '2.1.0', '2.0.999']);
});
test('v is optional lowercase only; whitespace, plus signs, ranges, coercion junk and extra segments are not trimmed', () => {
  for (const value of ['V1', '=1.2.3', '>=1', '+1', '-1', ' 1', '1 ', '\t1', '1\n', '1\r\n', '1.0.0.0', 'v', '1.', '.1', '1..2', '1.x', '1e2', '1_000', '1/2', '１.０.０', '1\u0000']) assert.equal(helmSearchVersion(value), null, JSON.stringify(value));
});
test('empty or unsafe metadata/pre identifiers never admit an otherwise stable version', () => {
  for (const value of ['1+', '1+a..b', '1+..', '1+a_b', '1+é', '1+a+b', '1-', '1-a..b', '1-01', '1.0.0-00.1']) assert.equal(helmSearchVersion(value), null, value);
});
test('bounded parser rejects over-256 input while accepting a 256-character valid original', () => {
  const original = `1+${'a'.repeat(254)}`; assert.equal(original.length, 256); assert.deepEqual(helmSearchVersion(original), [1n, 0n, 0n]); assert.equal(helmSearchVersion(original + 'a'), null);
});
test('returned numeric ranks are immutable, with no retained input object or external state', () => {
  const rank = helmSearchVersion('v01.002.0003'); assert.ok(rank); assert.ok(Object.isFrozen(rank)); assert.deepEqual(rank, [1n, 2n, 3n]);
});
test('descending rank comparator is antisymmetric, transitive and metadata-independent', () => {
  const ranks = [[0n, 0n, 1n], [1n, 0n, 0n], [1n, 2n, 3n], [1n, 10n, 0n], [18_446_744_073_709_551_615n, 0n, 0n]] as const;
  for (let a = 0; a < ranks.length; a++) for (let b = 0; b < ranks.length; b++) { const left = ranks[a], right = ranks[b]; assert.ok(left && right); assert.equal(compareHelmStableVersions(left, right), a === b ? 0 : a < b ? 1 : -1); }
});
test('generated bounded partial/coerced versions have the exact independent expected numeric rank', () => {
  for (let major = 0; major < 8; major++) for (let minor = 0; minor < 8; minor++) for (let patch = 0; patch < 4; patch++) {
    const expected = major || minor || patch ? [BigInt(major), BigInt(minor), BigInt(patch)] : null;
    assert.deepEqual(helmSearchVersion(`v000${major}.00${minor}.0${patch}+build.000`), expected);
  }
});
test('bad/overflow versions are excluded like fixed Helm search without hiding valid siblings', () => {
  assert.deepEqual(labels(['x.y.z', '1.2', '1+', '18446744073709551616', '3.0.0-beta', '2']), ['2', '1.2']);
  assert.deepEqual(labels(['x.y.z', '1-rc', '0', '18446744073709551616']), []);
});
test('equivalent distinct spellings retain separate original identities and deterministic input order at ties', () => {
  const originals = ['v01.2.03+z', '1.2.3+a', '1.2.3', '01.02.003']; assert.deepEqual(labels(originals), originals);
  assert.throws(() => labels(['1', '1']), /CONTENT_INVALID/); // Existing strict duplicate identity boundary is NOT relaxed.
});
test('structural/Unicode/size errors remain complete-index failures rather than skipped version compatibility errors', () => {
  for (const original of ['', '1'.repeat(257), '\ud800']) assert.throws(() => labels(['1.2.3', original]), /CONTENT_INVALID/);
});
test('strict page policy changes with the parser and old canonical-only responses are rejected', async () => {
  const binding = { serviceGeneration: 's', projectId: 'p', selection: { repositoryFile: '/synthetic/repos', indexDirectory: '/synthetic/cache' } }, input = { protocol: 2, binding, branch: { kind: 'repositories' } };
  const reader = createHelmRepositoryReader('s', async () => ({ content: '{"repositories":[]}', version: 'one' }));
  try { const page = await reader.read(input, new AbortController().signal); assert.equal(page.versionPolicy, 'helm-v3.19.0-semver-v3.4.0-stable-gt-zero'); assert.throws(() => validateHelmRepositoryPage({ ...page, versionPolicy: 'canonical-stable-gt-zero' }, helmRepositoryRequestSchema.parse(input)), /STATE_UNAVAILABLE/); } finally { reader.close(); }
});
test('coerced versions paginate as exact original labels, without normalizing or merging row IDs', async () => {
  const binding = { serviceGeneration: 's', projectId: 'p', selection: { repositoryFile: '/synthetic/repos', indexDirectory: '/synthetic/cache' } }, input = { protocol: 2, binding, branch: { kind: 'repositories' } };
  const reader = createHelmRepositoryReader('s', async path => ({ content: path.endsWith('-index.yaml') ? index(Array.from({ length: 101 }, (_, n) => `v01.0${n}`)) : '{"repositories":[{"name":"repo"}]}', version: 'one' }));
  try { const root = await reader.read(input, new AbortController().signal), charts = await reader.read({ ...input, branch: { kind: 'charts', repository: 'repo', configurationId: root.configurationId } }, new AbortController().signal);
    const request = { ...input, branch: { kind: 'versions', repository: 'repo', chart: 'sample', configurationId: charts.configurationId, indexId: charts.indexId } }, page = await reader.read(request, new AbortController().signal);
    assert.equal(page.total, 101); assert.equal(page.nextOffset, 100); assert.equal(page.nodes[0]?.label, 'v01.0100'); assert.equal(new Set(page.nodes.map(row => row.id)).size, 100);
    const last = await reader.read({ ...request, offset: 100, snapshotId: page.snapshotId }, new AbortController().signal); assert.equal(last.nodes[0]?.label, 'v01.00');
  } finally { reader.close(); }
});
