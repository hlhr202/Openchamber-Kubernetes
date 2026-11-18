// Static extraction: reads source text, never imports the extension or its handlers.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const baseline = new URL('../tests/fixtures/baseline/', import.meta.url);
const output = new URL('../docs/baseline/', import.meta.url);
const commit = 'f54aef89a48c64e3df66af4a75cc5dd3d80f4a75';
const github = `https://github.com/vscode-kubernetes-tools/vscode-kubernetes-tools/blob/${commit}/`;
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected evidence object');
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected evidence array');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected evidence string');
  return value;
}
const manifest = object(JSON.parse(await readFile(new URL('kubernetes/package.json.txt', baseline), 'utf8')));
const contributions = object(manifest.contributes);
const commands = array(contributions.commands).map(object);
const menus = object(contributions.menus);
const sourceIndex = object(JSON.parse(await readFile(new URL('sources.json', baseline), 'utf8')));
const records = array(sourceIndex.records).map(object).filter(item => item.source === 'kubernetes' && text(item.path).endsWith('.ts'));
const files = await Promise.all(records.map(async item => ({ path: text(item.path), content: await readFile(new URL(`kubernetes/${text(item.path)}.txt`, baseline), 'utf8') })));
const entry = files.find(item => item.path === 'src/extension.ts');
if (!entry) throw new Error('Missing activation source');
const registrations = [...entry.content.matchAll(/\bregisterCommand\(\s*['"]([^'"]+)['"]/g)].map(match => ({
  id: text(match[1]), line: entry.content.slice(0, match.index).split('\n').length,
}));
const ids = [...new Set([...commands.map(item => text(item.command)), ...registrations.map(item => item.id)])].sort();
const coverage = object(JSON.parse(await readFile(new URL('command-coverage.json', output), 'utf8')));
if (coverage.commit !== commit) throw new Error('Semantics review has the wrong source commit');
const includedReviews = array(coverage.entries).map(object).filter(item => item.commandId !== null);
const excludedReviews = array(coverage.excludedEntries ?? []).map(object);
const reviewed = new Map([...includedReviews, ...excludedReviews].map(item => [text(item.commandId), item]));
if (reviewed.size !== includedReviews.length + excludedReviews.length) throw new Error('Duplicate included/excluded command review');
if ([...reviewed.keys()].some(id => !ids.includes(id))) throw new Error('Semantics review references an unregistered command');
const m3 = new Set(['Describe.Refresh', 'Explain', 'Load', 'Get', 'Logs', 'Describe', 'ClusterInfo', 'AddWatch', 'DeleteWatch', 'LoadConfigMapData', 'ShowEvents', 'FollowEvents']);
const m5 = new Set(['Exec', 'Terminal', 'Dashboard', 'PortForward']);
const m7 = new Set(['Debug', 'RemoveDebug', 'DebugAttach', 'DebugLocalTunnel', 'FindLocalTunnelDebugProviders', 'SelectPod', 'ConfigureFromCluster', 'CreateCluster']);
const m2 = new Set(['RefreshExplorer', 'Copy']);
function ownership(id: string): { milestone: string | null; scope: string; verification: string } {
  if (id === 'extension.vsKubernetesDebounceActivation') return { milestone: null, scope: 'excluded-internal-activation', verification: 'static-only' };
  if (id === 'extension.vsKubernetesRefreshCloudExplorer' || id === 'kubernetes.cloudExplorer.findProviders') return { milestone: null, scope: 'excluded-clouds-view', verification: 'static-only' };
  if (id === 'extension.vsKubernetesRefreshHelmRepoExplorer' || id.startsWith('extension.helm')) return { milestone: 'M6', scope: 'included', verification: 'per-command-semantics-review-required' };
  if (id.startsWith('extension.vsMinikube') || m7.has(id.replace('extension.vsKubernetes', ''))) return { milestone: 'M7', scope: 'included', verification: 'human-operation-or-prerequisite-review' };
  if (m3.has(id.replace('extension.vsKubernetes', ''))) return { milestone: 'M3', scope: 'included', verification: 'readonly-after-auth-cache-review' };
  if (id === 'kubernetes.portForwarding.showSessions' || m5.has(id.replace('extension.vsKubernetes', ''))) return { milestone: 'M5', scope: 'included', verification: 'human-session-control-snapshot-only-auto' };
  if (id === 'extension.showInfoMessage' || m2.has(id.replace('extension.vsKubernetes', ''))) return { milestone: 'M2', scope: 'included', verification: id.endsWith('Copy') ? 'human-clipboard-pure-render-auto' : 'readonly-after-auth-cache-review' };
  return { milestone: 'M4', scope: 'included', verification: 'static-only-human-operation' };
}
const inventory = ids.map(id => {
  const review = reviewed.get(id);
  const owner = ownership(id);
  if (review?.scope && (review.scope !== owner.scope || owner.milestone !== null)) throw new Error('Excluded review disagrees with fixed product scope');
  const registered = registrations.filter(item => item.id === id);
  const declared = commands.find(item => item.command === id) ?? null;
  const locations = Object.entries(menus).flatMap(([location, values]) => array(values).map(object).flatMap((item, index) => item.command === id ? [{ location, index, ...item }] : []));
  const references = files.flatMap(file => file.content.split('\n').flatMap((line, index) => line.includes(`'${id}'`) || line.includes(`"${id}"`) ? [{ path: file.path, line: index + 1, source: `${github}${file.path}#L${index + 1}`, text: line.trim() }] : []));
  return {
    command: id, declaration: declared, registration: registered.map(item => ({ ...item, source: `${github}src/extension.ts#L${item.line}` })),
    menus: locations, references, ...owner, caseId: `UPSTREAM-${id}`,
    review: { registration: registered.length === 1 ? 'statically-found' : 'requires-review', semantics: review ? 'source-reviewed' : 'pending-per-command-review', semanticsEvidence: review ? text(review.evidence ?? coverage.evidence) : null,
      implementation: review?.implementation ?? 'not-started', candidateId: review?.candidateId ?? null, runtimeEvidence: review?.runtimeEvidence ?? [],
      ...(review?.implementationEvidence ? { implementationEvidence: review.implementationEvidence } : {}) },
  };
});
if (inventory.some(item => item.registration.length !== 1)) throw new Error('Declaration/registration mismatch requires review');
await mkdir(output, { recursive: true });
await writeFile(new URL('upstream-inventory.json', output), `${JSON.stringify({ schemaVersion: 1, commit, source: `${github}package.json`, views: contributions.views, commands: inventory }, null, 2)}\n`);
const sourceBytes = await readFile(new URL('sources.json', baseline));
await writeFile(new URL('sources.json', output), sourceBytes);
console.log(JSON.stringify({ commands: inventory.length, declared: commands.length, registered: registrations.length, menuEntries: inventory.reduce((sum, item) => sum + item.menus.length, 0), sourceIndexSha256: createHash('sha256').update(sourceBytes).digest('hex') }));
