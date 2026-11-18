import { z } from 'zod';
import { errorCodes } from './errors.ts';

// Upstream createClusterKubernetes (extension.ts#L2083-L2093, registered at #L209) first runs
// selectProvider() (extension.ts#L2021-L2051): with debounceActivation the ONLY registered
// provider is AKSProvider, picked via quick pick with placeHolder 'Select the cluster type'
// (a cancellation yields 'Failed to get cluster type', a missing match 'Failed to get provider'),
// then a sign-in check whose failure shows `Failed to sign in to <name>`; on success the command
// runs prerequisites() for the subscription and delegates createCluster(subscriptionId) to the
// provider. The AKS provider (aksprovider.ts#L44-L68) delegates creation to the EXTERNAL
// extension 'ms-kubernetes-tools.vscode-aks-tools' via executeCommand('aks.createCluster', inputs);
// when it is absent upstream offers 'The Azure Kubernetes Service extension is required to create
// a cluster. Do you want to install it?' with 'Install'/'Cancel' and may install the extension
// itself. DELIVERY NOTE: this increment ships the bounded protocol and the upstream-verbatim pure
// projections under static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the provider
// sign-in, the subscription prerequisites and the external aks.createCluster delegation run in
// the HUMAN package environment (DELEGATION case: after selecting AKS the command delegates to the external aks.createCluster extension — the old Azure/Minikube wizard in activation never
// impersonates a reachable creation chain; DEPENDENCY case: upstream may offer installing
// ms-kubernetes-tools.vscode-aks-tools, and this plugin never installs VS Code extensions, fake
// APIs, or omits the real cloud creation; CANCEL_FAILURE case: a cancelled selection, sign-in or
// parameter run creates nothing, a missing dependency or API failure is explicit, and unverified
// real parameter/version contracts are never called feasible; UNKNOWN_COST case: after a create
// is submitted a disconnect or cancellation leaves the cloud result and cost risk unknown — never
// auto-recreated, resources deleted, or the account switched, and follow-up configuration waits
// for the definite result). No automated execution exists anywhere.
export const createClusterRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('create') }).strict(),
]);
export type CreateClusterRequest = z.infer<typeof createClusterRequestSchema>;
export const createClusterResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('provider-required') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('subscription-required') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('delegation-prompted'), extensionInstalled: z.boolean() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('delegated') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('create-cancelled') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('create-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type CreateClusterResponse = z.infer<typeof createClusterResponseSchema>;
// Upstream provider-selection texts verbatim.
export function selectClusterTypePlaceholder(): string {
  return 'Select the cluster type';
}
export function failedClusterTypeMessage(): string {
  return 'Failed to get cluster type';
}
export function failedProviderSelectionMessage(): string {
  return 'Failed to get provider';
}
export function failedSignInMessage(providerName: string): string {
  return `Failed to sign in to ${providerName}`;
}
// Upstream external-dependency texts verbatim.
export function aksExtensionId(): string {
  return 'ms-kubernetes-tools.vscode-aks-tools';
}
export function delegatedCreateClusterCommandId(): string {
  return 'aks.createCluster';
}
export function extensionRequiredMessage(): string {
  return 'The Azure Kubernetes Service extension is required to create a cluster. Do you want to install it?';
}
export const INSTALL_BUTTON = 'Install';
export const CANCEL_BUTTON = 'Cancel';
// Upstream gate verbatim: only the exact 'Install' choice installs and then delegates.
export function shouldInstallDependency(selection: string | undefined): boolean {
  return selection === 'Install';
}
