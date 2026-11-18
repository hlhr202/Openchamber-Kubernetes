import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { filesBelow, inputFingerprint, manifestHash } from './build-input.ts';

export const gitInstallFiles = Object.freeze([
  'THIRD_PARTY_NOTICES.txt', 'panel/icon.svg', 'panel/index.html', 'panel/main.css', 'panel/main.js', 'service/main.js',
]);
const candidateFiles = [...gitInstallFiles, 'LICENSE', 'package.json'].sort();
type InstallMode = 'prepare' | 'check';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function entry(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function regularFile(path: string): Promise<Buffer> {
  assert.ok((await entry(path))?.isFile(), `Expected a regular file: ${path}`);
  return readFile(path);
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object');
  return value as Record<string, unknown>;
}

function json(bytes: Buffer) { return object(JSON.parse(bytes.toString('utf8')) as unknown); }

function manifest(bytes: Buffer) {
  const { name, version, description, license, type, engines, openchamber } = json(bytes);
  assert.equal(typeof version, 'string', 'Expected an extension version');
  assert.equal(type, 'module');
  const { node } = object(engines);
  assert.equal(node, '24.x');
  return { name, version, description, license, type, engines: { node }, openchamber: object(openchamber) };
}

export async function syncGitInstall(candidate: string, root: string, mode: InstallMode, verified?: { readonly contentSha256: string; readonly sourceFingerprint: string; readonly files: unknown }) {
  const paths = (await filesBelow(candidate)).map(path => relative(candidate, path)).filter(path => path !== 'candidate.json');
  assert.deepEqual(paths, candidateFiles, 'Unexpected release candidate file set');
  const contents = await Promise.all(paths.map(async path => ({ path, bytes: await regularFile(resolve(candidate, path)) })));
  const entries = contents.map(({ path, bytes }) => ({ path, bytes: bytes.length, sha256: digest(bytes) }));
  if (verified) {
    assert.deepEqual(entries, verified.files, 'Release candidate file hashes differ from the verified metadata');
    assert.equal(manifestHash(entries), verified.contentSha256, 'Release candidate contents differ from the verified report');
  }
  const byPath = new Map(contents.map(({ path, bytes }) => [path, bytes]));
  function expected(path: string) {
    const bytes = byPath.get(path);
    assert.ok(bytes, `Missing candidate file: ${path}`);
    return bytes;
  }
  const rootManifest = await regularFile(resolve(root, 'package.json'));
  const rootFields = manifest(rootManifest);
  assert.deepEqual(rootFields, manifest(expected('package.json')), 'Root manifest differs from the release candidate');
  const license = await regularFile(resolve(root, 'LICENSE'));
  assert.ok(license.equals(expected('LICENSE')), 'Root LICENSE differs from the release candidate');
  const files = gitInstallFiles.map(path => ({ path, bytes: expected(path) }));
  const assertCurrentSource = async () => {
    if (verified) assert.equal(await inputFingerprint(root), verified.sourceFingerprint, 'Working tree changed; rerun the Docker foundation check');
  };
  const folders = ['panel', 'service'];
  for (const folder of folders) {
    const stat = await entry(resolve(root, folder));
    assert.ok(stat ? stat.isDirectory() : mode === 'prepare', `Expected a real ${folder}/ directory`);
  }
  // Check every destination before touching any. Rename replaces an existing regular
  // file without writing through a hard link. Never copy the production manifest over the source manifest.
  for (const { path } of files) {
    const stat = await entry(resolve(root, path));
    assert.ok(stat ? stat.isFile() : mode === 'prepare', `Expected a regular release file: ${path}`);
  }
  if (mode === 'prepare') {
    const buildRoot = resolve(root, '.build');
    const stagingRoot = resolve(root, '.build/staging');
    for (const dir of [buildRoot, stagingRoot]) {
      const stat = await entry(dir);
      if (stat) assert.ok(stat.isDirectory(), `Expected a real directory: ${dir}`);
      else await mkdir(dir);
    }
    const stage = await mkdtemp(resolve(stagingRoot, 'git-install-'));
    try {
      for (const { path, bytes } of files) {
        const target = resolve(stage, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: 'wx' });
      }
      await assertCurrentSource();
      for (const folder of folders) await mkdir(resolve(root, folder), { recursive: true });
      for (const { path } of files) await rename(resolve(stage, path), resolve(root, path));
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  for (const { path, bytes } of files) {
    assert.ok((await regularFile(resolve(root, path))).equals(bytes), `Git install output differs from candidate: ${path}`);
  }
  assert.ok((await regularFile(resolve(root, 'package.json'))).equals(rootManifest), 'Root manifest changed during Git install preparation');
  assert.ok((await regularFile(resolve(root, 'LICENSE'))).equals(license), 'Root LICENSE changed during Git install preparation');
  await assertCurrentSource();
  return { version: rootFields.version, files: entries.filter(({ path }) => path !== 'LICENSE' && path !== 'package.json') };
}

export async function exportCheckedGitInstall(root: string, mode: InstallMode) {
  for (const dir of ['.build', '.build/reports', '.build/candidates']) {
    assert.ok((await entry(resolve(root, dir)))?.isDirectory(), 'Docker foundation result not found; run check:foundation first');
  }
  const receiptPath = resolve(root, '.build/reports/foundation.json');
  assert.ok((await entry(receiptPath))?.isFile(), 'Docker foundation report not found; run check:foundation first');
  const report = json(await regularFile(receiptPath));
  assert.equal(report.platform, 'linux');
  assert.equal(report.scope, 'foundation-only-not-M2-complete');
  assert.deepEqual(report.checked, ['typecheck', 'lint', 'test:readonly', 'check:baseline', 'build', 'check:static'], 'Incomplete Docker foundation report');
  const { sourceFingerprint } = report;
  const { candidateId, directory, contentSha256, sourceFingerprint: reportedCandidateSource } = object(report.candidate);
  assert.ok(typeof sourceFingerprint === 'string' && /^[a-f0-9]{64}$/.test(sourceFingerprint));
  assert.ok(typeof contentSha256 === 'string' && /^[a-f0-9]{64}$/.test(contentSha256));
  assert.equal(reportedCandidateSource, sourceFingerprint, 'Docker foundation source fingerprint mismatch');
  assert.equal(candidateId, `m2-${manifestHash({ contentSha256, sourceFingerprint })}`, 'Docker foundation candidate identity mismatch');
  const expectedDirectory = `.build/candidates/${candidateId}`;
  assert.equal(directory, expectedDirectory, 'Docker foundation candidate path mismatch');
  assert.equal(await inputFingerprint(root), sourceFingerprint, 'Working tree changed; rerun the Docker foundation check');
  const candidate = resolve(root, expectedDirectory);
  assert.ok((await entry(candidate))?.isDirectory(), 'Expected a real release candidate directory');
  const metadata = json(await regularFile(resolve(candidate, 'candidate.json')));
  assert.deepEqual({ candidateId: metadata.candidateId, sourceFingerprint: metadata.sourceFingerprint, contentSha256: metadata.contentSha256 },
    { candidateId, sourceFingerprint, contentSha256 }, 'Candidate metadata differs from the Docker foundation report');
  return { candidateId, ...await syncGitInstall(candidate, root, mode, { contentSha256, sourceFingerprint, files: metadata.files }) };
}

if (import.meta.main) {
  const mode = process.argv[2];
  if ((mode !== 'prepare' && mode !== 'check') || process.argv.length !== 3) throw new Error('Select prepare or check');
  console.log(JSON.stringify({ ...await exportCheckedGitInstall(process.cwd(), mode), mode, runtime: 'not-executed' }));
}
