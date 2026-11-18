// READ-only metadata and pure values only. No SessionClient, socket, session
// service, authentication adapter, terminal action or mock operating chain.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionTargetClient } from '../../src/host/session-target-client.ts';
import { forwardSelectionKey, sessionOpenTarget, parseSessionPorts, parseSessionCommand, sessionActionAvailability } from '../../src/shared/session-target.ts';
import { projectForwardPortHints, suggestedForwardMapping } from '../../src/shared/forward-port-hints.ts';
import { projectResource } from '../../src/service/queries/tree-projection.ts';
import { resourceDescriptors } from '../../src/shared/tree.ts';
import { resourceTreeEntry } from '../../src/shared/tree-entries.ts';
import type { SessionTargetState } from '../../src/shared/session-target.ts';
import { ForwardChannelDecoder, sessionQuery, forwardWebsocketProtocols } from '../../src/shared/session-wire.ts';
import { sessionIdentifier } from '../../src/shared/session-identifier.ts';
import { readForwardTarget } from '../../src/service/queries/forward-target.ts';
import { publicConfigSummary } from '../../src/service/queries/kubeconfig.ts';
import { TreeModel } from '../../src/shared/tree-model.ts';
import { appendSessionOutput, terminalOutputDelta, terminalScreenSchema } from '../../src/shared/session-terminal-output.ts';
const target = { serviceGeneration: 'synthetic', projectId: 'project-a', configIdentity: 'config', context: 'context-a', namespace: 'default' };
const reference = { type: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' as const }, name: 'chosen-pod', namespace: 'default', uid: 'chosen-uid', resourceVersion: '12' };
const source = { target, selection: { mode: 'default' as const }, reference };

test('forward suggestions are bounded, TCP-only, deduplicated and preserve declaration order at the tree boundary', () => {
  const metadata = { name: reference.name, namespace: reference.namespace, uid: reference.uid, resourceVersion: reference.resourceVersion };
  const pod = { apiVersion: 'v1', kind: 'Pod', metadata, spec: { containers: [{ ports: [{ containerPort: 53, protocol: 'UDP' },
    { containerPort: 9090, hostPort: 90 }, { containerPort: 9090 }, { containerPort: 8080, protocol: 'TCP' }, { containerPort: 65536 }] }],
    initContainers: [{ ports: [{ containerPort: 1234 }] }] } };
  const service = { apiVersion: 'v1', kind: 'Service', metadata, spec: { ports: [{ port: 80, targetPort: 'web' }, { port: 443, targetPort: 8443 }, { port: 53, protocol: 'UDP' }] } };
  assert.deepEqual(resourceTreeEntry(projectResource(pod, resourceDescriptors.pods, target), target).node.forwardPorts, [9090, 8080]);
  assert.deepEqual(resourceTreeEntry(projectResource(service, resourceDescriptors.services, target), target).node.forwardPorts, [80, 443]);
  assert.deepEqual(projectForwardPortHints({ spec: { containers: [] } }, 'pods'), []);
  const many = { spec: { ports: Array.from({ length: 100 }, (_, index) => ({ port: index + 1 })) } };
  assert.equal(projectForwardPortHints(many, 'services').length, 64);
  assert.equal(suggestedForwardMapping(80), '8080:80');
  assert.equal(suggestedForwardMapping(8080, new Set([8080, 8081])), '8082:8080');
});

test('selecting tree port metadata uses no transport and has an exact scope and reference key', async () => {
  const client = new SessionTargetClient(async () => assert.fail('prefill must not read'), () => {});
  await client.select(source, false, [9090, 8080]);
  assert.deepEqual(client.state.forwardPorts, [9090, 8080]);
  const key = forwardSelectionKey(client.state);
  await client.select({ ...source, target: { ...target, projectId: 'project-b' } }, false, []);
  assert.notEqual(forwardSelectionKey(client.state), key);
  await client.select({ ...source, reference: { ...reference, resourceVersion: '13' } }, false, []);
  assert.notEqual(forwardSelectionKey(client.state), key);
  client.reject('STALE_TARGET'); assert.equal(forwardSelectionKey(client.state), undefined);
  client.dispose();
});
const response = (containers = ['app']) => ({ status: 200, body: JSON.stringify({ protocol: 2, kind: 'log-containers', target,
  reference: { resource: 'pods', namespace: 'default', name: 'chosen-pod', uid: 'chosen-uid', resourceVersion: '12' },
  containers: containers.map(name => ({ name, kind: 'regular' })) }) });
test('explicit Pod metadata selection uses the existing READ endpoint and binds the actual unique container', async () => {
  const states: SessionTargetState[] = [], calls: unknown[] = [];
  const client = new SessionTargetClient(async request => { calls.push(request); assert.equal(request.path, '/v2/logs/read'); assert.equal(JSON.parse(request.body!).kind, 'containers'); return response(); }, state => states.push(state));
  assert.equal(calls.length, 0);
  await client.select(source);
  assert.equal(states.at(-1)?.container, 'app');
  assert.deepEqual(sessionOpenTarget(client.state, true), { namespace: 'default', pod: 'chosen-pod', podUid: 'chosen-uid', podResourceVersion: '12', container: 'app' });
  client.dispose();
});
test('multiple containers require an explicit valid choice, not a namespace/pod string or a shell name', async () => {
  const client = new SessionTargetClient(async () => response(['app', 'sidecar']), () => {});
  await client.select(source);
  assert.equal(sessionOpenTarget(client.state, true), undefined);
  client.choose('default/chosen-pod'); client.choose('bash');
  assert.equal(client.state.container, undefined);
  client.choose('sidecar');
  assert.equal(client.state.container, 'sidecar');
  client.dispose();
});
test('Service/Deployment forwarding keeps the ORIGINAL resource and never invents a Pod or container', async () => {
  let reads = 0;
  const client = new SessionTargetClient(async () => { reads++; return response(); }, () => {});
  for (const [resource, group, kind] of [['services', '', 'Service'], ['deployments', 'apps', 'Deployment']]) {
    await client.select({ ...source, reference: { ...reference, type: { ...reference.type, resource, group, kind } } }, false);
    assert.deepEqual(sessionOpenTarget(client.state, false), { original: { resource, name: 'chosen-pod', namespace: 'default', uid: 'chosen-uid', resourceVersion: '12' } });
    assert.equal(sessionOpenTarget(client.state, true), undefined);
  }
  assert.equal(reads, 0);
  client.dispose();
});
test('late old target metadata cannot replace a new explicit target; invalid metadata never enables execution', async () => {
  let release: ((value: ReturnType<typeof response>) => void) | undefined;
  const client = new SessionTargetClient(() => new Promise(resolve => { release = resolve; }), () => {});
  const old = client.select(source);
  await client.select({ ...source, reference: { ...reference, name: 'new-pod', uid: 'new-uid' } }, false);
  release?.(response()); await old;
  assert.equal(client.state.reference?.uid, 'new-uid'); assert.equal(client.state.container, undefined);
  client.reset(); assert.equal(sessionOpenTarget(client.state, false), undefined);
  client.dispose();
  const invalid = new SessionTargetClient(async () => ({ status: 200, body: response().body.replace('chosen-uid', 'another-uid') }), () => {});
  await invalid.select(source); assert.equal(invalid.state.error, 'STALE_TARGET'); assert.equal(sessionOpenTarget(invalid.state, true), undefined); invalid.dispose();
});
test('session query keeps repeated arguments and ports separate and encodes each value exactly once', () => {
  const query = new URLSearchParams(sessionQuery('exec', 'app', ['/bin/sh', '-c', 'printf "%s" "a&b"']));
  assert.deepEqual(query.getAll('command'), ['/bin/sh', '-c', 'printf "%s" "a&b"']);
  assert.equal(query.get('stdin'), 'false'); assert.equal(query.get('tty'), 'false');
  const ports = new URLSearchParams(sessionQuery('port-forward', undefined, [], [{ remote: 80 }, { remote: 443 }]));
  assert.deepEqual(ports.getAll('ports'), ['80', '443']); assert.equal(ports.has('container'), false);
  assert.deepEqual(forwardWebsocketProtocols, ['v4.channel.k8s.io']);
});
test('forward payload announcements contain two bytes after removing channel prefix and may be fragmented or coalesced', () => {
  const decoder = new ForwardChannelDecoder(8080);
  assert.equal(decoder.accept(0, Uint8Array.of(0x90)).kind, 'announcement');
  const next = decoder.accept(0, Uint8Array.of(0x1f, 65, 66));
  assert.equal(next.kind, 'data'); assert.deepEqual([...next.payload], [65, 66]);
  assert.deepEqual([...decoder.accept(0, Uint8Array.of(67)).payload], [67]);
  assert.equal(decoder.accept(1, Uint8Array.of(0x90, 0x1f)).kind, 'announcement');
  assert.equal(decoder.accept(1, Uint8Array.of(69)).kind, 'error');
  assert.throws(() => new ForwardChannelDecoder(80).accept(0, Uint8Array.of(81, 0)));
  assert.throws(() => decoder.accept(2, new Uint8Array()));
});
test('port input rejects partial/decimal/duplicate mappings instead of silently dropping invalid pieces', () => {
  assert.deepEqual(parseSessionPorts('8080:80, 8443:443'), [{ local: 8080, remote: 80 }, { local: 8443, remote: 443 }]);
  for (const input of ['', '8080:80,bad', '8080.5:80', '8080:80,8080:81', '8080:80,8081:80', '0:80', '70000:80', '8080:80,']) assert.equal(parseSessionPorts(input), undefined, input);
});
test('session identifiers use UUID v7 and do not mutate caller entropy', () => {
  const entropy = new Uint8Array(16).fill(0xab), original = entropy.slice();
  assert.match(sessionIdentifier(123456, entropy), /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(entropy, original);
});
test('the production button availability model changes on valid container/input without a session action', async () => {
  const client = new SessionTargetClient(async () => response(['app', 'sidecar']), () => {});
  const input = { shell: '/bin/sh', command: 'env', ports: '8080:80' };
  assert.deepEqual(sessionActionAvailability({ phase: 'idle' }, client.state, input), { terminal: false, exec: false, forward: false });
  await client.select(source);
  assert.deepEqual(sessionActionAvailability({ phase: 'idle' }, client.state, input), { terminal: false, exec: false, forward: true });
  client.choose('app');
  assert.deepEqual(sessionActionAvailability({ phase: 'idle' }, client.state, input), { terminal: true, exec: true, forward: true });
  assert.equal(sessionActionAvailability({ phase: 'idle' }, client.state, { ...input, choosing: true }).terminal, false);
  assert.equal(sessionActionAvailability({ phase: 'idle' }, client.state, { ...input, shell: '' }).terminal, false);
  assert.equal(sessionActionAvailability({ phase: 'error', error: 'OPERATION_UNKNOWN' }, client.state, input).forward, false);
  assert.equal(sessionActionAvailability({ phase: 'ready', id: 'existing' }, client.state, input).terminal, false);
  client.dispose();
});
test('container argv preserves quotes and empty arguments; it never evaluates shell operators', () => {
  assert.deepEqual(parseSessionCommand(`sh -c 'printf "%s" "a b"'`), ['sh', '-c', 'printf "%s" "a b"']);
  assert.deepEqual(parseSessionCommand(`printf "%s" ""`), ['printf', '%s', '']);
  assert.deepEqual(parseSessionCommand('echo a\\ b'), ['echo', 'a b']);
  assert.deepEqual(parseSessionCommand('echo $(whoami) | cat'), ['echo', '$(whoami)', '|', 'cat']);
  assert.equal(parseSessionCommand(`sh -c 'unfinished`), undefined);
  assert.equal(parseSessionCommand('echo dangling\\'), undefined);
});
test('forward target READ accepts real Kubernetes metadata and maps Service port to a named backend port', async () => {
  const original = { resource: 'services' as const, name: 'web', namespace: 'default', uid: 'service-uid', resourceVersion: '10' };
  const values = [
    { apiVersion: 'v1', kind: 'Service', metadata: { ...original, resource: undefined, labels: { app: 'web' }, creationTimestamp: '2026-01-01T00:00:00Z' },
      spec: { selector: { app: 'web' }, ports: [{ port: 80, targetPort: 'http', protocol: 'TCP' }], clusterIP: '10.0.0.1' }, status: {} },
    { apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: '20' }, items: [{ metadata: { name: 'backend', namespace: 'default', uid: 'pod-uid', resourceVersion: '15', labels: { app: 'web' } },
      spec: { containers: [{ name: 'app', image: 'synthetic', ports: [{ name: 'http', containerPort: 8080 }] }] }, status: { phase: 'Running' } }] },
  ];
  let proofs = 0;
  const value = await readForwardTarget(target, original, new AbortController().signal, async () => {
    const item = values.shift(); return { status: 200, body: (async function* () { yield Buffer.from(JSON.stringify(item)); })(), close: async () => {} };
  }, async () => { proofs++; });
  assert.equal(value.name, 'backend'); assert.equal(value.uid, 'pod-uid'); assert.deepEqual(value.servicePorts, [{ service: 80, backend: 8080 }]); assert.equal(proofs, 2);
});
test('configuration discovery summary never contains raw configuration, user fields or credentials', () => {
  const marker = 'synthetic-private-marker';
  const result = publicConfigSummary(JSON.stringify({ apiVersion: 'v1', kind: 'Config', 'current-context': 'minikube',
    clusters: [{ name: 'cluster', cluster: { server: 'https://synthetic.invalid', 'certificate-authority-data': marker } }],
    users: [{ name: 'user', user: { token: marker, 'client-key-data': marker } }],
    contexts: [{ name: 'minikube', context: { cluster: 'cluster', user: 'user', namespace: 'default' } }] }));
  assert.deepEqual(result, { currentContext: 'minikube', contexts: [{ name: 'minikube', clusterName: 'cluster', namespace: 'default' }] });
  assert.ok(!JSON.stringify(result).includes(marker));
  assert.throws(() => publicConfigSummary('a'.repeat(48_001)));
});
test('folder Watch consumes a retained fresh list proof, never an item RV or stale proof', () => {
  const model = new TreeModel();
  model.reset([{ node: { id: 'pods', type: 'folder', label: 'Pods', expandable: true }, query: { target, kind: 'resources', resource: 'pods' } }]);
  const id = model.visible()[0]!.id;
  assert.equal(model.loadedProof(id), undefined);
  const ticket = model.begin(id)!;
  model.apply(ticket, { entries: [], cursor: null, proof: { resourceVersion: 'list-rv' } });
  assert.equal(model.loadedProof(id)?.proof.resourceVersion, 'list-rv');
  model.invalidateQueries(() => true);
  assert.equal(model.loadedProof(id), undefined);
});
test('terminal transcript windows preserve Unicode and deliver repeated identical chunks exactly once', () => {
  const initial = appendSessionOutput('', 0, 'a'.repeat(131_071) + '😀');
  assert.equal(initial.start, 1); assert.equal(initial.output.length, 131_072);
  const rolled = appendSessionOutput('😀' + 'a'.repeat(131_070), 10, 'b');
  assert.equal(rolled.start, 12); assert.ok(!rolled.output.startsWith('\ude00'));
  const first = terminalOutputDelta(undefined, { id: 's', outputStart: 0, output: 'x' });
  assert.equal(first.reset, true); assert.equal(first.text, 'x');
  const second = terminalOutputDelta(first.cursor, { id: 's', outputStart: 0, output: 'xx' });
  assert.equal(second.reset, false); assert.equal(second.text, 'x');
  assert.equal(terminalOutputDelta(second.cursor, { id: 's', outputStart: 0, output: 'xx' }).text, '');
  assert.equal(terminalOutputDelta(second.cursor, { id: 's', outputStart: 0, output: 'x' }).cursor.end, 2);
});
test('restoring a saved terminal cursor consumes only unseen retained output; a real gap is explicit', () => {
  const cursor = { id: 's', end: 50 };
  assert.deepEqual(terminalOutputDelta(cursor, { id: 's', outputStart: 48, output: 'abcd' }), { reset: false, text: 'cd', cursor: { id: 's', end: 52 } });
  assert.equal(terminalOutputDelta(cursor, { id: 's', outputStart: 51, output: 'lost-prefix' }).reset, true);
  assert.equal(terminalOutputDelta(cursor, { id: 'other', outputStart: 0, output: 'new' }).reset, true);
});
test('retained terminal screens reject oversized or invalid geometry instead of trusting opaque UI state', () => {
  const screen = { id: '00000000-0000-7000-8000-000000000001', end: 10, vt: '\u001b[31mred', columns: 80, rows: 24, viewport: 0, focused: false };
  assert.equal(terminalScreenSchema.safeParse(screen).success, true);
  for (const patch of [{ columns: 1000 }, { rows: -1 }, { viewport: 129 }, { end: -1 }, { vt: 'x'.repeat(1_048_577) }, { id: 'other' }]) assert.equal(terminalScreenSchema.safeParse({ ...screen, ...patch }).success, false);
});
