// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { debugLocalTunnelRequestSchema, debugLocalTunnelResponseSchema, selectProviderId, configuredProviderMissingMessage, noProviderInstalledMessage, registeredProviderLogMessage, findProviderById } from '../../src/shared/debug-local-tunnel-protocol.ts';
test('the request takes an optional bounded target identity and the response is a strict quartet', () => {
  assert.equal(debugLocalTunnelRequestSchema.safeParse({ protocol: 2, kind: 'start' }).success, true);
  assert.equal(debugLocalTunnelRequestSchema.safeParse({ protocol: 2, kind: 'start', targetKind: 'pod', targetName: 'web-1', namespace: 'prod' }).success, true);
  for (const bad of [{ targetKind: 'node' }, { targetKind: 'pod', targetName: '' }, { targetKind: 'pod', targetName: 'a b' }, { targetKind: 'pod', targetName: 'a'.repeat(254) }, { namespace: '-lead' }, { kind: 'stop' }, { targetName: 'x' }, { extra: 1 }]) assert.equal(debugLocalTunnelRequestSchema.safeParse({ protocol: 2, kind: 'start', ...bad }).success === false, true, JSON.stringify(bad));
  assert.equal(debugLocalTunnelResponseSchema.safeParse({ protocol: 2, kind: 'provider-started', providerId: 'telepresence' }).success, true);
  assert.equal(debugLocalTunnelResponseSchema.safeParse({ protocol: 2, kind: 'configured-provider-missing', providerId: 'telepresence' }).success, true);
  assert.equal(debugLocalTunnelResponseSchema.safeParse({ protocol: 2, kind: 'no-provider-installed' }).success, true);
  assert.equal(debugLocalTunnelResponseSchema.safeParse({ protocol: 2, kind: 'start-unavailable', code: 'CONFIG_REFERENCE_MISSING' }).success, true);
  for (const bad of [{ kind: 'provider-started' }, { kind: 'provider-started', providerId: '' }, { kind: 'configured-provider-missing' }, { kind: 'start-unavailable', code: 'NOPE' }, { kind: 'no-provider-installed', installed: true }, { kind: 'auto-started' }]) assert.equal(debugLocalTunnelResponseSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
});
test('the provider resolution and messages are upstream verbatim', () => {
  assert.equal(selectProviderId('telepresence', ['beta', 'alpha']), 'telepresence');
  assert.equal(selectProviderId(undefined, ['beta', 'alpha']), 'alpha');
  assert.equal(selectProviderId(undefined, []), undefined);
  assert.equal(configuredProviderMissingMessage('telepresence'), `You have configured VSCode to use Local Tunnel debugger 'telepresence', but it is not installed.`);
  assert.equal(noProviderInstalledMessage(), 'You do not have a Local Tunnel Debug Provider installed.');
  assert.equal(registeredProviderLogMessage('telepresence'), 'Registered local tunnel debugger type telepresence');
});
test('the provider binds by exact id with no fuzzy or first-item fallback', () => {
  const providers = [{ id: 'alpha' }, { id: 'beta' }];
  assert.equal(findProviderById(providers, 'beta')?.id, 'beta');
  assert.equal(findProviderById(providers, 'alph'), undefined);
  assert.equal(findProviderById(providers, undefined), undefined);
  assert.equal(findProviderById([], 'alpha'), undefined);
});
