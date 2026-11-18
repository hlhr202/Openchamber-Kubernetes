import { z } from 'zod';
import { targetSchema, boundedName, hasWellFormedUnicode, namespaceName } from './identity.ts';
import { podLogReferenceSchema, jobLogOriginSchema, logOptionsSchema } from './pod-log-protocol.ts';
import { errorCodes } from './errors.ts';
export const logOutputSourceSchema = z.object({ target: targetSchema, reference: podLogReferenceSchema, origin: jobLogOriginSchema.optional(), container: namespaceName, options: logOptionsSchema }).strict()
  .refine(value => !value.origin || value.origin.namespace === value.reference.namespace && value.origin.namespace === value.target.namespace);
export const logOutputFrameSchema = z.object({ protocol: z.literal(1), kind: z.literal('log-output'), source: logOutputSourceSchema, stream: z.object({ kind: z.enum(['snapshot', 'follow']), id: boundedName }).strict(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), action: z.enum(['reset', 'append', 'state']),
  text: z.string().max(65_536).refine(hasWellFormedUnicode), phase: z.enum(['loading', 'ready', 'opening', 'starting', 'running', 'completed', 'error']), error: z.enum(errorCodes).optional(), partial: z.boolean() }).strict()
  .refine(value => value.action !== 'state' || value.text === '');
export type LogOutputFrame = z.infer<typeof logOutputFrameSchema>;
export function logOutputKey(frame: Pick<LogOutputFrame, 'source' | 'stream'>): string { return JSON.stringify([frame.source, frame.stream]); }
