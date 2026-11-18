import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName } from './identity.ts';

// Upstream startLocalTunnelDebugSession (localtunneldebugger.ts#L13-L35, registered at
// extension.ts#L205 with the raw explorer target) resolves the provider from the configured
// setting `getLocalTunnelDebugProvider()` otherwise the FIRST id of the registered providers
// sorted lexicographically, finds it by exact id, and on a hit calls
// providerToUse.startLocalTunnelDebugging(target) as a VOID fire-and-forget; otherwise it prompts
// `You have configured VSCode to use Local Tunnel debugger '<name>', but it is not installed.`
// when a configured provider is missing, or 'You do not have a Local Tunnel Debug Provider
// installed.' when zero providers are registered, handing both to promptToFindOnMarketplace.
// Registrations log `Registered local tunnel debugger type <id>`; the provider interface is the
// bare { id, startLocalTunnelDebugging(target?) } and the v1 API only forwards registration.
// DELIVERY NOTE: this increment ships the bounded protocol and the upstream-verbatim pure
// projections under static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — a REAL Telepresence provider must run the session in the HUMAN package environment (NORMAL case: the configured provider otherwise the first sorted id starts directly with the target — the upstream
// void dispatch is never treated as a complete run; MISSING case: a missing configured provider or
// zero providers prompts explicitly and only the user's Find choice opens the search — never
// silently switching providers, installing, or starting; TARGET_RISK case: the original
// Pod/Job/Service/Deployment identity with its backend/workspace is bound, and the server-side
// execution plus traffic and agent injection is explicit — an unconfirmed forward of an arbitrary
// target never happens; STOP_UNKNOWN case: real state, debugging, stop/restore and accounting are
// implemented independently — a cancellation is not a traffic restoration, and a Compose exit
// never runs the business cleanup). No automated execution exists anywhere.
const token253 = boundedName.max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const startTarget = z.object({ protocol: z.literal(2), kind: z.literal('start'), targetKind: z.enum(['pod', 'job', 'service', 'deployment']).optional(), targetName: token253.optional(), namespace: token253.optional() }).strict().refine(value => (value.targetName === undefined && value.namespace === undefined) || value.targetKind !== undefined, { message: 'a named target requires its kind' });
export const debugLocalTunnelRequestSchema = z.discriminatedUnion('kind', [
  startTarget,
]);
export type DebugLocalTunnelRequest = z.infer<typeof debugLocalTunnelRequestSchema>;
export const debugLocalTunnelResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('provider-started'), providerId: boundedName.max(128) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('configured-provider-missing'), providerId: boundedName.max(128) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('no-provider-installed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('start-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type DebugLocalTunnelResponse = z.infer<typeof debugLocalTunnelResponseSchema>;
// Upstream provider resolution verbatim: the configured setting, otherwise the first sorted id.
export function selectProviderId(providerSetting: string | undefined, providerIds: readonly string[]): string | undefined {
  return providerSetting ? providerSetting : [...providerIds].sort()[0];
}
// Upstream messages verbatim.
export function configuredProviderMissingMessage(providerName: string): string {
  return `You have configured VSCode to use Local Tunnel debugger '${providerName}', but it is not installed.`;
}
export function noProviderInstalledMessage(): string {
  return 'You do not have a Local Tunnel Debug Provider installed.';
}
export function registeredProviderLogMessage(id: string): string {
  return `Registered local tunnel debugger type ${id}`;
}
// Upstream identity binding verbatim: the provider is found by EXACT id — never a fuzzy or
// first-item fallback.
export function findProviderById(providers: readonly { id: string }[], providerName: string | undefined): { id: string } | undefined {
  return providers.find((p) => p.id === providerName);
}
