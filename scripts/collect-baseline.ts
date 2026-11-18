// Public-source evidence only. Never imports downloaded code or inspects user configuration.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../tests/fixtures/baseline/', import.meta.url);
const sources = [
  { id: 'kubernetes', repo: 'vscode-kubernetes-tools/vscode-kubernetes-tools', tag: '1.4.1', commit: 'f54aef89a48c64e3df66af4a75cc5dd3d80f4a75' },
  { id: 'openchamber', repo: 'openchamber/openchamber', tag: 'v2.5.1', commit: '3e9ef4db17bd184f1f2713eb6356261304d6aee7' },
] as const;

async function download(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Public source HTTP ${response.status}: ${url}`);
  const content = await response.text();
  if (Buffer.byteLength(content) > 8_000_000) throw new Error('Evidence response exceeds budget');
  return content;
}

function selected(id: string, path: string): boolean {
  if (path === 'LICENSE' || path === 'package.json' || path === 'bun.lock') return true;
  if (id === 'kubernetes') return /^src\/.*\.ts$/.test(path)
    || ['src/components/logs/app/main.js', 'src/components/logs/app/index.html'].includes(path);
  return /^packages\/sdk\/(API\.md|GUEST_SERVICES\.md|LICENSE|package\.json|src\/.*\.ts|examples\/service-echo\/.*)$/.test(path)
    || /^packages\/web\/server\/lib\/guests\/[^/]+\.(js|md)$/.test(path)
    || /^packages\/electron\/[^/]*(package\.json|builder[^/]*|runtime[^/]*|main\.[^/]+)$/.test(path)
    || ['packages/web/package.json', 'packages/electron/package.json', 'packages/electron/entry.mjs', 'packages/ui/src/lib/guests/service.ts', 'packages/ui/src/lib/guests/host-bridge.ts', 'packages/ui/src/lib/guests/open-url.ts', 'packages/docs/content/docs/preview.mdx'].includes(path);
}

await mkdir(root, { recursive: true });
const records: Array<{ source: string; path: string; url: string; sha256: string; bytes: number }> = [];
for (const source of sources) {
  const refUrl = `https://api.github.com/repos/${source.repo}/git/ref/tags/${source.tag}`;
  const refText = await download(refUrl);
  const ref: unknown = JSON.parse(refText);
  if (typeof ref !== 'object' || ref === null || !('object' in ref)
    || typeof ref.object !== 'object' || ref.object === null || !('sha' in ref.object)
    || ref.object.sha !== source.commit) throw new Error(`Tag changed: ${source.id}`);
  await writeFile(new URL(`${source.id}-ref.json`, root), refText);
  const treeText = await download(`https://api.github.com/repos/${source.repo}/git/trees/${source.commit}?recursive=1`);
  const tree: { truncated: boolean; tree: Array<{ type: string; path: string; sha: string }> } = JSON.parse(treeText);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete public source tree');
  await writeFile(new URL(`${source.id}-tree.json`, root), treeText);
  const entries = tree.tree.filter(item => item.type === 'blob' && selected(source.id, item.path));
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      const path = entry?.path;
      if (!path || path.split('/').some(part => part === '..' || !/^[\w.@-]+$/.test(part))) throw new Error('Unsafe evidence path');
      const url = `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${path}`;
      const target = new URL(`${source.id}/${path}.txt`, root);
      let content: string;
      try { content = await readFile(target, 'utf8'); }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        content = await download(url);
        await mkdir(new URL('./', target), { recursive: true });
        await writeFile(target, content, { flag: 'wx' });
      }
      const blobHash = createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
      if (blobHash !== entry?.sha) throw new Error(`Evidence differs from pinned Git blob: ${source.id}/${path}`);
      records.push({ source: source.id, path, url, sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) });
    }
  }));
}
records.sort((a, b) => `${a.source}/${a.path}`.localeCompare(`${b.source}/${b.path}`, 'en'));
await writeFile(new URL('sources.json', root), `${JSON.stringify({ sources, records }, null, 2)}\n`);
const publicMetadata = [
  ['sdk-2.5.1', 'https://registry.npmjs.org/@openchamber%2fsdk/2.5.1'],
  ['typescript-7.0.2', 'https://registry.npmjs.org/typescript/7.0.2'],
  ['rolldown-1.2.15', 'https://registry.npmjs.org/rolldown/1.2.15'],
  ['oxlint-1.89.0', 'https://registry.npmjs.org/oxlint/1.89.0'],
  ['pnpm-12.15.0', 'https://registry.npmjs.org/pnpm/12.15.0'],
] as const;
for (const [id, url] of publicMetadata) {
  const content = await download(url);
  await writeFile(new URL(`${id}.json`, root), content);
}
const electronReleases: Array<{ version: string }> = JSON.parse(await download('https://releases.electronjs.org/releases.json'));
const electron = electronReleases.find(item => item.version === '44.9.3');
if (!electron) throw new Error('Pinned Electron release not found');
await writeFile(new URL('electron-44.9.3.json', root), `${JSON.stringify(electron, null, 2)}\n`);
console.log(JSON.stringify({ location: fileURLToPath(root), files: records.length, bytes: records.reduce((sum, item) => sum + item.bytes, 0) }));
