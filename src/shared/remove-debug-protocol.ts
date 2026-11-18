import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName } from './identity.ts';

// Upstream removeDebugKubernetes (extension.ts#L1975-L2000, registered at #L203) derives the
// legacy fixed debug name `name + '-debug'` from the open workspace folder, probes deployments and
// services with `get <kind> <name>`; when neither exists it shows '<name>: nothing to clean up';
// otherwise it warns `This will delete <deployment[ and service]|service> <name>` with the single
// button 'Delete' — anything but 'Delete' deletes nothing — and only then issues the INDEPENDENT,
// non-awaited deletes 'delete service <name>' and 'delete deployment <name>' (each with its own
// result). The session leg (debugSession.ts#L371-L395) warns `Resource <id> will continue running
// on the cluster.` with 'Clean Up'/'Always Clean Up', then runs `delete <id>` with the output
// texts 'Starting to clean up debug resource...' and 'Resource <id> is removed successfully.'.
// DELIVERY NOTE: this increment ships the bounded protocol and the upstream-verbatim pure
// projections under static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the cluster probes and deletes run in the HUMAN package environment (NORMAL case: only an explicit Delete
// removes the confirmed debug Deployment/Service, never a generic sweep of all -debug resources;
// CANCEL_EMPTY case: no resources yield the explicit nothing message, a closed warning deletes
// nothing, and a failed read is never faked as absence; PARTIAL_UNKNOWN case: every delete keeps
// an independent result and dependency, a failed or unknown delete never falls through, replays or
// reports all-success; SCOPE case: the legacy fixed name and provider timestamp names differ, so a
// workspace name never deletes someone else's resources, and a Compose stop or adapter exit
// never auto-runs this cleanup). No automated execution exists anywhere.
const token253 = boundedName.max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const removeDebugRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('remove'), name: token253 }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cleanup-session'), resourceId: boundedName.max(512) }).strict(),
]);
export type RemoveDebugRequest = z.infer<typeof removeDebugRequestSchema>;
export const removeDebugResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('nothing-to-clean-up') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation-requested'), hasDeployment: z.boolean(), hasService: z.boolean() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation-cancelled') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cleanup-scheduled'), service: z.boolean(), deployment: z.boolean() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('session-cleanup-completed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('remove-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type RemoveDebugResponse = z.infer<typeof removeDebugResponseSchema>;
// Upstream legacy debug name verbatim: the workspace name plus '-debug'.
export function debugResourceName(name: string): string {
  return name + '-debug';
}
// Upstream messages verbatim.
export function nothingToCleanUpMessage(deploymentName: string): string {
  return deploymentName + ': nothing to clean up';
}
export function toDeleteDescription(hasDeployment: boolean, hasService: boolean): string {
  return hasDeployment ? ('deployment' + (hasService ? ' and service' : '')) : 'service';
}
export function deleteConfirmationMessage(toDelete: string, deploymentName: string): string {
  return `This will delete ${toDelete} ${deploymentName}`;
}
export function confirmationErrorMessage(err: string): string {
  return `Error getting confirmation of delete: ${err}`;
}
export function resourceContinueMessage(resourceId: string): string {
  return `Resource ${resourceId} will continue running on the cluster.`;
}
export function startingCleanupMessage(): string {
  return 'Starting to clean up debug resource...';
}
export function resourceRemovedMessage(resourceId: string): string {
  return `Resource ${resourceId} is removed successfully.`;
}
// Upstream button labels verbatim.
export const DELETE_BUTTON = 'Delete';
export const CLEAN_UP_BUTTON = 'Clean Up';
export const ALWAYS_CLEAN_UP_BUTTON = 'Always Clean Up';
// Upstream invocation shapes verbatim: 'delete service <name>' / 'delete deployment <name>' and
// the session leg `delete ${resourceId}` — independent deletes, never a combined sweep.
export function deleteServiceArguments(deploymentName: string): readonly string[] {
  return ['delete', 'service', deploymentName];
}
export function deleteDeploymentArguments(deploymentName: string): readonly string[] {
  return ['delete', 'deployment', deploymentName];
}
export function cleanupResourceArguments(resourceId: string): readonly string[] {
  return ['delete', ...resourceId.split(' ')];
}
