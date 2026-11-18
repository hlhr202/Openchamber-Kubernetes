import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { targetSchema } from './identity.ts';
import { documentReferenceSchema } from './document-protocol.ts';
import { errorCodes } from './errors.ts';

// Upstream deleteKubernetesConfigFile: confirm -> get parent -> remove ONE data key -> full replace.
// Parents are core-v1 ConfigMap/Secret rows in the existing exact-reference plane.
export const configParentReferenceSchema = documentReferenceSchema.refine(ref =>
  ref.type.group === '' && ref.type.version === 'v1' && (ref.type.resource === 'configmaps' && ref.type.kind === 'ConfigMap' || ref.type.resource === 'secrets' && ref.type.kind === 'Secret')
  && ref.namespace !== undefined);
export type ConfigParentReference = z.infer<typeof configParentReferenceSchema>;
// Data keys are file basenames upstream; we keep them opaque printable non-empty strings, never paths.
export const configDataKeySchema = z.string().min(1).max(511).regex(/^[\x21-\x7e]+$/).refine(value => !value.includes('/') && !value.includes('\\'));
export type ConfigFileDeleteParameters = { readonly reference: ConfigParentReference; readonly key: string };
export const configFileDeleteParametersSchema = z.object({ reference: configParentReferenceSchema, key: configDataKeySchema }).strict();
export const configFileDeleteViewGrantSchema = z.object({ id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), serviceGeneration: z.string().uuid(), expiresAt: z.number().int().nonnegative() }).strict();
export type ConfigFileDeleteViewGrant = z.infer<typeof configFileDeleteViewGrantSchema>;
export const configFileDeleteRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('open'), selection: configSelectionSchema, target: targetSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), grant: configFileDeleteViewGrantSchema, parameters: configFileDeleteParametersSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: configFileDeleteViewGrantSchema, id: z.string().uuid(), proof: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal('config-file-delete-exact-key') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: configFileDeleteViewGrantSchema, id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('close'), grant: configFileDeleteViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type ConfigFileDeleteRequest = z.infer<typeof configFileDeleteRequestSchema>;
export type ConfigFileDeleteResponse = z.infer<typeof configFileDeleteResponseSchema>;
export const configFileDeleteOutcomeSchema = z.object({ id: z.string().uuid(), owner: z.string().uuid(), step: z.literal('config-file-delete'), dependencies: z.tuple([]), target: targetSchema, parameters: configFileDeleteParametersSchema,
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'queued', 'checking', 'dispatching', 'accepted', 'failed', 'unknown', 'cancelled']), code: z.enum(errorCodes).optional() }).strict()
  .refine(value => value.phase !== 'accepted' || value.code === undefined);
export type ConfigFileDeleteOutcome = z.infer<typeof configFileDeleteOutcomeSchema>;
export const configFileDeleteResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('view'), grant: configFileDeleteViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), outcome: configFileDeleteOutcomeSchema, proof: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: configFileDeleteOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('closed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(configFileDeleteOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
