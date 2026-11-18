import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireDevelopmentContainer } from './development.ts';
import { testBatches } from './test-batches.ts';

requireDevelopmentContainer();
const suite = process.argv[2];
const mode = process.argv[3];
if ((suite !== 'readonly' && suite !== 'static') || (mode !== undefined && mode !== 'isolated') || process.argv.length > 4) throw new Error('Select a test suite and optional isolated comparison mode');
const { groups, isolated, sourceCount } = testBatches(suite);
const work = await mkdtemp(resolve(tmpdir(), 'oc-k8s-test-batch-'));
const started = performance.now();
try {
  const grouped = mode === 'isolated' ? groups.flat() : await Promise.all(groups.map(async (files, index) => {
    const batch = resolve(work, `${suite}-${index + 1}.test.mjs`);
    await writeFile(batch, files.map(file => `import ${JSON.stringify(pathToFileURL(resolve(file)).href)};`).join('\n'), { flag: 'wx' });
    return batch;
  }));
  const files = [...grouped, ...isolated];
  const status = await new Promise<number>((done, fail) => {
    const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', shell: false });
    child.once('error', fail);
    child.once('exit', code => done(code ?? 1));
  });
  console.log(JSON.stringify({ suite, mode: mode ?? 'batched', sourceFiles: sourceCount, runners: files.length, wallMs: Math.round(performance.now() - started), status }));
  process.exitCode = status;
} finally {
  await rm(work, { recursive: true, force: true });
}
