import { z } from 'zod';
import { errorCodes } from './errors.ts';

// Upstream configureFromClusterKubernetes (extension.ts#L2054-L2079, registered at #L208) runs
// debounceActivation then selectProvider() — on failure it shows provider.error[0]; prerequisites
// (aksprovider.ts#L8-L42) lists subscriptions under progress 'Getting Azure subscriptions', shows
// `Failed to get subscriptions for <name>` when empty, picks by name with placeHolder
// 'Select the subscription' (`Failed to get subscription for <name>` on cancel) and resolves the
// subscriptionId by EXACT name match; the AKS-only leg then selectCluster(subscriptionId) — whose
// failures report 'You must be signed into Azure to list clusters.',
// `Network error querying Resource Graph: <message>` and `Resource Graph failed: <status>
// <statusText>` — then getKubeconfigYaml (failures 'Failed to get credentials for AKS.',
// 'Failed to retrieve kubeconfig from AKS.', `Error fetching kubeconfig: <message>`), and on a
// yaml calls mergeToKubeconfig(kconfig) (NOT awaited upstream), else shows
// 'Failed to get kubeconfig'. DELIVERY NOTE: this increment ships the bounded protocol and the
// upstream-verbatim pure projections under static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the Azure sign-in, subscription/cluster listing, user-credential acquisition and the
// M4 kubeconfig merge run in the HUMAN package environment (NORMAL case: AKS provider selection,
// sign-in, subscription and cluster selection and user-credential acquisition precede the M4
// merge, and the old wizard entry is never used; CANCEL case: a cancelled selection or sign-in
// starts no follow-up, and once credential acquisition is submitted its real result stands — an
// unwritten config is not a zero-side-effect claim; FAILURE_UNKNOWN case: account, cloud request,
// decoding, conflict and file failures each keep their own class, an unknown result never
// re-fetches credentials or replays the merge, and raw tokens/configs never enter the panel or
// logs; IDENTITY case: the real account tenant, subscription, resource group and cluster bind to
// the original configuration — a same-name list's first item or a fake pod target never
// authorises anything). No automated execution exists anywhere.
export const configureFromClusterRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('configure') }).strict(),
]);
export type ConfigureFromClusterRequest = z.infer<typeof configureFromClusterRequestSchema>;
export const configureFromClusterResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('provider-required') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('subscription-required') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cluster-required') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('kubeconfig-required') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('merge-initiated') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('configure-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type ConfigureFromClusterResponse = z.infer<typeof configureFromClusterResponseSchema>;
// Upstream provider and subscription texts verbatim.
export function providerName(): string {
  return 'Azure Kubernetes Service (AKS)';
}
export function gettingSubscriptionsProgress(): string {
  return 'Getting Azure subscriptions';
}
export function failedSubscriptionsMessage(name: string): string {
  return `Failed to get subscriptions for ${name}`;
}
export function selectSubscriptionPlaceholder(): string {
  return 'Select the subscription';
}
export function failedSubscriptionMessage(name: string): string {
  return `Failed to get subscription for ${name}`;
}
// Upstream command-level messages verbatim.
export function failedKubeconfigMessage(): string {
  return 'Failed to get kubeconfig';
}
// Upstream cloud-leg messages verbatim.
export function mustBeSignedInMessage(): string {
  return 'You must be signed into Azure to list clusters.';
}
export function networkErrorMessage(message: string): string {
  return `Network error querying Resource Graph: ${message}`;
}
export function resourceGraphFailedMessage(status: number, statusText: string): string {
  return `Resource Graph failed: ${status} ${statusText}`;
}
export function failedCredentialsMessage(): string {
  return 'Failed to get credentials for AKS.';
}
export function failedRetrieveKubeconfigMessage(): string {
  return 'Failed to retrieve kubeconfig from AKS.';
}
export function errorFetchingKubeconfigMessage(message: string): string {
  return `Error fetching kubeconfig: ${message}`;
}
// Upstream identity binding verbatim: the subscriptionId comes from an EXACT name match — never
// the first item of a same-name list.
export function subscriptionIdByName(subscriptions: readonly { name: string; subscriptionId: string }[], selectedName: string): string | undefined {
  return subscriptions.find((sub) => sub.name === selectedName)?.subscriptionId;
}
