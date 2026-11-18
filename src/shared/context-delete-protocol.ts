import { z } from 'zod';
import { boundedName, containsControlCharacters, namespaceName } from './identity.ts';
import { errorCodes } from './errors.ts';
import { contextConfigurationSchema, contextGrantSchema } from './context-protocol.ts';
import { configSelectionSchema } from './configuration.ts';
import { configurationSourceSchema, configurationSourcePathSchema } from './configuration-source-protocol.ts';

export const contextDeleteStepIds = ['cluster', 'user', 'context'] as const;
const step = z.object({ id: z.enum(contextDeleteStepIds), name: z.union([z.literal(''), boundedName]), dependencies: z.array(z.enum(contextDeleteStepIds)).max(2),
  path: configurationSourcePathSchema.nullable(), nextOrigin: configurationSourcePathSchema.nullable(), shadowDefinitions: z.number().int().min(0).max(63),
  phase: z.enum(['planned', 'skipped', 'checking', 'staging', 'cancelling', 'committing', 'succeeded', 'failed', 'unknown', 'blocked', 'cancelled']),
  reason: z.enum(['exclusive', 'shared', 'absent', 'empty', 'target']), sharedReferences: z.number().int().min(0).max(320_000),
  cleanup: z.enum(['none', 'pending', 'manual-check']), result: z.enum(['changed', 'unchanged']).optional(), code: z.enum(errorCodes).optional() }).strict();
export const contextDeletionSourceSchema = configurationSourceSchema.safeExtend({ definesCluster: z.boolean(), definesUser: z.boolean() })
  .refine(value => value.status === 'present' || (!value.definesCluster && !value.definesUser));
export type ContextDeletionSource = z.infer<typeof contextDeletionSourceSchema>;
export const contextDeleteOutcomeSchema = z.object({ id: z.string().uuid(), serviceGeneration: z.string().uuid(), configuration: contextConfigurationSchema,
  context: boundedName, currentContextRetained: z.string().max(1024), removesCurrent: z.boolean(), path: z.string().min(2).max(4096).refine(value => value.startsWith('/') && !containsControlCharacters(value)), version: boundedName,
  sources: z.array(contextDeletionSourceSchema).min(1).max(64), contextRemains: z.boolean(),
  contextAfter: z.object({ origin: configurationSourcePathSchema, cluster: z.union([z.literal(''), boundedName]), user: z.union([z.literal(''), boundedName]), namespace: namespaceName }).strict().nullable(),
  steps: z.tuple([step.extend({ id: z.literal('cluster') }), step.extend({ id: z.literal('user') }), step.extend({ id: z.literal('context') })]),
  phase: z.enum(['prepared', 'queued', 'running', 'completed', 'failed', 'unknown', 'cancelled']),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), code: z.enum(errorCodes).optional(),
}).strict().refine(value => {
  const origin = value.sources.find(source => source.definesContext);
  if (new Set(value.sources.map(source => source.path)).size !== value.sources.length || origin?.path !== value.path || origin.version !== value.version
    || value.serviceGeneration !== value.configuration.serviceGeneration || (value.sources.find(source => source.currentContext)?.currentContext ?? '') !== value.currentContextRetained
    || value.removesCurrent !== (value.currentContextRetained === value.context)) return false;
  for (const entry of value.steps) {
    const definitions = value.sources.filter(source => entry.id === 'context' ? source.definesContext : entry.id === 'cluster' ? source.definesCluster : source.definesUser);
    const expectedDependencies = entry.id === 'cluster' ? [] : entry.id === 'user' ? ['cluster'] : ['cluster', 'user'];
    if (entry.path !== (definitions[0]?.path ?? null) || entry.nextOrigin !== (definitions[1]?.path ?? null) || entry.shadowDefinitions !== Math.max(0, definitions.length - 1)
      || JSON.stringify(entry.dependencies) !== JSON.stringify(expectedDependencies)) return false;
    if (entry.id === 'context' ? entry.name !== value.context || entry.reason !== 'target' || entry.sharedReferences !== 0 || entry.phase === 'skipped'
      : !entry.name ? entry.reason !== 'empty' || definitions.length !== 0 || entry.phase !== 'skipped'
        : !definitions.length ? entry.reason !== 'absent' || entry.phase !== 'skipped'
          : entry.sharedReferences ? entry.reason !== 'shared' || entry.phase !== 'skipped' : entry.reason !== 'exclusive' || entry.phase === 'skipped') return false;
  }
  return value.contextRemains === (value.steps[2].shadowDefinitions > 0) && (value.contextRemains ? value.contextAfter?.origin === value.steps[2].nextOrigin : value.contextAfter === null);
});
export type ContextDeleteOutcome = z.infer<typeof contextDeleteOutcomeSchema>;
export type ContextDeleteStep = ContextDeleteOutcome['steps'][number];
export const contextDeleteRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), selection: configSelectionSchema, configuration: contextConfigurationSchema, context: boundedName }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: contextGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: contextGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type ContextDeleteRequest = z.infer<typeof contextDeleteRequestSchema>;
export const contextDeleteResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), grant: contextGrantSchema, outcome: contextDeleteOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: contextDeleteOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(contextDeleteOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
export type ContextDeleteResponse = z.infer<typeof contextDeleteResponseSchema>;
