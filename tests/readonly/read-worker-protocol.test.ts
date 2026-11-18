import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { createReadWorkerState, parseReadWorkerResult, parseReadWorkerStart, readWorkerFailure } from '../../src/service/queries/read-worker-protocol.ts';
import { privateKubectlConfiguration, validateKubectlSnapshot } from '../../src/service/queries/kubectl-configuration.ts';
import { mergeConfigSources } from '../../src/service/queries/kubeconfig.ts';
import { kubectlReadArguments } from '../../src/service/queries/kubectl-plan.ts';

const target = { serviceGeneration: 's', projectId: 'p', configIdentity: 'c', context: 'active', namespace: 'default' };
const request = { method: 'GET', purpose: 'resource-list', target, path: '/api/v1/namespaces/default/pods', query: { limit: '100' }, maximumBytes: 2_000_000 } as const;
const marker = 'SYNTHETIC_WORKER_CREDENTIAL';
const snapshot = () => privateKubectlConfiguration(mergeConfigSources([{ sourcePath: '/synthetic/config', content: JSON.stringify({
  'current-context': 'active', contexts: [{ name: 'active', context: { cluster: 'c', user: 'u' } }],
  clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid', 'certificate-authority': 'ca.pem' } }], users: [{ name: 'u', user: { token: marker } }],
}) }]), target);
const start = () => ({ protocol: 1, kind: 'read', request, snapshot: snapshot(), path: '/usr/bin:/usr/local/bin' });
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;

test('private worker start is bounded GET-only data, not argv, environment, executable or generic command input', () => {
  const value = parseReadWorkerStart(start());
  validateKubectlSnapshot(value.snapshot, value.request.target);
  for (const change of [{ command: marker }, { env: { TOKEN: marker } }, { executable: marker }, { protocol: 2 }, { snapshot: marker }, { snapshot: new Uint8Array(8_000_001) }]) {
    assert.throws(() => parseReadWorkerStart({ ...start(), ...change }), fails('INVALID_INPUT'));
  }
  for (const path of ['/api/v1/pods/exec', '/api/v1/pods?watch=true', 'https://evil.invalid']) {
    assert.throws(() => parseReadWorkerStart({ ...start(), request: { ...request, path } }), fails('INVALID_INPUT'));
  }
});

test('the worker independently rejects external authentication, relative references and changed target snapshots before any process', () => {
  const bytes = snapshot();
  const document = JSON.parse(Buffer.from(bytes).toString()) as { users: { user: Record<string, unknown> }[]; clusters: { cluster: Record<string, unknown> }[] };
  assert.throws(() => validateKubectlSnapshot(bytes, { ...target, context: 'other' }), fails('STALE_TARGET'));
  const user = document.users[0]; assert.ok(user); user.user.exec = { command: marker };
  assert.throws(() => validateKubectlSnapshot(Buffer.from(JSON.stringify(document)), target), fails('AUTHENTICATION_UNAVAILABLE'));
  delete user.user.exec; user.user.tokenFile = 'relative/token';
  assert.throws(() => validateKubectlSnapshot(Buffer.from(JSON.stringify(document)), target), fails('CONFIG_INVALID'));
  assert.throws(() => validateKubectlSnapshot(Buffer.from(marker), target), fails('CONFIG_INVALID'));
});

test('FIFO plan passes only an owned absolute configuration path, not credential bytes in argv', () => {
  const args = kubectlReadArguments(request, '/owned/read/configuration.pipe');
  assert.equal(args[0], '--kubeconfig=/owned/read/configuration.pipe');
  assert.equal(args.join(' ').includes(marker), false);
  for (const path of ['relative', '//host/path', '/owned/invalid\n']) assert.throws(() => kubectlReadArguments(request, path), fails('INVALID_INPUT'));
});

test('a worker stop/deadline before its first packet cannot start a late read', () => {
  for (const reason of ['QUERY_CANCELLED', 'QUERY_TIMEOUT'] as const) {
    const state = createReadWorkerState(); assert.equal(state.phase, 'waiting');
    assert.equal(state.stop(reason), true); assert.equal(state.start(), false);
    assert.equal(state.stop('INVALID_INPUT'), false); assert.equal(state.failure, reason);
    state.close(); assert.equal(state.phase, 'closed'); assert.equal(state.start(), false);
  }
});

test('single-use worker lifecycle rejects duplicate startup, late cancel and result resurrection without running cleanup', () => {
  const state = createReadWorkerState(); assert.equal(state.start(), true); assert.equal(state.phase, 'running');
  assert.equal(state.start(), false); assert.equal(state.stop('INVALID_INPUT'), true);
  assert.equal(state.start(), false); state.close(); assert.equal(state.stop('QUERY_CANCELLED'), false);
  assert.equal(state.failure, 'INVALID_INPUT');
});

test('IPC result sizes, fixed errors and non-success empty bodies are enforced without exposing raw diagnostic text', () => {
  assert.equal(parseReadWorkerResult({ protocol: 1, ok: true, status: 200, body: new Uint8Array(2_000_000) }).ok, true);
  for (const value of [{ protocol: 1, ok: true, status: 200, body: new Uint8Array(2_000_001) },
    { protocol: 1, ok: true, status: 403, body: Buffer.from(marker) }, { protocol: 1, ok: false, code: 'STATE_UNAVAILABLE', stderr: marker }]) {
    assert.throws(() => parseReadWorkerResult(value), fails('STATE_UNAVAILABLE'));
  }
  assert.deepEqual(readWorkerFailure(new Error(marker)), { protocol: 1, ok: false, code: 'STATE_UNAVAILABLE' });
  assert.deepEqual(readWorkerFailure(new BoundaryError('READ_TRANSPORT_UNAVAILABLE')), { protocol: 1, ok: false, code: 'READ_TRANSPORT_UNAVAILABLE' });
});
