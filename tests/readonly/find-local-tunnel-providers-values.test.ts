// Pure protocol/projection values only. No adapter, reader, client or route exists yet (deferred).
import assert from 'node:assert/strict';
import test from 'node:test';
import { findLocalTunnelProvidersRequestSchema, findLocalTunnelProvidersResponseSchema, marketplaceSearchTerm, marketplaceSearchUrl, noProviderInstalledMessage, findProvidersButtonLabel, shouldOpenMarketplace } from '../../src/shared/find-local-tunnel-providers-protocol.ts';
test('the request is a bare open-search and the response is a strict pair', () => {
  assert.equal(findLocalTunnelProvidersRequestSchema.safeParse({ protocol: 2, kind: 'open-search' }).success, true);
  for (const bad of [{ kind: 'install' }, { kind: 'open-search', term: 'x' }, { kind: 'open-search', url: 'https://evil' }, { extra: 1 }]) assert.equal(findLocalTunnelProvidersRequestSchema.safeParse({ protocol: 2, kind: 'open-search', ...bad }).success === false, true, JSON.stringify(bad));
  assert.equal(findLocalTunnelProvidersResponseSchema.safeParse({ protocol: 2, kind: 'marketplace-search-opened' }).success, true);
  assert.equal(findLocalTunnelProvidersResponseSchema.safeParse({ protocol: 2, kind: 'marketplace-open-unavailable', code: 'READ_TRANSPORT_UNAVAILABLE' }).success, true);
  for (const bad of [{ kind: 'marketplace-search-opened', url: 'https://evil' }, { kind: 'marketplace-open-unavailable', code: 'NOPE' }, { kind: 'marketplace-open-unavailable' }, { kind: 'provider-installed' }, { kind: 'marketplace-search-opened', target: 'pod-a' }]) assert.equal(findLocalTunnelProvidersResponseSchema.safeParse({ protocol: 2, ...bad }).success === false, true, JSON.stringify(bad));
});
test('the search term, url template and prompt texts are upstream verbatim', () => {
  assert.equal(marketplaceSearchTerm(), 'kubernetes-extension-local-tunnel-debug-provider');
  assert.equal(marketplaceSearchUrl('probe'), 'https://marketplace.visualstudio.com/search?term=probe&target=VSCode&category=All%20categories&sortBy=Relevance');
  assert.equal(marketplaceSearchUrl(marketplaceSearchTerm()), 'https://marketplace.visualstudio.com/search?term=kubernetes-extension-local-tunnel-debug-provider&target=VSCode&category=All%20categories&sortBy=Relevance');
  assert.equal(noProviderInstalledMessage(), 'You do not have a Local Tunnel Debug Provider installed.');
  assert.equal(findProvidersButtonLabel(), 'Find Providers on Marketplace');
});
test('only the exact button selection forwards and a dismissal opens nothing', () => {
  assert.equal(shouldOpenMarketplace('Find Providers on Marketplace'), true);
  assert.equal(shouldOpenMarketplace(undefined), false);
  assert.equal(shouldOpenMarketplace('find providers on marketplace'), false);
  assert.equal(shouldOpenMarketplace('OK'), false);
});
