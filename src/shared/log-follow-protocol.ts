import { z } from 'zod';
import { logBaseSchema, logOptionsSchema } from './pod-log-protocol.ts';
import { hasWellFormedUnicode, namespaceName } from './identity.ts';
import { errorCodes } from './errors.ts';
import { readConsumerSchema, readHandleSchema } from './read-task-protocol.ts';

const base = logBaseSchema.extend({ container: namespaceName, options: logOptionsSchema }).strict();
const sameNamespace = (value: z.infer<typeof base>) => !value.origin || value.origin.namespace === value.reference.namespace;
export const logFollowSourceSchema = base.refine(sameNamespace);
export type LogFollowSource = z.infer<typeof logFollowSourceSchema>;
export const logFollowOpenSchema = base.extend({ consumer: readConsumerSchema }).strict().refine(sameNamespace);
// Open is parsed as a strict source plus consumer by the common read-task engine.
export const logFollowEventSchema = z.object({ sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), text: z.string().min(1).max(4096).refine(hasWellFormedUnicode) }).strict();
export type LogFollowEvent = z.infer<typeof logFollowEventSchema>;
export const logFollowPageSchema = z.object({ protocol: z.literal(2), kind: z.literal('pod-log-follow'), handle: readHandleSchema, source: logFollowSourceSchema,
  phase: z.enum(['starting', 'running', 'completed', 'error']), error: z.enum(errorCodes).optional(), expiresAt: z.number().int().nonnegative(),
  leaseUntil: z.number().int().nonnegative(), first: z.number().int().positive(), next: z.number().int().nonnegative(), lost: z.boolean(),
  head: z.number().int().nonnegative(), events: z.array(logFollowEventSchema).max(32) }).strict();
export type LogFollowPage = z.infer<typeof logFollowPageSchema>;
