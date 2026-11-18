import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { contentManifest, manifestHash } from './build-input.ts';
import { compileBundles, preparePackageAssets } from './compile.ts';
import { verifyPackage } from './check-static.ts';
import { compileSampleSchema } from './benchmark-model.ts';
import { requireDevelopmentContainer } from './development.ts';

requireDevelopmentContainer();
const [kind, destination, countText] = process.argv.slice(2);
if (!['compile', 'typecheck'].includes(kind ?? '') || !destination || !/^\.build\/bench\/[a-f0-9-]{36}\/(cold-\d|warm|typecheck)$/.test(destination)
  || !/^[1-9]$/.test(countText ?? '') || process.argv.length !== 5) throw new Error('Invalid bounded benchmark worker arguments');
const count = Number(countText);
if (kind === 'compile') {
  const samples = [];
  for (let index = 0; index < count; index++) {
    const stage = resolve(destination, String(index));
    await mkdir(stage, { recursive: true });
    const start = performance.now();
    await compileBundles(stage, 'release');
    const compiled = performance.now();
    await preparePackageAssets(stage);
    const prepared = performance.now();
    await verifyPackage(stage);
    const verified = performance.now();
    const contentSha256 = manifestHash(await contentManifest(stage));
    const end = performance.now();
    samples.push(compileSampleSchema.parse({ compileMs: compiled - start, assetsMs: prepared - compiled, validationMs: verified - prepared, manifestMs: end - verified,
      processPeakRssBytes: process.resourceUsage().maxRSS * 1024, contentSha256 }));
  }
  console.log(JSON.stringify({ kind: 'compile', samples }));
} else {
  const samplesMs: number[] = [];
  for (let index = 0; index < count; index++) {
    const start = performance.now();
    const status = await new Promise<number>((resolveStatus, reject) => {
      // This invokes only the four whitelisted compiler configurations, never product modules.
      const child = spawn('node', ['scripts/typecheck.ts'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: 60_000 });
      let bytes = 0;
      for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > 128_000) child.kill('SIGTERM'); });
      child.once('error', reject);
      child.once('exit', code => resolveStatus(bytes > 128_000 ? 1 : code ?? 1));
    });
    if (status !== 0) throw new Error('Typecheck benchmark failed; no success report');
    samplesMs.push(performance.now() - start);
  }
  console.log(JSON.stringify({ kind: 'typecheck', samplesMs, controllerPeakRssBytes: process.resourceUsage().maxRSS * 1024, freshNativeProcessesPerSample: 4 }));
}
