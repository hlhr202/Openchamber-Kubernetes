import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { contentManifest, inputFingerprint, manifestHash } from '../../scripts/build-input.ts';
import { exportCheckedGitInstall, gitInstallFiles, syncGitInstall } from '../../scripts/git-install.ts';

async function fixture() {
  const dir = await mkdtemp(resolve(tmpdir(), 'oc-git-install-'));
  const candidate = resolve(dir, 'candidate');
  const root = resolve(dir, 'checkout');
  const manifest = { name: 'fixture', version: '0.1.0', description: 'Fixture', license: 'MIT', type: 'module', engines: { node: '24.x' },
    openchamber: { contributes: { service: { entry: 'service/main.js' } } } };
  const rootManifest = JSON.stringify({ ...manifest, scripts: { build: 'retained' }, private: true });
  await mkdir(root);
  await mkdir(candidate);
  await writeFile(resolve(root, 'package.json'), rootManifest);
  await writeFile(resolve(candidate, 'package.json'), JSON.stringify(manifest));
  for (const location of [root, candidate]) await writeFile(resolve(location, 'LICENSE'), 'license');
  for (const path of gitInstallFiles) {
    const file = resolve(candidate, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `candidate: ${path}`);
  }
  return { dir, candidate, root, manifest, rootManifest };
}

test('Git install preparation exports exactly the release files; check detects drift without writing', async t => {
  const { dir, candidate, root, rootManifest } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prepared = await syncGitInstall(candidate, root, 'prepare');
  assert.deepEqual(prepared.files.map(file => file.path), [
    'THIRD_PARTY_NOTICES.txt', 'panel/icon.svg', 'panel/index.html', 'panel/main.css', 'panel/main.js', 'service/main.js',
  ]);
  assert.equal(await readFile(resolve(root, 'package.json'), 'utf8'), rootManifest);
  assert.deepEqual(await syncGitInstall(candidate, root, 'check'), prepared);
  const bundle = resolve(root, 'service/main.js');
  await writeFile(bundle, 'stale bundle');
  await assert.rejects(syncGitInstall(candidate, root, 'check'), /output differs from candidate: service\/main.js/);
  assert.equal(await readFile(bundle, 'utf8'), 'stale bundle');
  assert.deepEqual(await syncGitInstall(candidate, root, 'prepare'), prepared);
});

test('Git install preparation rejects manifest drift and unexpected candidate files before writing', async t => {
  const { dir, candidate, root, manifest, rootManifest } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ ...manifest, version: '0.2.0' }));
  await assert.rejects(syncGitInstall(candidate, root, 'prepare'), /Root manifest differs/);
  await writeFile(resolve(root, 'package.json'), rootManifest);
  await writeFile(resolve(candidate, 'extra.txt'), 'unexpected');
  await assert.rejects(syncGitInstall(candidate, root, 'prepare'), /Unexpected release candidate file set/);
  await assert.rejects(readFile(resolve(root, 'THIRD_PARTY_NOTICES.txt')), { code: 'ENOENT' });
});

test('Git install preparation refuses a symlink destination before replacing any file', async t => {
  const { dir, candidate, root } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const elsewhere = resolve(dir, 'elsewhere.js');
  await writeFile(elsewhere, 'untouched');
  await mkdir(resolve(root, 'service'));
  await symlink(elsewhere, resolve(root, 'service/main.js'));
  await assert.rejects(syncGitInstall(candidate, root, 'prepare'), /Expected a regular release file: service\/main.js/);
  assert.equal(await readFile(elsewhere, 'utf8'), 'untouched');
  await assert.rejects(readFile(resolve(root, 'THIRD_PARTY_NOTICES.txt')), { code: 'ENOENT' });
});

test('Host export needs a complete Docker receipt bound to unchanged source and candidate bytes', async t => {
  const { dir, candidate, root } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const folder of ['src', 'assets', 'scripts', 'tests', 'docs/baseline', '.build/reports', '.build/candidates']) {
    await mkdir(resolve(root, folder), { recursive: true });
  }
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'tsconfig.shared.json', 'tsconfig.service.json', 'tsconfig.panel.json', 'tsconfig.scripts.json']) {
    await writeFile(resolve(root, path), 'fixture');
  }
  const source = resolve(root, 'src/entry.ts');
  await writeFile(source, 'original source');
  const sourceFingerprint = await inputFingerprint(root);
  const files = await contentManifest(candidate);
  const contentSha256 = manifestHash(files);
  const candidateId = `m2-${manifestHash({ contentSha256, sourceFingerprint })}`;
  const directory = `.build/candidates/${candidateId}`;
  const target = resolve(root, directory);
  await rename(candidate, target);
  await writeFile(resolve(target, 'candidate.json'), JSON.stringify({ candidateId, contentSha256, sourceFingerprint, files }));
  const report = { platform: 'linux', scope: 'foundation-only-not-M2-complete', sourceFingerprint,
    candidate: { directory, candidateId, contentSha256, sourceFingerprint }, checked: ['typecheck', 'lint', 'test:readonly', 'check:baseline', 'build', 'check:static'] };
  const reportFile = resolve(root, '.build/reports/foundation.json');
  await assert.rejects(exportCheckedGitInstall(root, 'prepare'), /foundation report not found/);
  await writeFile(reportFile, JSON.stringify({ ...report, checked: ['build'] }));
  await assert.rejects(exportCheckedGitInstall(root, 'prepare'), /Incomplete Docker foundation report/);
  await writeFile(reportFile, JSON.stringify(report));
  await writeFile(source, 'changed source');
  await assert.rejects(exportCheckedGitInstall(root, 'prepare'), /Working tree changed/);
  await writeFile(source, 'original source');
  const bundle = resolve(target, 'service/main.js');
  await writeFile(bundle, 'tampered candidate');
  await assert.rejects(exportCheckedGitInstall(root, 'prepare'), /file hashes differ/);
  await assert.rejects(readFile(resolve(root, 'THIRD_PARTY_NOTICES.txt')), { code: 'ENOENT' });
  await writeFile(bundle, 'candidate: service/main.js');
  const exported = await exportCheckedGitInstall(root, 'prepare');
  assert.equal(exported.candidateId, candidateId);
  assert.deepEqual(await exportCheckedGitInstall(root, 'check'), exported);
});
