import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts';
import { targetSchema } from './identity.ts';
import { configSelectionSchema } from './configuration.ts';

// Upstream syncKubernetes (extension.ts#L1506-L1538 + components/git/git.ts#L13-L27): pick an App
// APPROVED batch-2 G4 chain: the checkout verb has real server-side execution below.
// pod, pick a container, split the image on ':' — the tag MUST be the only colon-suffixed piece
// and is treated as a Git commit ID — show a version message (with the relative creation time when
// `git log --pretty=%ar -n 1 <id>` resolves it), and only on the explicit OK action run
// `git checkout <id>` (never force/reset; a failed checkout reports stderr). DELIVERY NOTE: this
// increment ships the bounded protocol and the upstream-verbatim pure projections under static
// review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the chain needs the cluster pod/
// container reads plus the host picker and the OK confirmation (a host UI gate), and the checkout
// switches the user's own working tree. It runs in the HUMAN package environment (the human's own
// repo and cluster view); no automated execution exists anywhere.
export const imageReference = z.string().min(1).max(512).refine(value => !/[\r\n\t]/.test(value));
export const gitSyncRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), root: workspaceRootSchema, path: workspaceRelativeSchema, image: imageReference }).strict(),
]);
export type GitSyncRequest = z.infer<typeof gitSyncRequestSchema>;
export const gitSyncResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('git-synced'), commitId: z.string().min(1).max(128), whenCreated: z.string().max(256).nullable() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('git-sync-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type GitSyncResponse = z.infer<typeof gitSyncResponseSchema>;
// ---- Approved batch-2 G4 chain (real server-side execution) ----
export const gitSyncParametersSchema = z.object({ root: workspaceRootSchema, path: workspaceRelativeSchema, image: imageReference,
  commitId: z.string().min(1).max(128), whenCreated: z.string().max(256).nullable() }).strict()
  .refine(value => value.whenCreated === null || value.whenCreated.length > 0)
  // The commit ID is only ever the tag piece of the image (the upstream split rule); a leading
  // '-' can never become a git option.
  .refine(value => { const pieces = value.image.split(':'); return value.commitId === pieces[1] && !value.commitId.startsWith('-'); });
export type GitSyncParameters = z.infer<typeof gitSyncParametersSchema>;
export const gitSyncViewGrantSchema = z.object({ id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), serviceGeneration: z.string().uuid(), expiresAt: z.number().int().nonnegative() }).strict();
export type GitSyncViewGrant = z.infer<typeof gitSyncViewGrantSchema>;
export const gitSyncOutcomeSchema = z.object({ id: z.string().uuid(), owner: z.string().uuid(), step: z.literal('git-sync'), dependencies: z.tuple([]), target: targetSchema, parameters: gitSyncParametersSchema,
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'queued', 'checking', 'dispatching', 'accepted', 'failed', 'unknown', 'cancelled']), code: z.enum(errorCodes).optional() }).strict()
  .refine(value => value.phase !== 'accepted' || value.code === undefined);
export type GitSyncOutcome = z.infer<typeof gitSyncOutcomeSchema>;
export const gitSyncGateRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('open'), selection: configSelectionSchema, target: targetSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), grant: gitSyncViewGrantSchema, parameters: gitSyncParametersSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: gitSyncViewGrantSchema, id: z.string().uuid(), proof: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal('git-sync-exact-checkout') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: gitSyncViewGrantSchema, id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('close'), grant: gitSyncViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type GitSyncGateRequest = z.infer<typeof gitSyncGateRequestSchema>;
export const gitSyncGateResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('view'), grant: gitSyncViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), outcome: gitSyncOutcomeSchema, proof: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: gitSyncOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('closed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(gitSyncOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
export type GitSyncGateResponse = z.infer<typeof gitSyncGateResponseSchema>;
// Upstream tag rule verbatim: split on ':' must yield exactly two pieces; the second is the commit.
// (Upstream quirk preserved: a registry-port reference like registry:5000/app has two pieces and
// the port/path fragment is returned; registry:5000/app:v1 has three pieces and is rejected.)
export function imageTagCommit(image: string): string | null {
  const pieces = image.split(':');
  const tag = pieces[1];
  if (pieces.length !== 2 || tag === undefined) return null;
  return tag.length > 0 && tag.length <= 128 ? tag : null;
}
// Upstream version message shapes verbatim (both branches).
export function syncVersionMessage(commitId: string, whenCreated: string | null): string {
  return whenCreated ?
    `The Git commit deployed to the cluster is  ${commitId} (created ${whenCreated.trim()} ago). This will check out that commit.` :
    `The image version deployed to the cluster is ${commitId}. This will look for a Git commit with that name/ID and check it out.`;
}
// Upstream git command shapes verbatim: a read-only creation-time probe, then the OK-gated checkout.
export function gitWhenCreatedArguments(commitId: string): readonly string[] {
  return ['log', '--pretty=%ar', '-n', '1', commitId];
}
export function gitCheckoutArguments(commitId: string): readonly string[] {
  return ['checkout', commitId];
}
