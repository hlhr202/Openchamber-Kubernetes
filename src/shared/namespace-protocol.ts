import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { boundedName, containsControlCharacters, namespaceName } from './identity.ts';
import { errorCodes } from './errors.ts';
import { configurationSourceSchema } from './configuration-source-protocol.ts';
import { configurationIdentitySchema } from './configuration-identity.ts';

const filePath = z.string().min(2).max(4096).refine(value => value.startsWith('/') && !containsControlCharacters(value));
export const namespaceSelectionSchema = configSelectionSchema.refine(value => value.mode !== 'merge');
export const namespaceOutcomeSchema = z.object({
  id: z.string().uuid(), serviceGeneration: z.string().uuid(), configuration: configurationIdentitySchema, context: boundedName, step: z.literal('set-namespace'), dependencies: z.tuple([]),
  path: filePath, previous: namespaceName, namespace: namespaceName, version: boundedName,
  contextOrigin: filePath, contextAction: z.enum(['update', 'create']), sources: z.array(configurationSourceSchema).min(1).max(64),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'queued', 'checking', 'staging', 'cancelling', 'committing', 'succeeded', 'failed', 'unknown', 'cancelled']),
  result: z.enum(['changed', 'unchanged']).optional(), cleanup: z.enum(['none', 'pending', 'manual-check']), code: z.enum(errorCodes).optional(),
}).strict().refine(value => {
  const origin = value.sources.find(source => source.definesContext);
  const destination = value.contextAction === 'create' ? value.sources.find(source => source.status === 'present') : origin;
  return new Set(value.sources.map(source => source.path)).size === value.sources.length && destination?.path === value.contextOrigin && destination.path === value.path
    && destination.version === value.version && (value.contextAction !== 'create' || (!origin && value.previous === 'default' && value.result !== 'unchanged'))
    && (value.sources.find(source => source.currentContext)?.currentContext ?? '') === value.context
    && value.serviceGeneration === value.configuration.serviceGeneration;
});
export type NamespaceOutcome = z.infer<typeof namespaceOutcomeSchema>;
export const namespaceGrantSchema = z.object({ id: z.string().uuid(), serviceGeneration: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative() }).strict();
export type NamespaceGrant = z.infer<typeof namespaceGrantSchema>;
export const namespaceRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), selection: configSelectionSchema, configuration: configurationIdentitySchema, context: boundedName, namespace: namespaceName }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: namespaceGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: namespaceGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('status'), grant: namespaceGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type NamespaceRequest = z.infer<typeof namespaceRequestSchema>;
export const namespaceResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), grant: namespaceGrantSchema, outcome: namespaceOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: namespaceOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(namespaceOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
export type NamespaceResponse = z.infer<typeof namespaceResponseSchema>;
