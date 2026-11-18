import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { targetSchema } from './identity.ts';
import { documentReferenceSchema } from './document-protocol.ts';
import { manifestFileSchema } from './manifest-file-protocol.ts';
import { workspaceProofSchema } from './workspace-protocol.ts';
import { errorCodes } from './errors.ts';

// Upstream deleteResourceFromUri: confirm -> `delete -f <file>`. Bounded here to ONE document per
// Server-workspace file (the E024 read-proof source); the live object is pinned (UID/RV) before the
// fixed 60s confirmation, so the delete carries exact preconditions instead of a bare name delete.
export const fileDeleteParametersSchema = z.object({ file: manifestFileSchema, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
  .refine(value => value.file.receipt === undefined); // Only an original read proof; a Save receipt never authorizes Delete.
export type FileDeleteParameters = z.infer<typeof fileDeleteParametersSchema>;
export const fileDeleteViewGrantSchema = z.object({ id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), serviceGeneration: z.string().uuid(), expiresAt: z.number().int().nonnegative() }).strict();
export type FileDeleteViewGrant = z.infer<typeof fileDeleteViewGrantSchema>;
export const fileDeleteRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('open'), selection: configSelectionSchema, target: targetSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), grant: fileDeleteViewGrantSchema, parameters: fileDeleteParametersSchema, fileProof: workspaceProofSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: fileDeleteViewGrantSchema, id: z.string().uuid(), proof: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal('file-delete-exact-pinned-object') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: fileDeleteViewGrantSchema, id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('close'), grant: fileDeleteViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type FileDeleteRequest = z.infer<typeof fileDeleteRequestSchema>;
export const fileDeleteOutcomeSchema = z.object({ id: z.string().uuid(), owner: z.string().uuid(), step: z.literal('file-delete-request'), dependencies: z.tuple([]), target: targetSchema, parameters: fileDeleteParametersSchema,
  reference: documentReferenceSchema.optional(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'queued', 'checking', 'dispatching', 'accepted', 'failed', 'unknown', 'cancelled']), code: z.enum(errorCodes).optional() }).strict()
  .refine(value => value.phase !== 'accepted' || value.code === undefined)
  .refine(value => !['prepared', 'queued', 'checking', 'dispatching', 'accepted'].includes(value.phase) || value.reference !== undefined);
export type FileDeleteOutcome = z.infer<typeof fileDeleteOutcomeSchema>;
export const fileDeleteResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('view'), grant: fileDeleteViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), outcome: fileDeleteOutcomeSchema, proof: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: fileDeleteOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('closed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(fileDeleteOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
export type FileDeleteResponse = z.infer<typeof fileDeleteResponseSchema>;
