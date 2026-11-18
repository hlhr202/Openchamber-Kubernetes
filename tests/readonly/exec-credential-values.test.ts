// Pure protocol values only. Never import/call the exec adapter (it runs external commands).
import assert from 'node:assert/strict';
import test from 'node:test';
import { execPluginSpecSchema, execCredentialSchema, execCredentialCacheKey, execCredentialExpiryMs, execCredentialRequestDocument, execCredentialCacheLimits, execCredentialApiVersions } from '../../src/shared/exec-credential-protocol.ts';
import { createAuthenticationCache, execAuthenticationInput } from '../../src/service/queries/authentication-cache.ts';
import { createConfigReader } from '../../src/service/queries/config-source.ts';
import { privateKubectlConfiguration, validateKubectlSnapshot } from '../../src/service/queries/kubectl-configuration.ts';
import { projectConfigPage } from '../../src/service/queries/config-page.ts';
import { createCredentialFlightState } from '../../src/service/queries/credential-flight.ts';

const spec = { apiVersion: 'client.authentication.k8s.io/v1' as const, command: '/usr/local/bin/example-credential-plugin', args: ['get-token'], env: [{ name: 'EXAMPLE_TENANT', value: 'test' }] };
const credential = { apiVersion: 'client.authentication.k8s.io/v1' as const, kind: 'ExecCredential' as const, status: { token: 'opaque', expirationTimestamp: '2026-11-16T12:00:00Z' } };
test('plugin spec accepts only the two upstream apiVersions with bounded command/args/env', () => {
  assert.equal(execPluginSpecSchema.safeParse(spec).success, true);
  assert.equal(execPluginSpecSchema.safeParse({ ...spec, apiVersion: 'client.authentication.k8s.io/v1beta1' }).success, true);
  for (const bad of [
    { ...spec, apiVersion: 'client.authentication.k8s.io/v2' },
    { ...spec, command: '' },
    { ...spec, args: ['a', ''] },
    { ...spec, env: [{ name: '2BAD', value: 'x' }] },
    { ...spec, installHint: 'run curl ...' }, // install hints are never an input surface here
  ]) assert.equal(execPluginSpecSchema.safeParse(bad).success, false, JSON.stringify(bad));
});
test('ExecCredential output requires kind + a token or a complete client certificate pair', () => {
  assert.equal(execCredentialSchema.safeParse(credential).success, true);
  assert.equal(execCredentialSchema.safeParse({ ...credential, status: { clientCertificateData: 'CERT', clientKeyData: 'KEY' } }).success, true);
  for (const bad of [
    { ...credential, kind: 'ExecCredentialList' },
    { ...credential, status: {} },
    { ...credential, status: { clientCertificateData: 'CERT' } }, // key missing
    { ...credential, status: { token: '' } },
    { ...credential, status: { token: 'x', extra: true } },
  ]) assert.equal(execCredentialSchema.safeParse(bad).success, false, JSON.stringify(bad));
  assert.deepEqual([...execCredentialApiVersions], ['client.authentication.k8s.io/v1', 'client.authentication.k8s.io/v1beta1']);
});
test('cache key is stable per spec identity and independent of expiry or credential values', () => {
  assert.equal(execCredentialCacheKey(spec), execCredentialCacheKey({ ...spec }));
  assert.notEqual(execCredentialCacheKey(spec), execCredentialCacheKey({ ...spec, args: ['other'] }));
  assert.notEqual(execCredentialCacheKey(spec), execCredentialCacheKey({ ...spec, env: [] }));
  assert.ok(!execCredentialCacheKey(spec).includes('\n'));
});
test('expiry math caps caching at expiration minus 30s and never beyond 15 minutes', () => {
  const now = Date.parse('2026-11-16T11:00:00Z');
  // A 10-minute credential: expiry wins (10 min minus the 30s safety margin).
  assert.equal(execCredentialExpiryMs({ expirationTimestamp: '2026-11-16T11:10:00Z' }, now), Date.parse('2026-11-16T11:10:00Z') - 30_000);
  // A one-hour credential: the 15-minute cache cap wins instead.
  assert.equal(execCredentialExpiryMs({ expirationTimestamp: '2026-11-16T12:00:00Z' }, now), now + execCredentialCacheLimits.maxLifetimeMs);
  const far = execCredentialExpiryMs({ expirationTimestamp: '2027-11-16T12:00:00Z' }, now);
  assert.equal(far, now + execCredentialCacheLimits.maxLifetimeMs);
  assert.equal(execCredentialExpiryMs({}, now), undefined);
  assert.equal(execCredentialExpiryMs({ expirationTimestamp: 'not-a-time' }, now), undefined);
  assert.deepEqual({ ...execCredentialCacheLimits }, { maxEntries: 8, safetyMarginMs: 30_000, maxLifetimeMs: 900_000, stdoutMaxBytes: 262_144, runTimeoutMs: 10_000 });
});
test('the exec info document is the fixed non-interactive request', () => {
  const document = execCredentialRequestDocument('client.authentication.k8s.io/v1');
  assert.deepEqual(JSON.parse(document), { apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', spec: { interactive: false } });
  assert.equal(execCredentialRequestDocument('client.authentication.k8s.io/v1beta1').includes('v1beta1'), true);
});
test('GKE declaration fields and standard ExecCredential spec are supported without exposing credential bytes', () => {
  assert.equal(execPluginSpecSchema.safeParse({ ...spec, interactiveMode: 'IfAvailable', provideClusterInfo: true }).success, true);
  assert.equal(execCredentialSchema.safeParse({ ...credential, spec: {} }).success, true);
  const cluster = { server: 'https://synthetic.invalid', 'certificate-authority-data': 'U1lOVEhFVElD' };
  assert.deepEqual(JSON.parse(execCredentialRequestDocument(spec.apiVersion, cluster)).spec, { interactive: false, cluster });
});
test('credential admission coalesces same config/context and keeps a slot until actual settlement after last cancellation', () => {
  const model = createCredentialFlightState(), a = model.join('config-a/context'), b = model.join('config-a/context');
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.ticket, b.ticket);
  assert.deepEqual(model.counts, { running: 1, consumers: 2 });
  assert.equal(model.leave(a.ticket, a.consumer), false);
  assert.equal(model.usable(a.ticket), true);
  assert.equal(model.leave(b.ticket, b.consumer), true);
  assert.equal(model.usable(a.ticket), false);
  assert.deepEqual(model.counts, { running: 1, consumers: 0 });
  const next = model.join('config-a/context');
  assert.notEqual(next.ticket, a.ticket);
  assert.throws(() => model.join('third/context'), /QUERY_LIMIT/);
  model.settle(a.ticket);
  assert.deepEqual(model.counts, { running: 1, consumers: 1 });
  model.settle(next.ticket);
  assert.deepEqual(model.counts, { running: 0, consumers: 0 });
});
test('credential admission caps consumers and service close forbids late publication or new starts', () => {
  const model = createCredentialFlightState();
  const leases = Array.from({ length: 64 }, () => model.join('same'));
  assert.throws(() => model.join('same'), /QUERY_LIMIT/);
  assert.deepEqual(model.close(), [leases[0]?.ticket]);
  assert.equal(model.usable(leases[0]!.ticket), false);
  assert.throws(() => model.join('new'), /SERVICE_CLOSED/);
  model.settle(leases[0]!.ticket);
  assert.deepEqual(model.counts, { running: 0, consumers: 0 });
});
test('a full credential cache evicts the oldest memory entry instead of blocking the ninth cluster', () => {
  const cache = createAuthenticationCache(() => 1000);
  for (let i = 0; i < 9; i++) cache.put(`config-${i}`, 'ctx', { token: `SYNTHETIC-${i}` }, 5000);
  assert.equal(cache.has('config-0', 'ctx'), false);
  for (let i = 1; i < 9; i++) assert.equal(cache.has(`config-${i}`, 'ctx'), true);
});
test('a late unauthorized response only invalidates its own credential, not a newer credential', async () => {
  const cache = createAuthenticationCache(() => 1000);
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({
    'current-context': 'ctx', clusters: [{ name: 'c', cluster: { server: 'https://synthetic.invalid' } }],
    users: [{ name: 'u', user: { exec: { apiVersion: spec.apiVersion, command: spec.command, interactiveMode: 'Never' } } }],
    contexts: [{ name: 'ctx', context: { cluster: 'c', user: 'u' } }],
  }) }));
  const read = await config.read({ mode: 'default' }), identity = read.snapshot.configIdentity;
  const { merged } = await config.privateRead({ mode: 'default' }, identity);
  cache.put(identity, 'ctx', { token: 'SYNTHETIC_OLD' }, 5000);
  const old = cache.apply(merged, identity);
  cache.put(identity, 'ctx', { token: 'SYNTHETIC_NEW' }, 6000);
  cache.reject(old, identity); assert.equal(cache.has(identity, 'ctx'), true);
  cache.reject(cache.apply(merged, identity), identity); assert.equal(cache.has(identity, 'ctx'), false);
  cache.put(identity, 'ctx', { token: 'SYNTHETIC_NEW' }, 6000); cache.clear();
  assert.equal(cache.has(identity, 'ctx'), false);
});
test('transport credential projection rechecks source identity after awaiting the memory snapshot, without any authentication executor', async () => {
  let reads = 0, driftAt = Number.POSITIVE_INFINITY;
  const cache = createAuthenticationCache(() => 1000);
  const config = createConfigReader('/synthetic/config', async path => {
    reads++;
    return { sourcePath: path, content: JSON.stringify({
      'current-context': 'ctx', clusters: [{ name: 'c', cluster: { server: reads >= driftAt ? 'https://changed.invalid' : 'https://synthetic.invalid' } }],
      users: [{ name: 'u', user: { exec: { apiVersion: spec.apiVersion, command: spec.command, interactiveMode: 'Never' } } }],
      contexts: [{ name: 'ctx', context: { cluster: 'c', user: 'u' } }],
    }) };
  }, cache.apply);
  const selection = { mode: 'default' as const }, publicRead = await config.read(selection), identity = publicRead.snapshot.configIdentity;
  cache.put(identity, 'ctx', { token: 'SYNTHETIC_CACHE_ONLY' }, 5000);
  driftAt = reads + 2; // transport pre-read matches; the required post-projection read changes.
  await assert.rejects(config.transportRead(selection, identity), /STALE_TARGET/);
  assert.equal(reads, 3);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(config.transportRead(selection, identity, controller.signal), /QUERY_CANCELLED/);
  assert.equal(reads, 3);
});
test('authorized memory projection supplies static transport credentials only for exact unexpired identity; raw/public configs remain untouched', async () => {
  let now = 1000, changed = false;
  const cache = createAuthenticationCache(() => now);
  const config = createConfigReader('/synthetic/config', async path => ({ sourcePath: path, content: JSON.stringify({
    'current-context': 'gke-200',
    clusters: [{ name: 'c', cluster: { server: changed ? 'https://changed.invalid' : 'https://synthetic.invalid' } }],
    users: [{ name: 'u', user: { exec: { apiVersion: 'client.authentication.k8s.io/v1beta1', command: './bin/gke-gcloud-auth-plugin', args: null, env: null,
      installHint: 'SYNTHETIC_INSTALL_HINT', interactiveMode: 'IfAvailable', provideClusterInfo: true } } }],
    contexts: Array.from({ length: 201 }, (_, i) => ({ name: `gke-${i}`, context: { cluster: 'c', user: 'u' } })),
  }) }), cache.apply);
  const selection = { mode: 'default' as const }, publicRead = await config.read(selection), identity = publicRead.snapshot.configIdentity;
  const raw = await config.privateRead(selection, identity), target = { serviceGeneration: 's', projectId: 'p', configIdentity: identity, context: 'gke-200', namespace: 'default' };
  const input = execAuthenticationInput(raw.merged);
  assert.equal(input.spec.command, '/synthetic/bin/gke-gcloud-auth-plugin');
  assert.equal(Object.hasOwn(input.spec, 'installHint'), false);
  const page = projectConfigPage(publicRead, 's', { offset: 0, limit: 100 });
  assert.equal(page.contexts.some(c => c.active), false);
  assert.deepEqual(page.currentContextInfo?.authentication?.methods, ['exec']);
  await assert.rejects(config.transportRead(selection, identity), /AUTHENTICATION_UNAVAILABLE/);
  cache.put(identity, target.context, { token: 'SYNTHETIC_TEMPORARY_TOKEN' }, 5000);
  const transport = await config.transportRead(selection, identity), bytes = privateKubectlConfiguration(transport.merged, target);
  validateKubectlSnapshot(bytes, target);
  assert.ok(Buffer.from(bytes).toString().includes('SYNTHETIC_TEMPORARY_TOKEN'));
  assert.ok(!Buffer.from(bytes).toString().includes('exec'));
  bytes.fill(0);
  assert.ok(!JSON.stringify(await config.read(selection)).includes('SYNTHETIC_TEMPORARY_TOKEN'));
  assert.throws(() => privateKubectlConfiguration(raw.merged, target), /AUTHENTICATION_UNAVAILABLE/);
  changed = true;
  await assert.rejects(config.transportRead(selection, identity), /STALE_TARGET/);
  const nextIdentity = (await config.read(selection)).snapshot.configIdentity;
  await assert.rejects(config.transportRead(selection, nextIdentity), /AUTHENTICATION_UNAVAILABLE/);
  changed = false; now = 5000;
  await assert.rejects(config.transportRead(selection, identity), /AUTHENTICATION_UNAVAILABLE/);
});
