import { z } from 'zod';
import { boundedName } from './identity.ts';
export const readLeaseMs = 15_000, readLifetimeMs = 60_000;
export const readConsumerSchema = z.object({ view: z.string().regex(/^[a-f0-9]{32}$/), epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
export const readHandleSchema = z.object({ generation: boundedName, task: z.string().uuid(), consumer: z.string().uuid(), token: z.string().regex(/^[a-f0-9]{64}$/), epoch: readConsumerSchema.shape.epoch }).strict();
export const readControlSchema = z.object({ protocol: z.literal(2), handle: readHandleSchema, after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
export type ReadHandle = z.infer<typeof readHandleSchema>;
export type ReadTaskPhase = 'starting' | 'running' | 'completed' | 'error';
