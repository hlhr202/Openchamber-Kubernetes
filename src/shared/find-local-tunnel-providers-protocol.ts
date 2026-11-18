import { z } from 'zod';
import { errorCodes } from './errors.ts';

// Upstream kubernetesFindLocalTunnelDebugProviders (extension.ts#L2422-L2424, registered at #L206)
// calls searchMarketplace("kubernetes-extension-local-tunnel-debug-provider"), which builds
// `https://marketplace.visualstudio.com/search?term=${searchTerm}&target=VSCode&category=All%20categories&sortBy=Relevance`
// and hands it to browser.open(searchUrl) — an EXTERNAL navigation, not an install or a provider
// run. The trigger leg (localtunneldebugger.ts#L36-L44) shows an information message with the
// button "Find Providers on Marketplace" and only forwards to this command when that exact button
// is selected; a dismissal opens nothing. DELIVERY NOTE: this increment ships the bounded protocol
// and the upstream-verbatim pure projections under static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the external browser open and the interactive prompt run in the HUMAN
// package environment (PRIVACY case: the URL is the fixed Marketplace search over the fixed term
// only — never an original debug target, path or credential, and the service never auto-opens
// remote pages or registers remote code; CANCEL case: a dismissed prompt opens no page, starts no
// Telepresence and changes no configuration; FAILURE case: a failed open is distinguishable, and
// the fixed Telepresence preparation notes never substitute for the real F5 chain). No automated execution exists anywhere.
export const findLocalTunnelProvidersRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('open-search') }).strict(),
]);
export type FindLocalTunnelProvidersRequest = z.infer<typeof findLocalTunnelProvidersRequestSchema>;
export const findLocalTunnelProvidersResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('marketplace-search-opened') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('marketplace-open-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type FindLocalTunnelProvidersResponse = z.infer<typeof findLocalTunnelProvidersResponseSchema>;
// Upstream fixed search term and URL template verbatim.
export function marketplaceSearchTerm(): string {
  return 'kubernetes-extension-local-tunnel-debug-provider';
}
export function marketplaceSearchUrl(searchTerm: string): string {
  return `https://marketplace.visualstudio.com/search?term=${searchTerm}&target=VSCode&category=All%20categories&sortBy=Relevance`;
}
// Upstream prompt texts verbatim.
export function noProviderInstalledMessage(): string {
  return 'You do not have a Local Tunnel Debug Provider installed.';
}
export function findProvidersButtonLabel(): string {
  return 'Find Providers on Marketplace';
}
// Upstream gate verbatim: only the exact button selection forwards to the command.
export function shouldOpenMarketplace(selection: string | undefined): boolean {
  return selection === 'Find Providers on Marketplace';
}
