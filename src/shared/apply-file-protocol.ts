import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts';
import { configSelectionSchema } from './configuration.ts';
import { targetSchema } from './identity.ts';
import { manifestFileSchema } from './manifest-file-protocol.ts';
import { manifestLocatorSchema } from './manifest-diff-protocol.ts';
import { workspaceProofSchema } from './workspace-protocol.ts';

// Upstream applyResourceFromUri / createResourceFromUri / deleteResourceFromUri
// (kubectlUtils.ts#L496-L523): a file-scheme URI is converted to a workspace-relative path and one
// `<command> -f "<path>"` kubectl invocation runs with the verb triplet — apply/applying/applied,
// create/creating/created, delete/deleting/deleted; delete is additionally gated on an explicit
// warning confirm ("Are you sure you want to delete this resource?" with Delete/Cancel).
// D-02 (approved 2026-11-16, option A): the apply verb now has the real server-side G4 chain
// below — a workspace file streams into <=16 strict YAML documents, each gets a fresh live proof
// (three-way merge preview when the object exists, a create preview when missing) and the batch
// is confirmed once against the exact document set, then dispatched ONE request per document
// via https-once.ts. create/delete file verbs stay on the narrow protocol + human package.
export const fileAction = z.enum(['apply', 'create', 'delete']);
export const applyFileRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), root: workspaceRootSchema, path: workspaceRelativeSchema.min(1), action: fileAction }).strict(),
]);
export type ApplyFileRequest = z.infer<typeof applyFileRequestSchema>;
export const applyFileResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('file-action-completed'), action: fileAction, path: workspaceRelativeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('file-action-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type ApplyFileResponse = z.infer<typeof applyFileResponseSchema>;
// ---- D-02 approved G4 chain (apply verb) ----
// One planned document: identity + immutable digest of its exact text + the fixed action.
export const applyFilePlanSchema = z.object({ index: z.number().int().min(0).max(15), locator: manifestLocatorSchema, action: z.enum(['apply-merge', 'create']),
  digest: z.string().regex(/^[a-f0-9]{64}$/), liveVersion: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict()
  .refine(value => value.action === 'apply-merge' ? value.liveVersion !== null : value.liveVersion === null);
export type ApplyFilePlan = z.infer<typeof applyFilePlanSchema>;
export const applyFileDocuments = 16;
export const applyFileParametersSchema = z.object({ file: manifestFileSchema, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  documents: z.array(applyFilePlanSchema).min(1).max(applyFileDocuments) }).strict()
  .refine(value => value.documents.every((plan, index) => plan.index === index));
export type ApplyFileParameters = z.infer<typeof applyFileParametersSchema>;
export const applyFileViewGrantSchema = z.object({ id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), serviceGeneration: z.string().uuid(), expiresAt: z.number().int().nonnegative() }).strict();
export type ApplyFileViewGrant = z.infer<typeof applyFileViewGrantSchema>;
export const applyFileResultSchema = z.object({ index: z.number().int().min(0).max(15), action: z.enum(['apply-merge', 'create']),
  outcome: z.enum(['pending', 'accepted', 'failed', 'unknown']), code: z.enum(errorCodes).optional(),
  resourceVersion: z.string().min(1).max(256).optional(), name: z.string().min(1).max(1024).optional() }).strict();
export type ApplyFileResult = z.infer<typeof applyFileResultSchema>;
export const applyFileOutcomeSchema = z.object({ id: z.string().uuid(), owner: z.string().uuid(), step: z.literal('apply-file'), dependencies: z.tuple([]), target: targetSchema, parameters: applyFileParametersSchema,
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'queued', 'checking', 'dispatching', 'accepted', 'failed', 'unknown', 'cancelled']), code: z.enum(errorCodes).optional(),
  results: z.array(applyFileResultSchema).max(applyFileDocuments).optional() }).strict()
  .refine(value => (value.phase === 'accepted' || value.phase === 'failed' || value.phase === 'unknown') || value.results === undefined)
  .refine(value => value.phase !== 'accepted' || value.results !== undefined && value.results.every(item => item.outcome === 'accepted'))
  .refine(value => value.phase !== 'accepted' || value.code === undefined);
export type ApplyFileOutcome = z.infer<typeof applyFileOutcomeSchema>;
export const applyFileGateRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('open'), selection: configSelectionSchema, target: targetSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), grant: applyFileViewGrantSchema, file: manifestFileSchema, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), fileProof: workspaceProofSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: applyFileViewGrantSchema, id: z.string().uuid(), proof: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal('apply-file-exact-documents') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: applyFileViewGrantSchema, id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('close'), grant: applyFileViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type ApplyFileGateRequest = z.infer<typeof applyFileGateRequestSchema>;
export const applyFileGateResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('view'), grant: applyFileViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), outcome: applyFileOutcomeSchema, proof: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: applyFileOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('closed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(applyFileOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
export type ApplyFileGateResponse = z.infer<typeof applyFileGateResponseSchema>;
// Upstream verb triplets verbatim.
const VERBS: Readonly<Record<z.infer<typeof fileAction>, { readonly participle: string; readonly past: string }>> = {
  apply: { participle: 'applying', past: 'applied' },
  create: { participle: 'creating', past: 'created' },
  delete: { participle: 'deleting', past: 'deleted' },
};
export function verbParticiple(action: z.infer<typeof fileAction>): string {
  return VERBS[action].participle;
}
export function verbPast(action: z.infer<typeof fileAction>): string {
  return VERBS[action].past;
}
// Upstream invocation verbatim: `<command> -f "<relative path>"` (the workspace-relative path form).
export function fileActionArguments(action: z.infer<typeof fileAction>, relativePath: string): readonly string[] {
  return [action, '-f', relativePath];
}
// Upstream message shapes verbatim: the non-file error, the failure whatFailed and the success text.
export function notAFilePathMessage(uri: string): string {
  return `${uri} is not a file path.`;
}
export function failureMessage(action: z.infer<typeof fileAction>): string {
  return `Error ${verbParticiple(action)} resource`;
}
export function successMessage(action: z.infer<typeof fileAction>, relativePath: string): string {
  return `Resource ${relativePath} ${verbPast(action)}.`;
}
