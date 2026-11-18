// Public pinned source TEXT only, not an install/build/runtime compatibility check.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const get = async (url: string) => {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Public SemVer source HTTP ${response.status}`);
  const text = await response.text(); if (Buffer.byteLength(text) > 2_000_000) throw new Error('Public SemVer source too large'); return text;
};
const selections = [
  { repo: 'helm/helm', tag: 'v3.19.0', expected: '3d8990f0836691f0229297773f3524598f46bda6', paths: ['go.mod'] },
  { repo: 'Masterminds/semver', tag: 'v3.4.0', paths: ['version.go', 'constraints.go', 'version_test.go', 'constraints_test.go', 'README.md', 'LICENSE.txt'] },
];
const root = new URL('../tests/fixtures/contracts/helm-semver-contract/', import.meta.url), output = new URL('../docs/baseline/helm-semver-sources.json', import.meta.url);
type Record = { repo: string; tag: string; commit: string; path: string; url: string; bytes: number; sha256: string };
let prior: Record[] = [];
try { prior = (JSON.parse(await readFile(output, 'utf8')) as { records: Record[] }).records; }
catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
const records: Record[] = [];
for (const selection of selections) {
  let object = (JSON.parse(await get(`https://api.github.com/repos/${selection.repo}/git/ref/tags/${selection.tag}`)) as { object: { type: string; sha: string } }).object;
  for (let n = 0; object.type === 'tag' && n < 3; n++) object = (JSON.parse(await get(`https://api.github.com/repos/${selection.repo}/git/tags/${object.sha}`)) as { object: typeof object }).object;
  if (object.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha) || selection.expected && object.sha !== selection.expected) throw new Error('Exact SemVer source commit required');
  const commit = object.sha, tree = JSON.parse(await get(`https://api.github.com/repos/${selection.repo}/git/trees/${commit}?recursive=1`)) as { truncated: boolean; tree: Array<{ path: string; sha: string }> };
  if (tree.truncated) throw new Error('Incomplete SemVer source tree');
  for (const path of selection.paths) {
    const url = `https://raw.githubusercontent.com/${selection.repo}/${commit}/${path}`, file = new URL(`${selection.repo}/${path}.txt`, root);
    let text: string;
    try { text = await readFile(file, 'utf8'); }
    catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; text = await get(url); await mkdir(new URL('./', file), { recursive: true }); await writeFile(file, text, { flag: 'wx' }); }
    const blob = tree.tree.find(item => item.path === path);
    if (!blob || createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex') !== blob.sha) throw new Error('Public SemVer Git blob mismatch');
    records.push({ repo: selection.repo, tag: selection.tag, commit, path, url, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
  }
}
if (prior.some(old => !records.some(record => JSON.stringify(record) === JSON.stringify(old)))) throw new Error('Pinned SemVer source changed or omitted');
await writeFile(output, JSON.stringify({ schemaVersion: 1, evidence: 'M1-E052', scope: 'source-parsing-contract-not-cli-support-or-runtime-evidence', records }, null, 2) + '\n');
console.log(JSON.stringify({ files: records.length, bytes: records.reduce((sum, record) => sum + record.bytes, 0), commits: records.map(record => record.commit).filter((value, index, all) => all.indexOf(value) === index) }));
