import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { targetSchema, dnsName } from './identity.ts';
import { documentReferenceSchema } from './document-protocol.ts';
import { errorCodes } from './errors.ts';

// Upstream exposableKinds: deployment, pod, replicationController, replicaSet, service.
// Reachable through the exact-reference plane today: deployment, pod, service.
export const exposeReferenceSchema = documentReferenceSchema.refine(ref =>
  (ref.type.group === 'apps' && ref.type.version === 'v1' && ref.type.resource === 'deployments' && ref.type.kind === 'Deployment')
  || (ref.type.group === '' && ref.type.version === 'v1' && (ref.type.resource === 'pods' && ref.type.kind === 'Pod' || ref.type.resource === 'services' && ref.type.kind === 'Service'))
  && ref.namespace !== undefined);
export type ExposeReference = z.infer<typeof exposeReferenceSchema>;
export const exposePortSchema = z.number().int().min(1).max(65535);
export const exposeTypeSchema = z.enum(['ClusterIP', 'NodePort', 'LoadBalancer']);
export const exposeProtocolSchema = z.enum(['TCP', 'UDP', 'SCTP']);
export const exposeParametersSchema = z.object({ reference: exposeReferenceSchema, name: dnsName, port: exposePortSchema.optional(), targetPort: exposePortSchema.optional(),
  type: exposeTypeSchema.optional(), protocol: exposeProtocolSchema.optional() }).strict();
export type ExposeParameters = z.infer<typeof exposeParametersSchema>;
export const exposeViewGrantSchema = z.object({ id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), serviceGeneration: z.string().uuid(), expiresAt: z.number().int().nonnegative() }).strict();
export type ExposeViewGrant = z.infer<typeof exposeViewGrantSchema>;
export const exposeRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('open'), selection: configSelectionSchema, target: targetSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), grant: exposeViewGrantSchema, parameters: exposeParametersSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: exposeViewGrantSchema, id: z.string().uuid(), proof: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal('expose-exact-origin') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: exposeViewGrantSchema, id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('close'), grant: exposeViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type ExposeRequest = z.infer<typeof exposeRequestSchema>;
export const exposeOutcomeSchema = z.object({ id: z.string().uuid(), owner: z.string().uuid(), step: z.literal('expose-request'), dependencies: z.tuple([]), target: targetSchema, parameters: exposeParametersSchema,
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'queued', 'checking', 'dispatching', 'accepted', 'failed', 'unknown', 'cancelled']), code: z.enum(errorCodes).optional() }).strict()
  .refine(value => value.phase !== 'accepted' || value.code === undefined);
export type ExposeOutcome = z.infer<typeof exposeOutcomeSchema>;
export const exposeResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('view'), grant: exposeViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), outcome: exposeOutcomeSchema, proof: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: exposeOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('closed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(exposeOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
export type ExposeResponse = z.infer<typeof exposeResponseSchema>;
// Pure input parse mirroring the upstream numeric port rule: 1-65535 integer only, no names/suffixes.
export function parseExposePortInput(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return exposePortSchema.safeParse(parsed).success ? parsed : undefined;
}
