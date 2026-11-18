import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { boundedName, targetSchema } from './identity.ts';
import { eventApiVersionSchema, eventRowSchema, eventScopeSchema, namespaceReferenceSchema } from './event-protocol.ts';
import { readConsumerSchema, readHandleSchema } from './read-task-protocol.ts';
import { errorCodes } from './errors.ts';

const base = z.object({ protocol: z.literal(2), target: targetSchema, selection: configSelectionSchema, scope: eventScopeSchema, namespace: namespaceReferenceSchema, apiVersion: eventApiVersionSchema,
  recoveryPolicy: z.literal('single-410-relist') }).strict();
const bound = (value: z.infer<typeof base>) => value.namespace.name === (value.scope.kind === 'current' ? value.target.namespace : value.scope.name)
  && (value.scope.kind === 'current' || value.namespace.uid === value.scope.uid && value.namespace.resourceVersion === value.scope.resourceVersion);
export const eventFollowSourceSchema = base.refine(bound);
export const eventFollowOpenSchema = base.extend({ consumer: readConsumerSchema }).strict().refine(bound);
export type EventFollowSource = z.infer<typeof eventFollowSourceSchema>;
export const eventFollowDeltaSchema = z.object({ sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), type: z.enum(['SEED', 'ADDED', 'MODIFIED', 'DELETED', 'BOOKMARK', 'RELISTING', 'RESYNC']),
  resourceVersion: boundedName, row: eventRowSchema.optional() }).strict().refine(value => ['BOOKMARK', 'RELISTING', 'RESYNC'].includes(value.type)
    ? value.row === undefined && value.resourceVersion !== '0' : value.row !== undefined && value.resourceVersion === value.row.resourceVersion);
export type EventFollowDelta = z.infer<typeof eventFollowDeltaSchema>;
export const eventFollowPageSchema = z.object({ protocol: z.literal(2), kind: z.literal('event-follow'), handle: readHandleSchema, source: eventFollowSourceSchema,
  phase: z.enum(['starting', 'running', 'completed', 'error']), error: z.enum(errorCodes).optional(), expiresAt: z.number().int().nonnegative(), leaseUntil: z.number().int().nonnegative(),
  first: z.number().int().positive(), next: z.number().int().nonnegative(), head: z.number().int().nonnegative(), lost: z.boolean(), events: z.array(eventFollowDeltaSchema).max(32) }).strict();
export type EventFollowPage = z.infer<typeof eventFollowPageSchema>;
