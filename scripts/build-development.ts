import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { contentManifest, inputFingerprint, manifestHash } from './build-input.ts';
import { verifyDevelopmentPackage, verifySourceBoundaries } from './check-static.ts';
import { compileBundles, preparePackageAssets } from './compile.ts';
import { requireDevelopmentContainer } from './development.ts';

requireDevelopmentContainer();
const sourceFingerprint = await inputFingerprint();
await verifySourceBoundaries();
const directory = `.build/development/${randomUUID()}`;
await mkdir(directory, { recursive: true });
await compileBundles(resolve(directory), 'development');
await preparePackageAssets(resolve(directory));
await verifyDevelopmentPackage(directory);
if (await inputFingerprint() !== sourceFingerprint) throw new Error('Inputs changed during development build');
const files = await contentManifest(directory);
await writeFile(`${directory}/development.json`, `${JSON.stringify({ profile: 'development', sourceFingerprint, contentSha256: manifestHash(files), files,
  installCandidate: false, watch: 'not-enabled-experimental-api-review', runtime: 'not-executed' }, null, 2)}\n`);
console.log(JSON.stringify({ directory, profile: 'development', installCandidate: false, sourcemaps: true, minified: false }));
