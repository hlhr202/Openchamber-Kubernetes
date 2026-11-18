import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { requireDevelopmentContainer } from './development.ts';
import { filesBelow, inputFingerprint } from './build-input.ts';

requireDevelopmentContainer();
const tasks: Readonly<Record<string, readonly string[]>> = {
  typecheck: ['node', 'scripts/typecheck.ts'],
  lint: ['node_modules/.bin/oxlint', '--deny-warnings', 'src', 'scripts', 'tests'],
  'test:readonly': ['node', 'scripts/run-tests.ts', 'readonly'],
  'check:baseline': ['node', 'scripts/run-tests.ts', 'static'],
  build: ['node', 'scripts/build.ts'],
  'build:development': ['node', 'scripts/build-development.ts'],
  'bench:build': ['node', 'scripts/bench-build.ts'],
  'check:static': ['node', 'scripts/check-static.ts'],
  'check:foundation': ['node', 'scripts/check-foundation.ts'],
  'package:zip': ['node', 'scripts/package-zip.ts'],
  'prepare:ui-refresh': ['node', 'scripts/prepare-ui-refresh-preview.ts'],
  'prepare:readme-screenshots': ['node', 'scripts/prepare-readme-screenshots.ts'],
};
const task = process.argv[2] ?? '';
const command = tasks[task];
if (!command?.[0] || process.argv.length !== 3) throw new Error('Unknown bounded engineering task');

let directory = process.env.OPENCHAMBER_K8S_SOURCE_SNAPSHOT;
let originalFingerprint: string | undefined;
if (!directory || process.cwd() !== directory || !/^\/tmp\/oc-k8s-check-[\w-]+$/.test(directory)) {
  originalFingerprint = await inputFingerprint();
  directory = await mkdtemp('/tmp/oc-k8s-check-');
  async function copyTree(source: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Unexpected source link; snapshot preparation refused');
      if (entry.isDirectory()) await copyTree(resolve(source, entry.name), resolve(destination, entry.name));
      else if (entry.isFile()) await writeFile(resolve(destination, entry.name), await readFile(resolve(source, entry.name)));
      else throw new Error('Non-regular source input');
    }
  }
  for (const folder of ['src', 'assets', 'scripts', 'tests', 'docs']) await copyTree(folder, resolve(directory, folder));
  for (const file of ['README.md', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'LICENSE', 'tsconfig.base.json', 'tsconfig.shared.json', 'tsconfig.service.json', 'tsconfig.panel.json', 'tsconfig.scripts.json', 'docker-compose.yml', 'docker/dev.Dockerfile']) {
    await mkdir(dirname(resolve(directory, file)), { recursive: true });
    await writeFile(resolve(directory, file), await readFile(file));
  }
  // Native tools see an immutable container-local source snapshot, not a mutable bind mount.
  await symlink('/workspace/node_modules', resolve(directory, 'node_modules'));
  await symlink('/workspace/.build', resolve(directory, '.build'));
  if (await inputFingerprint(directory) !== originalFingerprint || await inputFingerprint() !== originalFingerprint) {
    const differences: unknown[] = [];
    for (const folder of ['src', 'assets', 'scripts']) for (const file of await filesBelow(resolve(folder))) {
      const relative = file.slice(`${process.cwd()}/`.length);
      const source = await readFile(file), snapshot = await readFile(resolve(directory, relative));
      if (!source.equals(snapshot)) differences.push({ path: relative, sourceBytes: source.length, snapshotBytes: snapshot.length, sourceSha256: createHash('sha256').update(source).digest('hex'), snapshotSha256: createHash('sha256').update(snapshot).digest('hex') });
    }
    await mkdir('/workspace/.build/reports', { recursive: true });
    await writeFile('/workspace/.build/reports/snapshot-mismatch.json', JSON.stringify({ originalFingerprint, snapshotFingerprint: await inputFingerprint(directory), currentFingerprint: await inputFingerprint(), differences }, null, 2));
    throw new Error('Source changed during snapshot; check refused; hash-only report saved');
  }
}
const status = await new Promise<number>((resolveStatus, reject) => {
  // Bounded per-task ceilings keep every engineering command finite. 120s raced legitimate
  // full-suite durations (readonly ~115s, foundation ~150s+) and killed them silently via
  // SIGTERM -> exit(code ?? 1); the historical "intermittent silent container failure" was
  // this timer, so ceilings now match each task's bounded budget explicitly.
  const ceilings = { 'check:foundation': 360_000, 'test:readonly': 360_000, 'bench:build': 300_000 } as const;
  const timeout = ceilings[task as keyof typeof ceilings] ?? 180_000;
  const child = spawn(command[0] ?? '', command.slice(1), {
    cwd: directory, stdio: 'inherit', shell: false, timeout,
    env: {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/home/node',
      OPENCHAMBER_K8S_DEVELOPMENT: '1', OPENCHAMBER_K8S_SOURCE_SNAPSHOT: directory,
      XDG_CONFIG_HOME: '/home/node/.config', XDG_CACHE_HOME: '/home/node/.cache', XDG_DATA_HOME: '/home/node/.local/share',
      NPM_CONFIG_USERCONFIG: '/opt/npm-user.npmrc', NPM_CONFIG_GLOBALCONFIG: '/opt/npm-global.npmrc',
      COREPACK_ENABLE_NETWORK: '0', PNPM_CONFIG_PM_ON_FAIL: 'error', PNPM_CONFIG_RUNTIME_ON_FAIL: 'error',
    },
  });
  child.once('error', reject);
  child.once('exit', code => resolveStatus(code ?? 1));
});
process.exitCode = status;
if (originalFingerprint && await inputFingerprint() !== originalFingerprint) throw new Error('Source changed during engineering task; result is stale');
