// Public pinned-version text only; no CLI, authentication, config or cluster is executed/read.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../tests/fixtures/contracts/query-contract/', import.meta.url);
const output = new URL('../docs/baseline/query-sources.json', import.meta.url);
const selections = [
  { repo: 'kubernetes/client-go', paths: ['tools/clientcmd/loader.go', 'tools/clientcmd/api/types.go', 'tools/clientcmd/merged_client_builder.go', 'kubernetes/typed/core/v1/pod_expansion.go', 'tools/clientcmd/config.go', 'discovery/cached/disk/cached_discovery.go', 'discovery/cached/disk/round_tripper.go', 'third_party/forked/httpcache/httpcache.go', 'go.mod', 'openapi/client.go', 'openapi/groupversion.go'] },
  { repo: 'kubernetes/kubectl', paths: ['pkg/cmd/get/get.go', 'pkg/rawhttp/raw.go', 'pkg/cmd/cmd.go', 'pkg/cmd/profiling.go', 'pkg/kuberc/kuberc.go', 'pkg/polymorphichelpers/logsforobject.go', 'pkg/polymorphichelpers/helpers.go', 'pkg/util/podutils/podutils.go', 'pkg/cmd/delete/delete.go', 'pkg/cmd/config/use_context.go', 'pkg/cmd/config/delete_context.go', 'pkg/cmd/config/delete_cluster.go', 'pkg/cmd/config/unset.go', 'pkg/cmd/config/set_context.go', 'pkg/cmd/describe/describe.go', 'pkg/cmd/clusterinfo/clusterinfo.go'] },
  { repo: 'kubernetes/cli-runtime', paths: ['pkg/genericclioptions/config_flags.go', 'pkg/genericclioptions/json_yaml_flags.go', 'pkg/printers/managedfields.go'] },
  { repo: 'kubernetes/apiextensions-apiserver', paths: ['pkg/apis/apiextensions/v1/types.go', 'pkg/apis/apiextensions/validation/validation.go'] },
  { repo: 'kubernetes/api', paths: ['core/v1/types.go', 'events/v1/types.go'] },
  { repo: 'kubernetes/apimachinery', paths: ['pkg/apis/meta/v1/types.go', 'pkg/runtime/schema/group_version.go'] },
  { repo: 'peterbourgon/diskv', tag: 'v2.0.1', paths: ['diskv.go'] },
] as const;
type Source = { repo: string; tag: string; commit: string; path: string; url: string; bytes: number; sha256: string };
let prior: Source[] = [];
try { prior = (JSON.parse(await readFile(output, 'utf8')) as { records: Source[] }).records; }
catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
for (const item of prior) if (!selections.some(selection => selection.repo === item.repo && selection.paths.some(path => path === item.path))) throw new Error('Existing pinned source omitted from collection; refusing to discard evidence');
async function get(url: string) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Public query contract HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 8_000_000) throw new Error('Public evidence response too large');
  return text;
}
const records: Source[] = [];
for (const selection of selections) {
  const tag = 'tag' in selection ? selection.tag : 'v0.37.0';
  const ref = JSON.parse(await get(`https://api.github.com/repos/${selection.repo}/git/ref/tags/${tag}`)) as { object: { sha: string; type: string } };
  let object = ref.object;
  for (let depth = 0; object.type === 'tag' && depth < 3; depth++) {
    if (!/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('Invalid annotated tag identity');
    object = (JSON.parse(await get(`https://api.github.com/repos/${selection.repo}/git/tags/${object.sha}`)) as { object: typeof object }).object;
  }
  if (object.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('Query contract needs an exact commit ref');
  const commit = object.sha;
  if (prior.some(item => item.repo === selection.repo && item.commit !== commit)) throw new Error('Pinned source tag changed; review required');
  const tree = JSON.parse(await get(`https://api.github.com/repos/${selection.repo}/git/trees/${commit}?recursive=1`)) as { truncated: boolean; tree: Array<{ path: string; sha: string; type: string }> };
  if (tree.truncated) throw new Error('Incomplete query contract tree');
  for (const path of selection.paths) {
    const blob = tree.tree.find(item => item.path === path && item.type === 'blob');
    if (!blob) throw new Error('Missing query contract source');
    const url = `https://raw.githubusercontent.com/${selection.repo}/${commit}/${path}`;
    const file = new URL(`${selection.repo}/${path}.txt`, root);
    let content: string;
    try { content = await readFile(file, 'utf8'); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      content = await get(url);
      await mkdir(new URL('./', file), { recursive: true });
      await writeFile(file, content, { flag: 'wx' });
    }
    if (createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex') !== blob.sha) throw new Error('Public query contract blob mismatch');
    records.push({ repo: selection.repo, tag, commit, path, url, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') });
  }
}
await writeFile(output, `${JSON.stringify({ schemaVersion: 1, evidence: 'M1-E049', records }, null, 2)}\n`);
console.log(JSON.stringify({ files: records.length, bytes: records.reduce((sum, item) => sum + item.bytes, 0), scope: 'source-contract-not-approved-CLI-support-matrix' }));
