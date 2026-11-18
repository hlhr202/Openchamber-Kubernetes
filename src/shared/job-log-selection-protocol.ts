import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { targetSchema } from './identity.ts';
import { jobLogOriginSchema, podLogReferenceSchema } from './pod-log-protocol.ts';
import { readConsumerSchema, readHandleSchema } from './read-task-protocol.ts';
import { errorCodes } from './errors.ts';
const base = z.object({ protocol: z.literal(2), target: targetSchema, selection: configSelectionSchema, origin: jobLogOriginSchema }).strict();
const bound = (value: z.infer<typeof base>) => value.origin.namespace === value.target.namespace;
export const jobLogSelectionSourceSchema = base.refine(bound);
export const jobLogSelectionOpenSchema = base.extend({ consumer: readConsumerSchema }).strict().refine(bound);
export type JobLogSelectionSource = z.infer<typeof jobLogSelectionSourceSchema>;
export const jobLogSelectedSchema = z.object({ sequence: z.literal(1), origin: jobLogOriginSchema, reference: podLogReferenceSchema, candidates: z.number().int().min(1).max(2000), waited: z.boolean() }).strict();
export type JobLogSelected = z.infer<typeof jobLogSelectedSchema>;
export const jobLogSelectionPageSchema = z.object({ protocol: z.literal(2), kind: z.literal('job-log-selection'), source: jobLogSelectionSourceSchema, handle: readHandleSchema,
  phase: z.enum(['starting', 'running', 'completed', 'error']), error: z.enum(errorCodes).optional(), expiresAt: z.number().int().nonnegative(), leaseUntil: z.number().int().nonnegative(),
  first: z.number().int().positive(), next: z.number().int().nonnegative(), head: z.number().int().nonnegative(), lost: z.boolean(), events: z.array(jobLogSelectedSchema).max(1) }).strict();
export type JobLogSelectionPage = z.infer<typeof jobLogSelectionPageSchema>;
