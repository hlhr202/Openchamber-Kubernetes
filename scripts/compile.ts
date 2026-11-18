import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, VERSION } from 'rolldown';
import type { BuildOptions } from 'rolldown';
import { z } from 'zod';
import { requireDevelopmentContainer } from './development.ts';

export type BuildProfile = 'release' | 'development';
export const bundledDependencies = Object.freeze(['@openchamber/sdk', 'zod', 'yaml', '@xterm/xterm', '@xterm/addon-serialize']);
export const panelAssets = Object.freeze(['index.html', 'main.css', 'icon.svg']);
const packageSchema = z.object({ name: z.string(), version: z.string(), description: z.string(), license: z.string(), openchamber: z.unknown() });

async function sourceManifest() {
  return packageSchema.parse(JSON.parse(await readFile('package.json', 'utf8')) as unknown);
}

export function developmentSourcePath(source: string, mapPath: string, root: string): string {
  const absolute = resolve(dirname(mapPath), source);
  const dependency = absolute.lastIndexOf('/node_modules/');
  if (dependency >= 0) return `dependencies/${absolute.slice(dependency + '/node_modules/'.length)}`;
  const local = relative(root, absolute);
  if (!local.startsWith('src/') || local.includes('..')) throw new Error('Source map outside reviewed source/dependency roots');
  return `project/${local}`;
}

// Single source of browser/service options. No product module is imported or evaluated.
export function bundleConfigurations(stage: string, profile: BuildProfile, version: string, root = process.cwd()): readonly BuildOptions[] {
  const development = profile === 'development';
  return [
    { cwd: root, input: 'src/panel/entry.ts', platform: 'browser', transform: { target: 'es2022' },
      output: { file: resolve(stage, 'panel/main.js'), format: 'iife', codeSplitting: false, minify: !development, sourcemap: development,
        ...(development ? { sourcemapPathTransform: (source: string, map: string) => developmentSourcePath(source, map, root) } : {}) } },
    { cwd: root, input: 'src/service/runtime/main.ts', platform: 'node', external: id => id.startsWith('node:'),
      transform: { target: 'node24', define: { __K8S_EXTENSION_VERSION__: JSON.stringify(version) } },
      output: { file: resolve(stage, 'service/main.js'), format: 'esm', minify: !development, sourcemap: development,
        ...(development ? { sourcemapPathTransform: (source: string, map: string) => developmentSourcePath(source, map, root) } : {}) } },
  ];
}

export async function compileBundles(stage: string, profile: BuildProfile): Promise<void> {
  requireDevelopmentContainer();
  if (VERSION !== '1.2.15') throw new Error('Pinned Rolldown version mismatch; no replacement is downloaded');
  await mkdir(resolve(stage, 'panel'), { recursive: true });
  await mkdir(resolve(stage, 'service'), { recursive: true });
  // Both targets are finite and independent; at most two native builds run concurrently.
  await Promise.all(bundleConfigurations(stage, profile, (await sourceManifest()).version).map(options => build(options)));
}

export async function preparePackageAssets(stage: string): Promise<void> {
  await mkdir(resolve(stage, 'panel'), { recursive: true });
  for (const file of panelAssets) await copyFile(`assets/panel/${file}`, resolve(stage, 'panel', file));
  const terminalCss = resolve(dirname(fileURLToPath(import.meta.resolve('@xterm/xterm'))), '../css/xterm.css');
  await writeFile(resolve(stage, 'panel/main.css'), `${await readFile('assets/panel/main.css', 'utf8')}\n${await readFile(terminalCss, 'utf8')}`);
  await copyFile('LICENSE', resolve(stage, 'LICENSE'));
  const source = await sourceManifest();
  await writeFile(resolve(stage, 'package.json'), `${JSON.stringify({ ...source, type: 'module', engines: { node: '24.x' } }, null, 2)}\n`);
  let notices = 'Bundled runtime dependencies; toolchain dependencies are not distributed.\n\n';
  for (const name of bundledDependencies) {
    // addon-serialize 0.14.0's published tarball omits LICENSE. The audited
    // repository-root license at its exact npm gitHead is a fingerprinted asset.
    if (name === '@xterm/addon-serialize') {
      notices += `${name}\n${await readFile('assets/third-party/xterm-addon-serialize-LICENSE.txt', 'utf8')}\n\n`;
      continue;
    }
    let directory = dirname(fileURLToPath(import.meta.resolve(name)));
    let found = false;
    for (let depth = 0; depth < 6 && directory.includes('/node_modules/'); depth++, directory = dirname(directory)) {
      try {
        const pkg: unknown = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
        if (typeof pkg !== 'object' || pkg === null || !('name' in pkg) || pkg.name !== name) continue;
        notices += `${name}\n${await readFile(resolve(directory, 'LICENSE'), 'utf8')}\n\n`;
        found = true;
        break;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
    }
    if (!found) throw new Error(`Missing bundled dependency notice: ${name}`);
  }
  await writeFile(resolve(stage, 'THIRD_PARTY_NOTICES.txt'), notices);
}
