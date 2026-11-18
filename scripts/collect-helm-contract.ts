// Public pinned text only. Never installs or invokes Helm, reads HOME, or refreshes a repository.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const repo = 'helm/helm', tag = 'v3.19.0'; // File-format/source audit, NOT an approved runtime/CLI support matrix.
const paths = ['pkg/repo/repo.go', 'pkg/repo/index.go', 'pkg/repo/chartrepo.go', 'cmd/helm/search_repo.go', 'cmd/helm/search/search.go', 'pkg/cli/environment.go', 'pkg/helmpath/home.go', 'pkg/helmpath/lazypath.go', 'pkg/helmpath/lazypath_darwin.go', 'pkg/helmpath/lazypath_unix.go', 'pkg/helmpath/xdg/xdg.go'];
const output = new URL('../docs/baseline/helm-sources.json', import.meta.url), root = new URL('../tests/fixtures/contracts/helm-contract/', import.meta.url);
const get = async (url: string) => {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Public Helm contract HTTP ${response.status}`);
  const text = await response.text(); if (Buffer.byteLength(text) > 2_000_000) throw new Error('Public Helm source too large'); return text;
};
let object = (JSON.parse(await get(`https://api.github.com/repos/${repo}/git/ref/tags/${tag}`)) as { object: { type: string; sha: string } }).object;
for (let n = 0; object.type === 'tag' && n < 3; n++) object = (JSON.parse(await get(`https://api.github.com/repos/${repo}/git/tags/${object.sha}`)) as { object: typeof object }).object;
if (object.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('Exact Helm commit required');
const commit = object.sha, tree = JSON.parse(await get(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`)) as { truncated: boolean; tree: Array<{ path: string; sha: string }> };
if (tree.truncated) throw new Error('Incomplete public Helm tree');
try { const old = JSON.parse(await readFile(output, 'utf8')) as { records: Array<{ path: string; commit: string }> }; if (old.records.some(item => item.commit !== commit || !paths.includes(item.path))) throw new Error('Pinned Helm source changed or omitted'); }
catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
const records = [];
for (const path of paths) {
  const url = `https://raw.githubusercontent.com/${repo}/${commit}/${path}`, file = new URL(`${path}.txt`, root);
  let content: string;
  try { content = await readFile(file, 'utf8'); } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; content = await get(url); await mkdir(new URL('./', file), { recursive: true }); await writeFile(file, content, { flag: 'wx' }); }
  const blob = tree.tree.find(item => item.path === path); if (!blob || createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex') !== blob.sha) throw new Error('Helm blob mismatch');
  records.push({ repo, tag, commit, path, url, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') });
}
await writeFile(output, JSON.stringify({ schemaVersion: 1, evidence: 'M1-E051', scope: 'repository-format-and-paths-not-cli-support-or-runtime-evidence', records }, null, 2) + '\n');
console.log(JSON.stringify({ files: records.length, bytes: records.reduce((sum, item) => sum + item.bytes, 0), commit }));
