import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts';
import { boundedName, targetSchema } from './identity.ts';
import { configSelectionSchema } from './configuration.ts';

// Upstream runKubernetes (extension.ts#L986-L1042 + image/imageUtils.ts#L29-L60 +
// APPROVED batch-2 G4 chain: the run verb has real server-side execution below.
// image/imageToolRegistry.ts#L7-L64): derive the image name from the workspace folder basename
// (docker tag sanitisation), read the version, optionally prefix the configured image user, build
// with the detected tool (docker build / buildah bud), push, and only after BOTH succeed run
// `kubectl run <name> --image=<image>` (here: ONE direct POST of the kubectl-run-shaped Pod).
// Push errors are diagnosed with the vsdocker.imageUser hint. The G4 chain below is the real
// server-side execution: ONE 60s confirmation pins the exact root/version/image, then a single
// sequential dispatch (build -> push -> Pod POST); the first failure stops the chain and a
// dispatched-but-unfinished step is only reported, never retried or rolled back.
export const runImageUser = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
export const runVersion = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const imageRunRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), root: workspaceRootSchema, path: workspaceRelativeSchema, user: runImageUser.optional(), version: runVersion }).strict(),
]);
export type ImageRunRequest = z.infer<typeof imageRunRequestSchema>;
export const imageRunResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('image-run'), name: boundedName, image: z.string().min(1).max(512), built: z.boolean(), pushed: z.boolean(), ran: z.boolean() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('image-run-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type ImageRunResponse = z.infer<typeof imageRunResponseSchema>;
// ---- Approved batch-2 G4 chain (real server-side execution) ----
// The build context is ONE canonical Server workspace root; the image reference is derived
// server-side from the root basename + version (+ optional user prefix) exactly like upstream.
export const imageRunParametersSchema = z.object({ root: workspaceRootSchema, contextPath: workspaceRelativeSchema,
  version: runVersion, user: runImageUser.optional(), image: z.string().min(1).max(512), name: boundedName.max(253) }).strict()
  .refine(value => value.image === (value.user ? `${value.user}/${value.name}:${value.version}` : `${value.name}:${value.version}`));
export type ImageRunParameters = z.infer<typeof imageRunParametersSchema>;
export const imageRunViewGrantSchema = z.object({ id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), serviceGeneration: z.string().uuid(), expiresAt: z.number().int().nonnegative() }).strict();
export type ImageRunViewGrant = z.infer<typeof imageRunViewGrantSchema>;
export const imageRunOutcomeSchema = z.object({ id: z.string().uuid(), owner: z.string().uuid(), step: z.literal('image-run'), dependencies: z.tuple([]), target: targetSchema, parameters: imageRunParametersSchema,
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'queued', 'checking', 'dispatching', 'accepted', 'failed', 'unknown', 'cancelled']), code: z.enum(errorCodes).optional(),
  built: z.boolean().optional(), pushed: z.boolean().optional(), podUid: boundedName.optional(), podResourceVersion: boundedName.optional() }).strict()
  .refine(value => value.phase !== 'accepted' || value.code === undefined)
  .refine(value => value.phase !== 'accepted' || value.built === true && value.pushed === true && value.podUid !== undefined && value.podResourceVersion !== undefined)
  .refine(value => (value.phase === 'prepared' || value.phase === 'queued' || value.phase === 'checking') || value.built !== undefined)
  // The Pod identity exists only on a fully accepted chain; build-only outcomes never claim it.
  .refine(value => value.podUid === undefined && value.podResourceVersion === undefined || value.phase === 'accepted');
export type ImageRunOutcome = z.infer<typeof imageRunOutcomeSchema>;
export const imageRunGateRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('open'), selection: configSelectionSchema, target: targetSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), grant: imageRunViewGrantSchema, parameters: imageRunParametersSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: imageRunViewGrantSchema, id: z.string().uuid(), proof: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal('image-run-exact-build-push-pod') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: imageRunViewGrantSchema, id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('close'), grant: imageRunViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type ImageRunGateRequest = z.infer<typeof imageRunGateRequestSchema>;
export const imageRunGateResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('view'), grant: imageRunViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), outcome: imageRunOutcomeSchema, proof: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: imageRunOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('closed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(imageRunOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
export type ImageRunGateResponse = z.infer<typeof imageRunGateResponseSchema>;
// Upstream docker tag sanitisation verbatim: lowercase, then every non [a-z0-9._-] rune becomes '-'
// (the upstream does not trim leading/trailing separators — quirk preserved and disclosed).
export function sanitiseTag(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}
// Upstream findNameAndImageInternal verbatim: <sanitised-folder>:<version> with optional user prefix.
export function runImageReference(folderName: string, version: string, user: string | undefined): { readonly name: string; readonly image: string } {
  const name = sanitiseTag(folderName);
  const image = user ? `${user}/${name}:${version}` : `${name}:${version}`;
  return { name: name.trim(), image: image.trim() };
}
// Upstream tool command shapes verbatim: docker build / buildah bud; push identical for both.
export type ImageBuildTool = 'Docker' | 'Buildah';
export function buildCommand(tool: ImageBuildTool, binName: string, image: string): string {
  return `${binName} ${tool === 'Buildah' ? 'bud' : 'build'} -t ${image} .`;
}
export function pushCommand(binName: string, image: string): string {
  return `${binName} push ${image}`;
}
// Upstream kubectl invocation verbatim: run <name> --image=<image>.
export function kubectlRunArguments(name: string, image: string): readonly string[] {
  return ['run', name, `--image=${image}`];
}
// Upstream diagnosePushError branches verbatim (denied + user hint, denied without user, other).
export function diagnosePushError(exitCode: number, error: string, hasImageUser: boolean): string {
  if (error.includes('denied')) {
    return hasImageUser ?
      'Failed pushing the image to remote registry. Try to login to an image registry.' :
      'Failed pushing the image to remote registry. Try setting vsdocker.imageUser.';
  }
  return 'Image push failed.';
}
