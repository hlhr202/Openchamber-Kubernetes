import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export async function filesBelow(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected link in controlled build inputs/outputs');
    if (entry.isDirectory()) result.push(...await filesBelow(path));
    else if (entry.isFile()) result.push(path);
    else throw new Error('Unexpected non-regular build input');
  }
  return result.sort();
}

export async function contentManifest(root: string) {
  const files = (await filesBelow(root)).filter(file => relative(root, file) !== 'candidate.json');
  return Promise.all(files.map(async file => {
    const bytes = await readFile(file);
    return { path: relative(root, file).split(sep).join('/'), bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
}

export async function inputFingerprint(root = process.cwd()): Promise<string> {
  const inputs = [
    ...await filesBelow(resolve(root, 'src')), ...await filesBelow(resolve(root, 'assets')), ...await filesBelow(resolve(root, 'scripts')), ...await filesBelow(resolve(root, 'tests')),
    ...(await filesBelow(resolve(root, 'docs/baseline'))).filter(file => file.endsWith('.json')),
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE',
    'tsconfig.base.json', 'tsconfig.shared.json', 'tsconfig.service.json', 'tsconfig.panel.json', 'tsconfig.scripts.json',
  ].map(file => relative(root, resolve(root, file)).split(sep).join('/')).sort();
  const hash = createHash('sha256');
  for (const file of inputs) hash.update(JSON.stringify([file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')]));
  return hash.digest('hex');
}

export function manifestHash(files: unknown): string {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
