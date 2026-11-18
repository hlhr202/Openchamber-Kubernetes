import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { contentManifest, inputFingerprint, manifestHash } from './build-input.ts';
import { verifyPackage, verifySourceBoundaries } from './check-static.ts';
import { requireDevelopmentContainer } from './development.ts';
import { compileBundles, preparePackageAssets } from './compile.ts';

requireDevelopmentContainer();
const fingerprint = await inputFingerprint();
await verifySourceBoundaries();
const stage = resolve('.build/staging', randomUUID());
await compileBundles(stage, 'release');
await preparePackageAssets(stage);
await verifyPackage(stage);
if (await inputFingerprint() !== fingerprint) throw new Error('Source changed during build; staging preserved, candidate not published');
const files = await contentManifest(stage);
const contentSha256 = manifestHash(files);
const candidateId = `m2-${manifestHash({ contentSha256, sourceFingerprint: fingerprint })}`;
const metadata = { schemaVersion: 1, candidateId, contentSha256, sourceFingerprint: fingerprint, files, stage: 'foundation-only' };
await writeFile(resolve(stage, 'candidate.json'), `${JSON.stringify(metadata, null, 2)}\n`);
await mkdir('.build/candidates', { recursive: true });
const directory = `.build/candidates/${candidateId}`;
try { await rename(stage, directory); }
catch (error) {
  if (!(error instanceof Error) || !('code' in error) || !['EEXIST', 'ENOTEMPTY'].includes(String(error.code))) throw error;
  if (manifestHash(await contentManifest(directory)) !== contentSha256) throw new Error('Candidate identity collision; existing content preserved');
}
const pointer = `.build/latest-candidate-${randomUUID()}.json`;
await writeFile(pointer, `${JSON.stringify({ directory }, null, 2)}\n`);
await rename(pointer, '.build/latest-candidate.json');
console.log(JSON.stringify({ candidateId, directory, stage: 'foundation-only', sourceFingerprint: fingerprint, files: files.map(file => ({ path: file.path, bytes: file.bytes })) }));
