// Host-side builtins only: freezes project SOURCE, then uses the already installed Compose CLI.
// No packages, tools, host configuration, credentials or product operations are installed/read/run here.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { filesBelow, inputFingerprint } from './build-input.ts';

const task = process.argv[2];
if (!task || !['typecheck', 'lint', 'test:readonly', 'check:baseline', 'build', 'build:development', 'bench:build', 'check:static', 'check:foundation', 'package:zip', 'clean'].includes(task) || process.argv.length !== 3) throw new Error('Select one bounded development check');
const root = process.cwd();
if (task === 'clean') {
  // Canonical .build hygiene, host-side only: caches (inputs/bench/development/staging) and
  // superseded generations (candidates/packages/reports) are deleted; the bound candidate,
  // its package, the pointer file and the regenerated reports stay. tests/fixtures is NOT
  // .build state and is never touched. rm never follows the snapshot symlinks.
  let keep: string | undefined;
  const pointer = JSON.parse(await readFile('.build/latest-candidate.json', 'utf8')) as { directory?: string };
  if (typeof pointer.directory === 'string' && /^\.build\/candidates\/m2-[a-f0-9]{64}$/.test(pointer.directory)) keep = pointer.directory.split('/').pop();
  if (keep === undefined) throw new Error('No valid .build/latest-candidate.json; refusing to clean candidates/packages');
  const wipe = async (directory: string, keepNames?: (name: string) => boolean) => {
    let entries: string[] = [];
    try { entries = await readdir(directory); } catch { return; } // absent = already clean
    for (const name of entries) {
      if (keepNames && keepNames(name)) continue;
      await rm(resolve(directory, name), { recursive: true, force: true });
    }
  };
  await wipe('.build/inputs');
  await wipe('.build/bench');
  await wipe('.build/development');
  await wipe('.build/staging');
  await wipe('.build/candidates', name => name === keep);
  await wipe('.build/packages', name => name === keep);
  await wipe('.build/reports', name => ['foundation.json', 'latest-package.json', 'latest-bench-build.json'].includes(name));
  console.log(`clean: kept candidate ${keep}; removed superseded snapshots, caches, generations and reports`);
  process.exit(0);
}
const fingerprint = await inputFingerprint();
const inputs = [
  ...await filesBelow('src'), ...await filesBelow('assets'), ...await filesBelow('scripts'), ...await filesBelow('tests'), ...await filesBelow('docs'),
  // Environment-definition files are frozen too so in-container checks/tests can verify pinned facts.
  ...['README.md', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'LICENSE', 'tsconfig.base.json', 'tsconfig.shared.json', 'tsconfig.service.json', 'tsconfig.panel.json', 'tsconfig.scripts.json', 'docker-compose.yml', 'docker/dev.Dockerfile'].map(file => resolve(file)),
].sort();
const captured = await Promise.all(inputs.map(async file => {
  const bytes = await readFile(file);
  return { path: relative(root, file), bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}));
const files = captured.map(({ path, bytes, sha256 }) => ({ path, bytes: bytes.length, sha256 }));
const snapshotId = createHash('sha256').update(JSON.stringify(files)).digest('hex');
const directory = resolve('.build/inputs', snapshotId);
await mkdir(directory, { recursive: true });
for (const file of captured) {
  const target = resolve(directory, file.path);
  await mkdir(resolve(target, '..'), { recursive: true });
  try { await writeFile(target, file.bytes, { flag: 'wx' }); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    if (!(await readFile(target)).equals(file.bytes)) throw new Error('Frozen source snapshot changed; refusing reuse');
  }
}
for (const [name, destination] of [['node_modules', '/workspace/node_modules'], ['.build', '/workspace/.build']] as const) {
  try { await symlink(destination, resolve(directory, name)); }
  catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error; }
}
await writeFile(resolve(directory, 'source-snapshot.json'), `${JSON.stringify({ snapshotId, sourceFingerprint: fingerprint, files }, null, 2)}\n`);
if (await inputFingerprint() !== fingerprint || await inputFingerprint(directory) !== fingerprint) throw new Error('Project changed while freezing source; check refused');
// The Docker endpoint stays explicitly pinned (never read from the host's Docker context config,
// which may carry logins). When the conventional /var/run/docker.sock is absent or dangling
// (for example the human-prepared daemon is exposed only at its own socket path), the operator
// passes K8S_DEVELOPMENT_DOCKER_HOST with an explicit unix:// endpoint for the same project daemon.
const dockerHost = process.env.K8S_DEVELOPMENT_DOCKER_HOST;
if (dockerHost !== undefined && !/^unix:\/\/\/.+$/.test(dockerHost)) throw new Error('K8S_DEVELOPMENT_DOCKER_HOST must be an explicit unix:// endpoint');
const status = await new Promise<number>((resolveStatus, reject) => {
  const child = spawn('/usr/local/bin/docker-compose', ['--env-file', '/dev/null', 'run', '--rm', '--no-deps', '--pull', 'never', 'dev', 'node', 'scripts/in-container.ts', task], {
    cwd: root, shell: false, stdio: 'inherit',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', DOCKER_CONFIG: '/var/empty', DOCKER_HOST: dockerHost ?? 'unix:///var/run/docker.sock', K8S_INPUT_SNAPSHOT: directory },
  });
  child.once('error', reject);
  child.once('exit', code => resolveStatus(code ?? 1));
});
if (await inputFingerprint() !== fingerprint) throw new Error('Source changed after the frozen check; result is stale');
process.exitCode = status;
