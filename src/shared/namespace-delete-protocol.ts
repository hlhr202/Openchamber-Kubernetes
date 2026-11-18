import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { boundedName, targetSchema } from './identity.ts';
import { configurationSourceSchema, configurationSourcePathSchema } from './configuration-source-protocol.ts';
import { namespaceDeleteReferenceSchema, namespaceInventorySchema } from './namespace-inventory.ts';
import { errorCodes } from './errors.ts';

const step = z.object({ phase: z.enum(['planned', 'skipped', 'checking', 'staging', 'committing', 'dispatching', 'succeeded', 'accepted', 'failed', 'unknown', 'cancelled', 'blocked']),
  cleanup: z.enum(['none', 'pending', 'manual-check']), code: z.enum(errorCodes).optional() });
export const namespaceDeleteOutcomeSchema = z.object({ id: z.string().uuid(), serviceGeneration: z.string().uuid(), target: targetSchema,
  reference: namespaceDeleteReferenceSchema, inventory: namespaceInventorySchema, path: configurationSourcePathSchema.nullable(),
  contextOrigin: configurationSourcePathSchema, version: boundedName, sources: z.array(configurationSourceSchema).min(1).max(64),
  switchDefault: step.extend({ id: z.literal('switch-default'), dependencies: z.tuple([]) }).strict(),
  deleteNamespace: step.extend({ id: z.literal('delete-namespace'), dependencies: z.array(z.literal('switch-default')).max(1) }).strict(),
  targetAfter: targetSchema.optional(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'queued', 'running', 'cancelling', 'completed', 'failed', 'unknown', 'cancelled']), code: z.enum(errorCodes).optional(),
}).strict().refine(value => {
  const origin = value.sources.find(source => source.definesContext), switching = value.reference.name === value.target.namespace, after = value.targetAfter;
  return new Set(value.sources.map(source => source.path)).size === value.sources.length && origin?.path === value.contextOrigin && origin.version === value.version
    && (value.sources.find(source => source.currentContext)?.currentContext ?? '') === value.target.context && value.serviceGeneration === value.target.serviceGeneration
    && (switching ? value.path === value.contextOrigin && value.switchDefault.phase !== 'skipped' && value.deleteNamespace.dependencies.length === 1
      : value.path === null && value.switchDefault.phase === 'skipped' && value.deleteNamespace.dependencies.length === 0)
    && (!after || (switching && value.switchDefault.phase === 'succeeded' && after.namespace === 'default' && after.context === value.target.context
      && after.serviceGeneration === value.serviceGeneration && after.projectId === value.target.projectId));
});
export type NamespaceDeleteOutcome = z.infer<typeof namespaceDeleteOutcomeSchema>;
export const namespaceDeleteGrantSchema = z.object({ id: z.string().uuid(), serviceGeneration: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative() }).strict();
export type NamespaceDeleteGrant = z.infer<typeof namespaceDeleteGrantSchema>;
export const namespaceDeleteRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), selection: configSelectionSchema, target: targetSchema, reference: namespaceDeleteReferenceSchema,
    acknowledgeDelete: z.literal(true), acknowledgeDefault: z.boolean() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: namespaceDeleteGrantSchema, acknowledgeContents: z.boolean() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: namespaceDeleteGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type NamespaceDeleteRequest = z.infer<typeof namespaceDeleteRequestSchema>;
export const namespaceDeleteResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), grant: namespaceDeleteGrantSchema, outcome: namespaceDeleteOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: namespaceDeleteOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(namespaceDeleteOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
