import { z } from 'zod';
import { boundedName, containsControlCharacters } from './identity.ts';
import { namespaceGrantSchema } from './namespace-protocol.ts';
import { configSelectionSchema } from './configuration.ts';
import { errorCodes } from './errors.ts';
import { configurationSourceSchema, configurationSourcePathSchema } from './configuration-source-protocol.ts';
import type { ConfigurationSource } from './configuration-source-protocol.ts';
import { configurationIdentitySchema } from './configuration-identity.ts';

// Configuration identity only: no connected cluster, namespace, authentication or resource target is fabricated.
export const contextConfigurationSchema = configurationIdentitySchema;
export type ContextConfiguration = z.infer<typeof contextConfigurationSchema>;
const sourcePath = configurationSourcePathSchema;
export const contextSourceSchema = configurationSourceSchema;
export type ContextSource = ConfigurationSource;
export const contextOutcomeSchema = z.object({ id: z.string().uuid(), serviceGeneration: z.string().uuid(), configuration: contextConfigurationSchema,
  step: z.literal('use-context'), dependencies: z.tuple([]), path: z.string().min(2).max(4096).refine(value => value.startsWith('/') && !containsControlCharacters(value)), version: boundedName,
  previous: z.union([z.literal(''), boundedName]), context: boundedName,
  writePrevious: z.string().max(1024), contextOrigin: sourcePath, sources: z.array(contextSourceSchema).min(1).max(64),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'queued', 'checking', 'staging', 'cancelling', 'committing', 'succeeded', 'failed', 'unknown', 'cancelled']),
  result: z.enum(['changed', 'unchanged']).optional(), cleanup: z.enum(['none', 'pending', 'manual-check']), code: z.enum(errorCodes).optional(),
}).strict().refine(value => {
  const destination = value.sources.find(source => source.status === 'present'), origin = value.sources.find(source => source.definesContext);
  return new Set(value.sources.map(source => source.path)).size === value.sources.length && destination?.path === value.path && destination.version === value.version
    && destination.currentContext === value.writePrevious && origin?.path === value.contextOrigin && (value.sources.find(source => source.currentContext)?.currentContext ?? '') === value.previous;
});
export type ContextOutcome = z.infer<typeof contextOutcomeSchema>;
export const contextGrantSchema = namespaceGrantSchema;
export type ContextGrant = z.infer<typeof contextGrantSchema>;
export const contextRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), selection: configSelectionSchema, configuration: contextConfigurationSchema, context: boundedName }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: contextGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: contextGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('status'), grant: contextGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type ContextRequest = z.infer<typeof contextRequestSchema>;
export const contextResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), grant: contextGrantSchema, outcome: contextOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: contextOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(contextOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
export type ContextResponse = z.infer<typeof contextResponseSchema>;
