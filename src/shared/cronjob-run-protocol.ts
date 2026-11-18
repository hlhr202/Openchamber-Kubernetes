import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { targetSchema, dnsName } from './identity.ts';
import { documentReferenceSchema } from './document-protocol.ts';
import { errorCodes } from './errors.ts';

// Upstream: cronJobRunNow prompts a job name (default `${name}-${timestamp}`) then `kubectl create job NAME --from=cronjob/NAME`.
export const cronJobReferenceSchema = documentReferenceSchema.refine(ref => ref.type.group === 'batch' && ref.type.version === 'v1' && ref.type.resource === 'cronjobs' && ref.type.kind === 'CronJob' && ref.namespace !== undefined)
  .refine(ref => ref.namespace === ref.namespace); // bound to the ORIGINAL namespace, never the current global target.
export type CronJobReference = z.infer<typeof cronJobReferenceSchema>;
export const jobNameSchema = dnsName;
export type CronJobRunParameters = { readonly reference: CronJobReference; readonly jobName: string };
export const cronJobRunParametersSchema = z.object({ reference: cronJobReferenceSchema, jobName: jobNameSchema }).strict();
export const cronJobRunViewGrantSchema = z.object({ id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), serviceGeneration: z.string().uuid(), expiresAt: z.number().int().nonnegative() }).strict();
export type CronJobRunViewGrant = z.infer<typeof cronJobRunViewGrantSchema>;
export const cronJobRunRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('open'), selection: configSelectionSchema, target: targetSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), grant: cronJobRunViewGrantSchema, parameters: cronJobRunParametersSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: cronJobRunViewGrantSchema, id: z.string().uuid(), proof: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal('cronjob-run-now-exact-origin') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: cronJobRunViewGrantSchema, id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('close'), grant: cronJobRunViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type CronJobRunRequest = z.infer<typeof cronJobRunRequestSchema>;
export const cronJobRunOutcomeSchema = z.object({ id: z.string().uuid(), owner: z.string().uuid(), step: z.literal('cronjob-run-now'), dependencies: z.tuple([]), target: targetSchema, parameters: cronJobRunParametersSchema,
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'queued', 'checking', 'dispatching', 'accepted', 'failed', 'unknown', 'cancelled']), code: z.enum(errorCodes).optional() }).strict()
  .refine(value => value.phase !== 'accepted' || value.code === undefined);
export type CronJobRunOutcome = z.infer<typeof cronJobRunOutcomeSchema>;
export const cronJobRunResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('view'), grant: cronJobRunViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), outcome: cronJobRunOutcomeSchema, proof: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: cronJobRunOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('closed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(cronJobRunOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
export type CronJobRunResponse = z.infer<typeof cronJobRunResponseSchema>;
// Client-side default proposal mirroring upstream's `${name}-${timestamp}`: local clock, always editable, never auto-submitted.
export function proposedJobName(cronJobName: string, now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${cronJobName}-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}
