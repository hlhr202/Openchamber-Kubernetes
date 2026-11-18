import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { boundedName, dnsName, resourceTypeSchema, targetSchema } from './identity.ts';
import { builtinResourceKey } from './resource-protocol.ts';
import { errorCodes } from './errors.ts';
import { definitionReferenceSchema } from './branch-protocol.ts';
import { resourceDescriptors } from './tree.ts';

import { readConsumerSchema as watchConsumerSchema, readHandleSchema as watchHandleSchema, readControlSchema as watchControlSchema } from './read-task-protocol.ts';
export { watchConsumerSchema, watchHandleSchema, watchControlSchema };
export { readLeaseMs as watchLeaseMs, readLifetimeMs as watchLifetimeMs } from './read-task-protocol.ts';
export const customWatchReferenceSchema = z.object({ type: resourceTypeSchema, definition: definitionReferenceSchema, listKind: boundedName }).strict()
  .refine(value => !!value.type.group && value.definition.name === `${value.type.resource}.${value.type.group}`
    && !Object.values(resourceDescriptors).some(type => type.group === value.type.group && type.version === value.type.version && type.resource === value.type.resource && type.kind === value.type.kind && type.scope === value.type.scope));
export type CustomWatchReference = z.infer<typeof customWatchReferenceSchema>;
export const watchSourceSchema = z.object({ protocol: z.literal(2), target: targetSchema, selection: configSelectionSchema, custom: customWatchReferenceSchema.optional(),
  recoveryPolicy: z.literal('single-410-relist'), resource: z.union([builtinResourceKey, z.literal('custom-resource')]), resourceVersion: boundedName, object: z.object({ name: dnsName, uid: boundedName }).strict().optional() }).strict()
  .refine(source => source.resource === 'custom-resource' ? !!source.custom : source.custom === undefined);
export type WatchSource = z.infer<typeof watchSourceSchema>;
export type WatchConsumer = z.infer<typeof watchConsumerSchema>;
export type WatchHandle = z.infer<typeof watchHandleSchema>;
export const watchOpenSchema = watchSourceSchema.safeExtend({ consumer: watchConsumerSchema }).strict();
export const watchEventSchema = z.object({ sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), type: z.enum(['ADDED', 'MODIFIED', 'DELETED', 'BOOKMARK', 'RELISTING', 'RESYNC']),
  resourceVersion: boundedName, name: dnsName.optional(), uid: boundedName.optional() }).strict().refine(event =>
    ['ADDED', 'MODIFIED', 'DELETED'].includes(event.type) ? event.name !== undefined && event.uid !== undefined : event.name === undefined && event.uid === undefined);
export type WatchEvent = z.infer<typeof watchEventSchema>;
export const watchPageSchema = z.object({ protocol: z.literal(2), kind: z.literal('resource-watch'), handle: watchHandleSchema, source: watchSourceSchema,
  phase: z.enum(['starting', 'running', 'completed', 'error']), error: z.enum(errorCodes).optional(), expiresAt: z.number().int().nonnegative(),
  leaseUntil: z.number().int().nonnegative(), first: z.number().int().positive(), next: z.number().int().nonnegative(), lost: z.boolean(),
  head: z.number().int().nonnegative(), events: z.array(watchEventSchema).max(32) }).strict();
export type WatchPage = z.infer<typeof watchPageSchema>;
