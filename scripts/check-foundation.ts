import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { requireDevelopmentContainer } from './development.ts';
import { inputFingerprint } from './build-input.ts';
import { readonlyTestFiles } from './readonly-tests.ts';

requireDevelopmentContainer();
const stageWallMs: Record<string, number> = {};
async function run(name: string): Promise<void> {
  const commands: Readonly<Record<string, readonly string[]>> = {
    typecheck: ['node', 'scripts/typecheck.ts'],
    lint: ['node_modules/.bin/oxlint', '--deny-warnings', 'src', 'scripts', 'tests'],
    'test:readonly': ['node', 'scripts/run-tests.ts', 'readonly'],
    'check:baseline': ['node', 'scripts/run-tests.ts', 'static'],
    build: ['node', 'scripts/build.ts'],
    'check:static': ['node', 'scripts/check-static.ts'],
  };
  const command = commands[name];
  if (!command?.[0]) throw new Error('Unknown foundation check');
  const started = performance.now();
  const status = await new Promise<number>((resolve, reject) => {
    // Do not invoke a package-manager install/prepare path from a build/check snapshot.
    const child = spawn(command[0] ?? '', command.slice(1), { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  stageWallMs[name] = Math.round(performance.now() - started);
  if (status !== 0) throw new Error(`Foundation check failed: ${name}`);
}
const fingerprint = await inputFingerprint();
// Sequential execution: the parallel fan-out raced the container pid ceiling (typecheck's 4
// native tsc + two node --test runners + oxlint) and rejected spawn-side without a failed
// check; sequential runs keep every check finite under the same reviewed limits.
for (const name of ['typecheck', 'lint', 'test:readonly', 'check:baseline']) await run(name);
await run('build');
await run('check:static');
if (await inputFingerprint() !== fingerprint) throw new Error('Inputs changed during checks');
const pointer = z.object({ directory: z.string().regex(/^\.build\/candidates\/m2-[a-f0-9]{64}$/) }).strict().parse(JSON.parse(await readFile('.build/latest-candidate.json', 'utf8')) as unknown);
const candidate = z.object({ candidateId: z.string(), contentSha256: z.string(), sourceFingerprint: z.literal(fingerprint) }).parse(JSON.parse(await readFile(`${pointer.directory}/candidate.json`, 'utf8')) as unknown);
await mkdir('.build/reports', { recursive: true });
const stage = `.build/reports/foundation-${randomUUID()}.json`;
await writeFile(stage, `${JSON.stringify({ sourceFingerprint: fingerprint, candidate: { directory: pointer.directory, ...candidate }, readonlyTestFiles, stageWallMs, platform: process.platform, architecture: process.arch, node: process.versions.node, checked: ['typecheck', 'lint', 'test:readonly', 'check:baseline', 'build', 'check:static'], notExecuted: ['visual', 'host-integration', 'operations', 'sessions', 'native-macos'], scope: 'foundation-only-not-M2-complete' }, null, 2)}\n`, { flag: 'wx' });
await rename(stage, '.build/reports/foundation.json');
console.log(JSON.stringify({ stageWallMs }));
