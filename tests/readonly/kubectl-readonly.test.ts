import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryError } from '../../src/shared/errors.ts';
import { mergeConfigSources, publicConfigSnapshot } from '../../src/service/queries/kubeconfig.ts';
import { privateKubectlConfiguration } from '../../src/service/queries/kubectl-configuration.ts';
import { isolatedKubectlEnvironment, kubectlFailureStatus, kubectlReadArguments, verifyKubectlVersion } from '../../src/service/queries/kubectl-plan.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import type { ResourceReadRequest } from '../../src/service/queries/resource-reader.ts';

const target = { serviceGeneration: 's', projectId: 'p', configIdentity: 'c', context: 'active', namespace: 'default' };
const marker = 'SYNTHETIC_CREDENTIAL_ONLY';
const fails = (code: string) => (error: unknown) => error instanceof BoundaryError && error.code === code && error.message === code;
function config(user: Record<string, unknown> = { token: marker }, cluster: Record<string, unknown> = { server: 'https://api.example.test' }) {
  return mergeConfigSources([{ sourcePath: '/canonical/config', originPath: '/selected/links/config', content: JSON.stringify({
    apiVersion: 'v1', kind: 'Config', 'current-context': 'active', clusters: [{ name: 'cluster', cluster }], users: [{ name: 'user', user }],
    contexts: [{ name: 'active', context: { cluster: 'cluster', user: 'user' } }],
  }) }]);
}
const request: ResourceReadRequest = { method: 'GET', target, purpose: 'resource-list', path: '/api/v1/namespaces/default/pods', query: { limit: '100' }, maximumBytes: 2_000_000 };

test('private snapshot is single-context, in-memory and first-stanza-wins, not a public credential projection', () => {
  const merged = config();
  const before = JSON.stringify([...merged.users]);
  const bytes = privateKubectlConfiguration(merged, target);
  assert.ok(Buffer.from(bytes).toString().includes(marker));
  assert.equal(JSON.stringify(publicConfigSnapshot(merged, 'opaque')).includes(marker), false);
  assert.equal(JSON.stringify([...merged.users]), before);
  assert.ok(!Buffer.from(bytes).toString().includes('sourcePath'));
});

test('known kubeconfig impersonation is preserved privately without leaking its values or claiming an unknown auth plugin', () => {
  const merged = config({ token: marker, as: 'synthetic-other-user', 'as-groups': ['synthetic-group'] });
  const publicValue = publicConfigSnapshot(merged, 'opaque');
  assert.deepEqual(publicValue.contexts[0]?.authentication.methods, ['token']);
  assert.equal(JSON.stringify(publicValue).includes('synthetic-other-user'), false);
  assert.equal(Buffer.from(privateKubectlConfiguration(merged, target)).toString().includes('synthetic-other-user'), true);
});

test('relative CA/token/certificate/key references use each winning logical origin, not canonical symlink target', () => {
  const merged = config({ tokenFile: '../auth/token', 'client-certificate': 'cert.pem', 'client-key': '/absolute/key.pem' }, { server: 'https://api.example.test', 'certificate-authority': 'ca.pem' });
  const value = Buffer.from(privateKubectlConfiguration(merged, target)).toString();
  for (const path of ['/selected/auth/token', '/selected/links/cert.pem', '/absolute/key.pem', '/selected/links/ca.pem']) assert.ok(value.includes(path));
  assert.equal(value.includes('/canonical/'), false);
});

test('exec/provider and unknown auth or cluster fields fail before any executable or reference read', () => {
  for (const user of [{ exec: { command: marker } }, { 'auth-provider': { name: marker } }, { token: marker, extension: marker }]) assert.throws(() => privateKubectlConfiguration(config(user), target), fails('AUTHENTICATION_UNAVAILABLE'));
  assert.throws(() => privateKubectlConfiguration(config({}, { server: 'https://api.example.test', extension: marker }), target), fails('AUTHENTICATION_UNAVAILABLE'));
});

test('inactive/missing references and unsafe server URLs cannot fall back to another target or in-cluster identity', () => {
  assert.throws(() => privateKubectlConfiguration(config(), { ...target, context: 'other' }), fails('STALE_TARGET'));
  assert.throws(() => privateKubectlConfiguration(config(), { ...target, namespace: 'other' }), fails('STALE_TARGET'));
  const missing = { ...config(), clusters: new Map(config().clusters) }; missing.clusters.clear();
  assert.throws(() => privateKubectlConfiguration(missing, target), fails('CONFIG_REFERENCE_MISSING'));
  for (const server of ['file:///secret', `https://${marker}@example.test`, 'https://api.example.test/?credential=x']) assert.throws(() => privateKubectlConfiguration(config({}, { server }), target), fails('CONFIG_INVALID'));
});

test('reader private handoff requires the current opaque identity while public reads never contain merged data', async () => {
  let originPath = '/logical/one/config';
  const reader = createConfigReader('/unused', async () => ({ sourcePath: '/canonical/config', originPath, content: JSON.stringify({ 'current-context': 'active',
    clusters: [{ name: 'cluster', cluster: { server: 'https://api.example.test' } }], users: [{ name: 'user', user: { token: marker } }], contexts: [{ name: 'active', context: { cluster: 'cluster', user: 'user' } }] }) }));
  const first = await reader.read({ mode: 'default' });
  assert.equal('merged' in first, false); assert.equal(JSON.stringify(first).includes(marker), false);
  const internal = await reader.privateRead({ mode: 'default' }, first.snapshot.configIdentity);
  assert.equal(internal.merged.users.get('user')?.value.token, marker);
  originPath = '/logical/two/config';
  await assert.rejects(reader.privateRead({ mode: 'default' }, first.snapshot.configIdentity), fails('STALE_TARGET'));
});

test('raw GET plans use only fixed argv, encode continuation, and never use output/watch/shell or credential flags', () => {
  const args = kubectlReadArguments({ ...request, query: { limit: '10', continue: 'opaque+/=', labelSelector: 'app in (one,two)' } }, '/owned/configuration.pipe');
  assert.ok(args.includes('--kubeconfig=/owned/configuration.pipe') && args.includes('--profile=none'));
  assert.equal(args.at(-1), '--raw=/api/v1/namespaces/default/pods?limit=10&continue=opaque%2B%2F%3D&labelSelector=app+in+%28one%2Ctwo%29');
  for (const unsafe of ['--token=', '--server=', '--output=', '--watch', '-f', marker]) assert.equal(args.some(arg => arg.includes(unsafe)), false);
});

test('raw adapter planning rejects URL/path/query/namespace injection before a process is possible', () => {
  for (const path of ['https://evil.test', '/api/v1/pods/exec', '/api/v1/pods?watch=true', '/api/v1/%2e%2e', '/api/v1/namespaces/other/pods']) assert.throws(() => kubectlReadArguments({ ...request, path }, '/owned/configuration.pipe'), fails('INVALID_INPUT'));
  for (const query of [{ limit: '0' }, { limit: '101' }, { limit: '1', watch: 'true' }, { limit: '1', continue: 'x\n' }]) assert.throws(() => kubectlReadArguments({ ...request, query }, '/owned/configuration.pipe'), fails('INVALID_INPUT'));
});

test('child environment is an explicit secret-free allowlist with isolated HOME and kuberc disabled', () => {
  const env = isolatedKubectlEnvironment('/owned/empty/home', '/usr/bin:/usr/local/bin');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'KUBECTL_KUBERC', 'KUBERC', 'LANG', 'LC_ALL', 'PATH']);
  assert.equal(env.HOME, '/owned/empty/home'); assert.equal(env.KUBERC, 'off'); assert.equal(env.KUBECTL_KUBERC, 'false');
  assert.equal('KUBECONFIG' in env, false); assert.equal('AWS_PROFILE' in env, false);
});

test('client probes accept older, newer, patch, vendor and development labels without any version floor or ceiling', () => {
  for (const gitVersion of ['v0.1.0', 'v1.9.0', 'v1.29.0', 'v1.30.0', 'v1.35.0', 'v1.36.0', 'v1.37.0', 'v1.37.1',
    'v1.99.0', 'v2.0.0', 'v1.35.0-gke.123', 'v1.35.0+vendor.1', 'v1.38.0-alpha.1', 'devel', marker]) {
    verifyKubectlVersion(JSON.stringify({ clientVersion: { gitVersion, major: 'unused', minor: 'unused+', platform: 'synthetic' }, kustomizeVersion: 'unused' }));
  }
});

test('client probes reject malformed, missing or oversized metadata without exposing the untrusted document', () => {
  for (const value of [null, [], {}, { serverVersion: { gitVersion: 'v1.35.0' } }, { clientVersion: null },
    ...[undefined, null, 135, {}, '', '   ', 'v1.35.0\ninjected', '\nv1.35.0', 'v1.35.0\0', '\u001b[31mv1.35.0', 'x'.repeat(257)].map(gitVersion => ({ clientVersion: { gitVersion } }))]) {
    assert.throws(() => verifyKubectlVersion(JSON.stringify(value)), fails('CLI_INCOMPATIBLE'));
  }
  assert.throws(() => verifyKubectlVersion(`{"clientVersion":${marker}}`), fails('CLI_INCOMPATIBLE'));
  assert.throws(() => verifyKubectlVersion(JSON.stringify({ clientVersion: { gitVersion: 'v1.35.0' }, extra: marker.repeat(1000) })), fails('CLI_INCOMPATIBLE'));
  assert.throws(() => verifyKubectlVersion(marker.repeat(2000)), fails('CLI_INCOMPATIBLE'));
});

test('only known fixed server error reasons map statuses, never arbitrary raw stderr text', () => {
  for (const [reason, status] of [['Unauthorized', 401], ['Forbidden', 403], ['NotFound', 404], ['Expired', 410], ['TooManyRequests', 429]] as const) assert.equal(kubectlFailureStatus(`Error from server (${reason}): ${marker}`), status);
  assert.equal(kubectlFailureStatus(`untrusted ${marker} Forbidden`), 500);
});
