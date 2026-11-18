// Fixed public source TEXT only; never loads downloaded modules or reads host/project credentials.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const commit = '3e9ef4db17bd184f1f2713eb6356261304d6aee7', repo = 'openchamber/openchamber';
const tree = JSON.parse(await readFile(new URL('../tests/fixtures/baseline/openchamber-tree.json', import.meta.url), 'utf8')) as { sha: string; truncated: boolean; tree: { path: string; type: string; sha: string }[] };
if (tree.sha !== commit || tree.truncated) throw new Error('Wrong or incomplete fixed public source tree');
const paths = ['packages/ui/src/lib/guests/files.ts', 'packages/ui/src/components/layout/GuestHosts.tsx', 'packages/ui/src/components/layout/PluginPane.tsx',
  'packages/web/server/lib/opencode/project-directory-runtime.js', 'packages/web/server/index.js'];
const root = new URL('../tests/fixtures/contracts/workspace-contract/', import.meta.url); await mkdir(root, { recursive: true });
const records = [];
for (const path of paths) {
  const entry = tree.tree.find(entry => entry.path === path && entry.type === 'blob'); if (!entry) throw new Error('Missing frozen public source');
  const target = new URL(`${path}.txt`, root), url = `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;
  let content: string;
  try { content = await readFile(target, 'utf8'); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) }); if (!response.ok) throw new Error(`Public source HTTP ${response.status}`);
    content = await response.text(); if (Buffer.byteLength(content) > 2_000_000) throw new Error('Source text budget');
    const blob = createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex'); if (blob !== entry.sha) throw new Error('Pinned Git blob mismatch');
    await mkdir(new URL('./', target), { recursive: true }); await writeFile(target, content, { flag: 'wx' });
  }
  if (createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex') !== entry.sha) throw new Error('Saved text differs from fixed source');
  records.push({ path, url, gitBlob: entry.sha, sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) });
}
const manifest = { repo, commit, records }; await writeFile(new URL('../docs/baseline/workspace-sources.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ files: records.length, bytes: records.reduce((sum, record) => sum + record.bytes, 0), scope: 'fixed-public-text-only' }));
