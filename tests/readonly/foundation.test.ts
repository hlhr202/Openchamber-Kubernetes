import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { readTarget, sameTarget, stableNodeId } from '../../src/shared/identity.ts';
import { contextChildren, contextFolders, groupingChildren, resourceDescriptors } from '../../src/shared/tree.ts';
import { mergeConfigSources, parseConfig, publicConfigSnapshot } from '../../src/service/queries/kubeconfig.ts';
import { podSelection } from '../../src/service/queries/selectors.ts';
import { projectConfigurationKeys, projectPodInformation, projectResource } from '../../src/service/queries/tree-projection.ts';
import { ReadGeneration } from '../../src/host/generation.ts';
import { configurationIdentity } from '../../src/service/queries/config-source.ts';
import { configPageSchema, healthSchema, protocolVersion } from '../../src/shared/protocol.ts';
import { resourceNodeSchema } from '../../src/shared/resource-protocol.ts';

const target = readTarget({ serviceGeneration: 'service-1', projectId: 'project-1', configIdentity: 'opaque-config-1', context: 'synthetic-context', namespace: 'default' });
const metadata = { name: 'synthetic-resource', namespace: 'default', uid: 'synthetic-uid', resourceVersion: '10' };
const marker = 'SYNTHETIC_ONLY_NOT_A_REAL_SECRET';
const encoded = Buffer.from(marker).toString('base64');
const code = (expected: string) => (error: unknown) => error instanceof BoundaryError && error.code === expected && error.message === expected;

test('configuration identities are keyed, ordered, content-sensitive and do not expose raw hashes', () => {
  const key = Buffer.alloc(32, 1);
  const sources = [{ sourcePath: '/synthetic/a', content: marker }, { sourcePath: '/synthetic/b', content: encoded }];
  const identity = configurationIdentity(key, sources);
  assert.equal(configurationIdentity(key, sources), identity);
  assert.notEqual(configurationIdentity(Buffer.alloc(32, 2), sources), identity);
  assert.notEqual(configurationIdentity(key, [...sources].reverse()), identity);
  assert.notEqual(configurationIdentity(key, [{ sourcePath: '/synthetic/a', content: `${marker}-changed` }]), identity);
  assert.throws(() => configurationIdentity(Buffer.alloc(31), sources), code('INVALID_INPUT'));
});

test('versioned read DTOs reject extra credentials, incompatible protocol and overlarge pages', () => {
  const health = { protocol: protocolVersion, status: 'ready', serviceGeneration: 'service-1', version: '0.1.0', compatibility: '2.5.1' };
  assert.equal(healthSchema.safeParse(health).success, true);
  assert.equal(healthSchema.safeParse({ ...health, protocol: protocolVersion + 1 }).success, false);
  assert.equal(healthSchema.safeParse({ ...health, token: marker }).success, false);
  const configPage = { protocol: protocolVersion, serviceGeneration: 'service-1', configIdentity: 'config-1', status: 'missing', total: 0, nextOffset: null, currentContextMissing: false, currentContext: '', currentContextInfo: null, sources: { mode: 'default', selectedCount: 1, loadedCount: 0, missingCount: 1 }, contexts: [] };
  assert.equal(configPageSchema.safeParse(configPage).success, true);
  assert.equal(configPageSchema.safeParse({ ...configPage, contexts: Array(101).fill({ name: 'synthetic', clusterName: 'c', namespace: 'default', active: false, available: true }) }).success, false);
});

test('read generations reject old project/service/disposed responses without claiming authenticated ownership', () => {
  const generation = new ReadGeneration();
  generation.update('/synthetic/project-a', 'service-a');
  const first = generation.capture();
  generation.update('/synthetic/project-a', 'service-a');
  assert.equal(generation.current(first), true);
  generation.update('/synthetic/project-b', 'service-a');
  assert.equal(generation.current(first), false);
  const second = generation.capture();
  generation.update('/synthetic/project-b', 'service-b');
  assert.equal(generation.current(second), false);
  const third = generation.capture();
  generation.dispose();
  assert.equal(generation.current(third), false);
});

test('target input is strict, immutable, and every target dimension partitions IDs', () => {
  assert.ok(Object.isFrozen(target));
  assert.throws(() => readTarget({ ...target, token: marker }), code('INVALID_INPUT'));
  assert.throws(() => readTarget({ ...target, namespace: 'bad\nnamespace' }), code('INVALID_INPUT'));
  for (const key of ['serviceGeneration', 'projectId', 'configIdentity', 'context', 'namespace'] as const) {
    assert.equal(sameTarget(target, readTarget({ ...target, [key]: key === 'namespace' ? 'other' : `${target[key]}-other` })), false);
  }
  assert.notEqual(stableNodeId(target, 'a/b', 'c'), stableNodeId(target, 'a', 'b/c'));
});

test('default categories are exact; contexts are active-only, not an additional root', () => {
  assert.deepEqual(contextChildren(target, true).map(row => row.label), ['Namespaces', 'Nodes', 'Workloads', 'Network', 'Storage', 'Configuration', 'Custom Resources', 'Helm Releases']);
  assert.deepEqual(contextChildren(target, false), []);
  assert.deepEqual(groupingChildren(target, 'Workloads').map(row => row.label), ['Deployments', 'StatefulSets', 'DaemonSets', 'Jobs', 'CronJobs', 'Pods']);
  assert.deepEqual(groupingChildren(target, 'Network').map(row => row.label), ['Services', 'Endpoints', 'Ingress']);
  assert.deepEqual(groupingChildren(target, 'Storage').map(row => row.label), ['Persistent Volumes', 'Persistent Volume Claims', 'Storage Classes']);
  assert.deepEqual(groupingChildren(target, 'Configuration').map(row => row.label), ['Config Maps', 'Secrets']);
  assert.ok(contextFolders.every(folder => !('icon' in folder)));
});

test('resource children match the upstream registry; no CronJob Jobs/Pod Containers directory', () => {
  assert.equal(resourceDescriptors.namespaces.children, 'none');
  assert.equal(resourceDescriptors.nodes.children, 'pods-on-node');
  for (const key of ['deployments', 'statefulsets', 'daemonsets', 'jobs', 'services'] as const) assert.equal(resourceDescriptors[key].children, 'selected-pods');
  assert.equal(resourceDescriptors.cronjobs.children, 'none');
  assert.equal(resourceDescriptors.pods.children, 'pod-info');
  assert.equal(resourceDescriptors.secrets.children, 'config-keys');
  assert.equal(resourceDescriptors.persistentvolumes.scope, 'cluster');
  assert.equal(resourceDescriptors.persistentvolumeclaims.scope, 'namespace');
});

test('Namespace is a leaf with the literal active prefix, without a badge or icon', () => {
  const row = projectResource({ metadata: { name: 'default', uid: 'ns-uid' } }, resourceDescriptors.namespaces, target);
  assert.equal(row.label, '* default');
  assert.equal(row.expandable, false);
  assert.equal(row.icon, undefined);
  assert.equal(row.resource?.namespace, undefined);
});

test('Secret service projection exposes only identity and key names, never data/stringData/annotations/extra fields', () => {
  const raw = { metadata: { ...metadata, annotations: { opaque: encoded }, labels: { unsafe: marker } }, data: { 'file.txt': encoded, 'empty.txt': '' }, stringData: { hidden: marker }, unknown: marker };
  const row = projectResource(raw, resourceDescriptors.secrets, target);
  const keys = projectConfigurationKeys(raw, row);
  assert.deepEqual(keys.map(item => item.label), ['file.txt', 'empty.txt']);
  const wire = JSON.stringify({ row, keys });
  assert.ok(!wire.includes(marker));
  assert.ok(!wire.includes(encoded));
  assert.ok(!wire.includes('annotations'));
  assert.ok(!wire.includes('stringData'));
  assert.ok(!wire.includes('unknown'));
  assert.deepEqual(Object.keys(row.resource ?? {}).sort(), ['group', 'kind', 'name', 'namespace', 'resource', 'resourceVersion', 'scope', 'uid', 'version'].sort());
});

test('configuration key projection preserves prototype-like key names without copying their values', () => {
  const raw: unknown = JSON.parse(`{"metadata":${JSON.stringify(metadata)},"data":{"__proto__":"${marker}","constructor":"${encoded}"}}`);
  const row = projectResource(raw, resourceDescriptors.configmaps, target);
  assert.deepEqual(projectConfigurationKeys(raw, row).map(item => item.key), ['__proto__', 'constructor']);
});

test('invalid Secret data/metadata errors contain only fixed codes, not raw sensitive values', () => {
  const row = projectResource({ metadata }, resourceDescriptors.secrets, target);
  assert.throws(() => projectResource({ metadata: { name: { raw: marker } }, data: { raw: encoded } }, resourceDescriptors.secrets, target), code('RESOURCE_INVALID'));
  assert.throws(() => projectConfigurationKeys({ metadata, data: marker }, row), code('RESOURCE_INVALID'));
  assert.throws(() => projectConfigurationKeys({ metadata, data: Array(2).fill(marker) }, row), code('RESOURCE_INVALID'));
  assert.throws(() => projectConfigurationKeys({ metadata, data: { ['x'.repeat(1025)]: marker } }, row), code('BUDGET_EXCEEDED'));
});

test('key and Pod children reject same-name replacement and stale resourceVersion', () => {
  const secret = projectResource({ metadata }, resourceDescriptors.secrets, target);
  assert.throws(() => projectConfigurationKeys({ metadata: { ...metadata, uid: 'new-uid' }, data: {} }, secret), code('STALE_TARGET'));
  assert.throws(() => projectConfigurationKeys({ metadata: { ...metadata, resourceVersion: '11' }, data: {} }, secret), code('STALE_TARGET'));
  const pod = projectResource({ metadata }, resourceDescriptors.pods, target);
  assert.throws(() => projectPodInformation({ metadata: { ...metadata, namespace: 'other' } }, pod), code('STALE_TARGET'));
});

for (const [phase, statuses, icon] of [
  ['Running', [{ ready: true }], 'pod-running'],
  ['Running', [{ ready: false }], 'pod-not-ready'],
  ['Succeeded', [{ ready: false }], 'pod-completed'],
  ['Failed', [{ ready: false }], 'pod-error'],
] as const) {
  test(`Pod ${phase}/${statuses[0]?.ready} maps status icon and separate information leaves`, () => {
    const raw = { metadata, status: { phase, containerStatuses: statuses, podIP: '10.0.0.12' } };
    const row = projectResource(raw, resourceDescriptors.pods, target);
    assert.equal(row.icon, icon);
    assert.deepEqual(projectPodInformation(raw, row).map(item => item.label), [`${phase} (${statuses[0]?.ready ? 1 : 0}/1)`, '10.0.0.12']);
    assert.ok(projectPodInformation(raw, row).every(item => !item.expandable && item.type === 'info'));
  });
}

test('missing Pod status is unknown, not healthy/empty or a fake IP', () => {
  const row = projectResource({ metadata }, resourceDescriptors.pods, target);
  assert.equal(row.icon, undefined);
  assert.deepEqual(projectPodInformation({ metadata }, row).map(item => item.label), ['STATE_UNAVAILABLE']);
  assert.deepEqual(projectPodInformation({ metadata, status: { phase: 'Running' } }, row).map(item => item.label), ['Running (unknown)']);
});

test('Pod waiting/init states do not acquire a running-ready icon', () => {
  const crash = { metadata, status: { phase: 'Running', containerStatuses: [{ ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } };
  assert.equal(projectResource(crash, resourceDescriptors.pods, target).icon, 'pod-error');
  const init = { metadata, status: { phase: 'Pending', initContainerStatuses: [{ ready: false, state: {} }] } };
  assert.equal(projectResource(init, resourceDescriptors.pods, target).icon, 'pod-not-ready');
});

test('ordinary Pod startup is waiting, crash/failed exits are errors and successful completion is distinct', () => {
  for (const [reason, expected] of [['ContainerCreating', 'pod-not-ready'], ['PodInitializing', 'pod-not-ready'],
    ['CrashLoopBackOff', 'pod-error'], ['ImagePullBackOff', 'pod-error'], ['ErrImagePull', 'pod-error']]) {
    const raw = { metadata, status: { phase: 'Pending', containerStatuses: [{ ready: false, state: { waiting: { reason } } }] } };
    assert.equal(projectResource(raw, resourceDescriptors.pods, target).icon, expected);
  }
  const raw = { metadata, status: { phase: 'Running', containerStatuses: [{ ready: false, state: { terminated: { exitCode: 1 } } }] } };
  assert.equal(projectResource(raw, resourceDescriptors.pods, target).icon, 'pod-error');
});

test('Deployment health uses the observed current generation and replica counts, never just Available=True', () => {
  const raw = { metadata: { ...metadata, generation: 3 }, spec: { replicas: 2 }, status: {
    observedGeneration: 3, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2, conditions: [{ type: 'Available', status: 'True' }] } };
  const row = projectResource(raw, resourceDescriptors.deployments, target);
  assert.equal(row.icon, 'workload-ready'); assert.ok(resourceNodeSchema.safeParse(row).success);
  assert.equal(projectResource({ ...raw, status: { ...raw.status, observedGeneration: 2 } }, resourceDescriptors.deployments, target).icon, 'workload-progressing');
  assert.equal(projectResource({ ...raw, status: { ...raw.status, updatedReplicas: 1 } }, resourceDescriptors.deployments, target).icon, 'workload-progressing');
  assert.equal(projectResource({ ...raw, status: undefined }, resourceDescriptors.deployments, target).icon, undefined);
  assert.equal(projectResource({ ...raw, status: { ...raw.status, observedGeneration: undefined } }, resourceDescriptors.deployments, target).icon, undefined);
  for (const condition of [{ type: 'Progressing', status: 'False' }, { type: 'ReplicaFailure', status: 'True' }]) {
    assert.equal(projectResource({ ...raw, status: { ...raw.status, conditions: [condition] } }, resourceDescriptors.deployments, target).icon, 'workload-error');
  }
  for (const spec of [{ replicas: 0 }, { replicas: 2, paused: true }]) {
    assert.equal(projectResource({ ...raw, spec }, resourceDescriptors.deployments, target).icon, 'workload-paused');
  }
  assert.equal(projectResource(raw, { ...resourceDescriptors.deployments, group: 'custom.example' }, target).icon, undefined);
});

test('workload selectors support matchLabels/set expressions; Service flat selector is equality-only', () => {
  assert.deepEqual(podSelection({ matchLabels: { app: 'demo', 'app.kubernetes.io/name': 'sample' }, matchExpressions: [
    { key: 'tier', operator: 'In', values: ['web', 'api'] }, { key: 'track', operator: 'NotIn', values: ['canary'] },
    { key: 'present', operator: 'Exists' }, { key: 'absent', operator: 'DoesNotExist' },
  ] }, 'workload'), { kind: 'selector', query: 'app=demo,app.kubernetes.io/name=sample,tier in (web,api),track notin (canary),present,!absent' });
  assert.deepEqual(podSelection({ app: 'demo' }, 'service'), { kind: 'selector', query: 'app=demo' });
});

test('empty selector explicitly returns no children; malformed selector never becomes all Pods', () => {
  assert.deepEqual(podSelection({}, 'workload'), { kind: 'empty' });
  assert.deepEqual(podSelection({}, 'service'), { kind: 'empty' });
  for (const selector of [null, { unexpected: true }, { matchLabels: { 'a,b': 'bad' } }, { matchLabels: { app: 'a,b' } }, { matchExpressions: [{ key: 'app', operator: 'In', values: [] }] }, { matchExpressions: [{ key: 'app', operator: 'Exists', values: ['unexpected'] }] }]) {
    assert.throws(() => podSelection(selector, 'workload'), code('SELECTOR_INVALID'));
  }
});

function config(name: string, token: string, current = name) {
  return JSON.stringify({ apiVersion: 'v1', kind: 'Config', 'current-context': current,
    clusters: [{ name: 'shared', cluster: { server: 'https://synthetic.invalid', 'certificate-authority-data': encoded } }],
    users: [{ name: 'shared-user', user: { token } }], contexts: [{ name, context: { cluster: 'shared', user: 'shared-user' } }],
  });
}

test('multi-file kubeconfig first named stanza wins whole; non-conflicting later fields do not merge into it', () => {
  const first = config('first', marker);
  const second: unknown = JSON.parse(config('second', 'SYNTHETIC_OTHER'));
  assert.ok(typeof second === 'object' && second !== null);
  const merged = mergeConfigSources([{ sourcePath: '/synthetic/a.yaml', content: first }, { sourcePath: '/synthetic/b.yaml', content: JSON.stringify(second) }]);
  assert.equal(merged.currentContext, 'first');
  assert.equal(merged.users.get('shared-user')?.value.token, marker);
  assert.equal(merged.users.get('shared-user')?.sourcePath, '/synthetic/a.yaml');
  assert.deepEqual([...merged.contexts.keys()], ['first', 'second']);
});

test('configuration order, duplicate files, empty current-context and context defaults are explicit', () => {
  const a = { sourcePath: '/synthetic/a.yaml', content: config('a', marker, '') };
  const b = { sourcePath: '/synthetic/b.yaml', content: config('b', 'SYNTHETIC_B') };
  const merged = mergeConfigSources([a, b, a]);
  assert.equal(merged.currentContext, 'b');
  assert.equal(merged.sources.length, 2);
  const snapshot = publicConfigSnapshot(merged, 'opaque-id');
  assert.equal(snapshot.contexts[0]?.namespace, 'default');
  assert.equal(snapshot.contexts[1]?.active, true);
  assert.equal(mergeConfigSources([b, a]).users.get('shared-user')?.value.token, 'SYNTHETIC_B');
});

test('public config snapshot never returns credentials, certificate values, exec/env, raw paths or raw fingerprints', () => {
  const merged = mergeConfigSources([{ sourcePath: `/synthetic/${marker}.yaml`, content: config('safe-context', marker) }]);
  const wire = JSON.stringify(publicConfigSnapshot(merged, 'opaque-config-id'));
  assert.ok(!wire.includes(marker));
  assert.ok(!wire.includes(encoded));
  // Authentication METHOD names are intentional disclosure, never credential/command properties.
  for (const field of ['token', 'certificate', 'exec', 'sourcePath', 'server']) assert.ok(!wire.includes(`"${field}":`));
});

test('dangling cluster/user references are unavailable; anonymous users are allowed; unknown current context is not fabricated', () => {
  const content = JSON.stringify({ 'current-context': 'missing', clusters: [{ name: 'valid', cluster: {} }], contexts: [
    { name: 'dangling-cluster', context: { cluster: 'missing' } }, { name: 'dangling-user', context: { cluster: 'valid', user: 'missing' } },
    { name: 'anonymous', context: { cluster: 'valid', namespace: 'tools' } },
  ] });
  const snapshot = publicConfigSnapshot(mergeConfigSources([{ sourcePath: '/synthetic/config', content }]), 'config-1');
  assert.equal(snapshot.currentContextMissing, true);
  assert.deepEqual(snapshot.contexts.map(context => context.available), [false, false, true]);
  assert.ok(snapshot.contexts.every(context => !context.active));
  assert.equal(snapshot.contexts[2]?.namespace, 'tools');
});

test('malformed YAML/duplicate stanza/custom tags/aliases/budgets fail with fixed sanitized errors', () => {
  for (const text of [`users: [${marker}`, `key: !!unknown ${marker}`, 'users: [{name: duplicate, user: {}}, {name: duplicate, user: {}}]', 'contexts: invalid']) assert.throws(() => parseConfig(text), code('CONFIG_INVALID'));
  assert.throws(() => parseConfig(marker.repeat(70_000)), code('BUDGET_EXCEEDED'));
  assert.deepEqual(publicConfigSnapshot(mergeConfigSources([]), 'empty').contexts, []);
});

test('same-name context stanzas never inherit later namespace or user fields', () => {
  const a = JSON.stringify({ contexts: [{ name: 'ctx', context: { cluster: 'c' } }] });
  const b = JSON.stringify({ contexts: [{ name: 'ctx', context: { namespace: 'later', user: 'later' } }] });
  const merged = mergeConfigSources([{ sourcePath: 'a', content: a }, { sourcePath: 'b', content: b }]);
  assert.deepEqual(merged.contexts.get('ctx')?.value, { cluster: 'c' });
});
