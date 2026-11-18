import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { targetSchema } from './identity.ts';
import { manifestFileSchema } from './manifest-file-protocol.ts';
import { workspaceProofSchema } from './workspace-protocol.ts';
import { errorCodes } from './errors.ts';
import { configParentReferenceSchema, configDataKeySchema } from './config-file-protocol.ts';

// Upstream addKubernetesConfigFile: pick file(s) -> get parent -> per-key overwrite decision ->
// ConfigMap stores text, Secret stores base64 -> full replace. Bounded here to ONE explicit
// Server-workspace file per intent; the overwrite decision is the single fixed 60s confirmation.
export const configFileAddParametersSchema = z.object({ reference: configParentReferenceSchema, key: configDataKeySchema, file: manifestFileSchema, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
  .refine(value => value.file.receipt === undefined); // Only an original read proof; a Save receipt never authorizes Add.
export type ConfigFileAddParameters = z.infer<typeof configFileAddParametersSchema>;
export const configFileAddViewGrantSchema = z.object({ id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), serviceGeneration: z.string().uuid(), expiresAt: z.number().int().nonnegative() }).strict();
export type ConfigFileAddViewGrant = z.infer<typeof configFileAddViewGrantSchema>;
export const configFileAddRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('open'), selection: configSelectionSchema, target: targetSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), grant: configFileAddViewGrantSchema, parameters: configFileAddParametersSchema, fileProof: workspaceProofSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: configFileAddViewGrantSchema, id: z.string().uuid(), proof: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal('config-file-add-exact-key') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: configFileAddViewGrantSchema, id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('close'), grant: configFileAddViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type ConfigFileAddRequest = z.infer<typeof configFileAddRequestSchema>;
export type ConfigFileAddResponse = z.infer<typeof configFileAddResponseSchema>;
export const configFileAddOutcomeSchema = z.object({ id: z.string().uuid(), owner: z.string().uuid(), step: z.literal('config-file-add'), dependencies: z.tuple([]), target: targetSchema, parameters: configFileAddParametersSchema,
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), encodedBytes: z.number().int().min(1).max(1_048_576).optional(),
  phase: z.enum(['prepared', 'queued', 'checking', 'dispatching', 'accepted', 'failed', 'unknown', 'cancelled']), code: z.enum(errorCodes).optional() }).strict()
  .refine(value => value.phase !== 'accepted' || value.code === undefined)
  .refine(value => value.phase !== 'prepared' || value.encodedBytes !== undefined);
export type ConfigFileAddOutcome = z.infer<typeof configFileAddOutcomeSchema>;
export const configFileAddResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('view'), grant: configFileAddViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), outcome: configFileAddOutcomeSchema, proof: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: configFileAddOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('closed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(configFileAddOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
