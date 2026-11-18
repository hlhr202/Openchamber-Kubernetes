import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { targetSchema } from './identity.ts';
import { documentReferenceSchema } from './document-protocol.ts';
import { errorCodes } from './errors.ts';

export const deleteReferenceSchema = documentReferenceSchema.refine(ref => ref.type.resource !== 'namespaces');
export const deleteParametersSchema = z.object({ reference: deleteReferenceSchema, mode: z.enum(['standard', 'now']) }).strict()
  .refine(value => value.mode !== 'now' || (value.reference.type.group === '' && value.reference.type.resource === 'pods'));
export type DeleteParameters = z.infer<typeof deleteParametersSchema>;
export const viewGrantSchema = z.object({ id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), serviceGeneration: z.string().uuid(), expiresAt: z.number().int().nonnegative() }).strict();
export type ViewGrant = z.infer<typeof viewGrantSchema>;
export const deleteRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('open'), selection: configSelectionSchema, target: targetSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), grant: viewGrantSchema, parameters: deleteParametersSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: viewGrantSchema, id: z.string().uuid(), proof: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: viewGrantSchema, id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('close'), grant: viewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type DeleteRequest = z.infer<typeof deleteRequestSchema>;
export const deleteOutcomeSchema = z.object({ id: z.string().uuid(), owner: z.string().uuid(), step: z.literal('delete-request'), dependencies: z.tuple([]), target: targetSchema, parameters: deleteParametersSchema,
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'queued', 'checking', 'dispatching', 'accepted', 'failed', 'unknown', 'cancelled']), code: z.enum(errorCodes).optional() }).strict();
export type DeleteOutcome = z.infer<typeof deleteOutcomeSchema>;
export const deleteResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('view'), grant: viewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), outcome: deleteOutcomeSchema, proof: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: deleteOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('closed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(deleteOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
export type DeleteResponse = z.infer<typeof deleteResponseSchema>;
