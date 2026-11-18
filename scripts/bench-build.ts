import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, machine, release, totalmem } from 'node:os';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import { inputFingerprint, manifestHash } from './build-input.ts';
import { summarizeSamples, workerReportSchema } from './benchmark-model.ts';
import { verifySourceBoundaries } from './check-static.ts';
import { requireDevelopmentContainer } from './development.ts';
import { inspectWatchContract } from './toolchain-contract.ts';

requireDevelopmentContainer();
const sourceFingerprint = await inputFingerprint();
await verifySourceBoundaries();
const runId = randomUUID(), directory = `.build/bench/${runId}`, count = 5;
await mkdir(directory, { recursive: true });
const versionSchema = z.object({ version: z.string() });
const versions: Record<string, string> = {};
for (const name of ['rolldown', 'typescript', 'oxlint']) {
  versions[name] = versionSchema.parse(JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')) as unknown).version;
}
assert.deepEqual(versions, { rolldown: '1.2.15', typescript: '7.0.2', oxlint: '1.89.0' });

async function worker(kind: 'compile' | 'typecheck', label: string, samples: number) {
  const start = performance.now();
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn('node', ['scripts/bench-worker.ts', kind, `${directory}/${label}`, String(samples)], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: 90_000 });
    let text = '', bytes = 0, overflow = false;
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes <= 128_000) text += chunk.toString('utf8'); else { overflow = true; child.kill('SIGTERM'); } });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > 128_000) { overflow = true; child.kill('SIGTERM'); } });
    child.once('error', reject);
    child.once('exit', code => code === 0 && !overflow ? resolveOutput(text.trim()) : reject(new Error(`Bounded ${kind} benchmark worker failed; artifacts retained`)));
  });
  return { wallMs: performance.now() - start, report: workerReportSchema.parse(JSON.parse(output) as unknown) };
}

// Process-cold is NOT OS-cache-cold. No privileged cache flushing or hidden install occurs.
const cold = [];
for (let index = 0; index < count; index++) cold.push(await worker('compile', `cold-${index}`, 1));
const warm = await worker('compile', 'warm', count);
const typecheck = await worker('typecheck', 'typecheck', count);
const coldSamples = cold.map(result => {
  assert.equal(result.report.kind, 'compile');
  if (result.report.kind !== 'compile' || !result.report.samples[0]) throw new Error('Missing cold sample');
  return result.report.samples[0];
});
if (warm.report.kind !== 'compile' || typecheck.report.kind !== 'typecheck') throw new Error('Unexpected benchmark result kind');
const all = [...coldSamples, ...warm.report.samples];
assert.equal(new Set(all.map(sample => sample.contentSha256)).size, 1, 'Benchmark outputs differ for the same release inputs');
const sizes = [];
for (const path of ['panel/main.js', 'service/main.js']) {
  const bytes = await readFile(`${directory}/cold-0/0/${path}`);
  sizes.push({ path, rawBytes: bytes.byteLength, gzipBytes: gzipSync(bytes, { level: 9 }).byteLength, brotliBytes: brotliCompressSync(bytes).byteLength });
}
async function cgroupValue(path: string): Promise<string | null> {
  try { return (await readFile(path, 'utf8')).trim(); }
  catch (error) { if (error instanceof Error && 'code' in error && ['ENOENT', 'EACCES'].includes(String(error.code))) return null; throw error; }
}
const memoryPeak = await cgroupValue('/sys/fs/cgroup/memory.peak');
const lockSha256 = createHash('sha256').update(await readFile('pnpm-lock.yaml')).digest('hex');
const cacheKey = manifestHash({ sourceFingerprint, node: process.versions.node, versions, lockSha256, platform: process.platform, architecture: process.arch, profile: 'release-browser-es2022-iife-service-node24-esm-minified-no-maps' });
if (await inputFingerprint() !== sourceFingerprint) throw new Error('Inputs changed during benchmark; no success report');
const report = {
  schemaVersion: 1, runId, sourceFingerprint, cacheKey, lockSha256, versions: { node: process.versions.node, ...versions },
  execution: { platform: process.platform, architecture: process.arch, kernel: release(), machine: machine(), visibleCpuModel: cpus()[0]?.model ?? null,
    visibleLogicalCpus: cpus().length, availableParallelism: availableParallelism(), visibleTotalMemoryBytes: totalmem(),
    cgroupCpuMax: await cgroupValue('/sys/fs/cgroup/cpu.max'), cgroupMemoryMax: await cgroupValue('/sys/fs/cgroup/memory.max') },
  conditions: { profile: 'release', minified: true, sourcemaps: false, concurrentTargets: 2, samples: count,
    dependencyPreparation: 'excluded-existing-frozen-dependencies-no-install', osCaches: 'not-flushed-uncontrolled', persistentBundlerCache: false,
    warmMeaning: 'same Node process; independent stable build() calls, NOT incremental rebuild', typecheckMeaning: 'four fresh native tsc processes per sample; no compiler reuse/incremental cache' },
  compilation: { processColdCompileMs: summarizeSamples(coldSamples.map(sample => sample.compileMs)), processColdWholeWorkerMs: summarizeSamples(cold.map(sample => sample.wallMs)),
    sameProcessCompileMs: summarizeSamples(warm.report.samples.map(sample => sample.compileMs)),
    processColdPeakRssBytes: summarizeSamples(coldSamples.map(sample => sample.processPeakRssBytes)),
    sameProcessCumulativePeakRssBytes: summarizeSamples(warm.report.samples.map(sample => sample.processPeakRssBytes)) },
  packagePreparation: { assetsMs: summarizeSamples(all.map(sample => sample.assetsMs)), validationMs: summarizeSamples(all.map(sample => sample.validationMs)), manifestMs: summarizeSamples(all.map(sample => sample.manifestMs)) },
  typecheck: { firstSampleMs: typecheck.report.samplesMs[0], repeats: summarizeSamples(typecheck.report.samplesMs), controllerPeakRssBytes: typecheck.report.controllerPeakRssBytes, nativeChildPeakRssBytes: null,
    childMemoryNote: 'controller RSS excludes native compiler children; container memory.peak below covers the whole check container including source snapshots/page cache' },
  containerMemoryPeakBytes: memoryPeak && /^\d+$/.test(memoryPeak) ? Number(memoryPeak) : null,
  sizes, contentSha256: coldSamples[0]?.contentSha256,
  watch: { measured: false, contract: await inspectWatchContract(), reason: 'Pinned rolldown 1.2.15 watch() is explicitly @experimental; stable-contract review required; no substitute loop is called incremental watch' },
  notExecuted: ['product service', 'plugin installation', 'authentication', 'operations', 'sessions', 'visual', 'macos-native', 'ZIP reproducibility'],
};
await writeFile(`${directory}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
await mkdir('.build/reports', { recursive: true });
const pointer = `.build/reports/bench-build-${runId}.json`;
await writeFile(pointer, `${JSON.stringify({ directory, report: `${directory}/report.json`, sourceFingerprint }, null, 2)}\n`);
await rename(pointer, '.build/reports/latest-bench-build.json');
console.log(JSON.stringify({ report: `${directory}/report.json`, sourceFingerprint, samples: count, coldCompileMedianMs: report.compilation.processColdCompileMs.median,
  sameProcessCompileMedianMs: report.compilation.sameProcessCompileMs.median, typecheckMedianMs: report.typecheck.repeats.median, watch: 'not-measured-pending-stability-review' }));
