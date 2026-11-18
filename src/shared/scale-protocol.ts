import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { targetSchema } from './identity.ts';
import { documentReferenceSchema } from './document-protocol.ts';
import { errorCodes } from './errors.ts';

// Upstream scaleableKinds (kuberesources.ts L41-47): deployment, replicaset, replicationcontroller, job, statefulset.
// Job stays selectable but the server may not serve its scale subresource: that surfaces as a fixed failure, never a rebuild.
const scaleableTypes = [
  JSON.stringify(['', 'v1', 'replicationcontrollers', 'ReplicationController', 'namespace']),
  JSON.stringify(['apps', 'v1', 'deployments', 'Deployment', 'namespace']),
  JSON.stringify(['apps', 'v1', 'replicasets', 'ReplicaSet', 'namespace']),
  JSON.stringify(['apps', 'v1', 'statefulsets', 'StatefulSet', 'namespace']),
  JSON.stringify(['batch', 'v1', 'jobs', 'Job', 'namespace']),
];
const typeFields = (type: z.infer<typeof documentReferenceSchema>['type']) => JSON.stringify([type.group, type.version, type.resource, type.kind, type.scope]);
export const scaleReferenceSchema = documentReferenceSchema.refine(ref => scaleableTypes.includes(typeFields(ref.type)), { message: 'not scaleable' })
  .refine(ref => ref.namespace !== undefined); // Upstream binds the original namespace, never the current global target.
export const scaleReplicasSchema = z.number().int().min(0).max(2147483647); // Upstream: non-negative integer; int32 is the API bound.
export type ScaleParameters = { readonly reference: z.infer<typeof scaleReferenceSchema>; readonly replicas: number };
export const scaleParametersSchema = z.object({ reference: scaleReferenceSchema, replicas: scaleReplicasSchema }).strict();
export const scaleViewGrantSchema = z.object({ id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), serviceGeneration: z.string().uuid(), expiresAt: z.number().int().nonnegative() }).strict();
export type ScaleViewGrant = z.infer<typeof scaleViewGrantSchema>;
export const scaleRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('open'), selection: configSelectionSchema, target: targetSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), grant: scaleViewGrantSchema, parameters: scaleParametersSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: scaleViewGrantSchema, id: z.string().uuid(), proof: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal('scale-exact-target-replicas') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: scaleViewGrantSchema, id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('close'), grant: scaleViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type ScaleRequest = z.infer<typeof scaleRequestSchema>;
export type ScaleResponse = z.infer<typeof scaleResponseSchema>;
export const scaleOutcomeSchema = z.object({ id: z.string().uuid(), owner: z.string().uuid(), step: z.literal('scale-request'), dependencies: z.tuple([]), target: targetSchema, parameters: scaleParametersSchema,
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'queued', 'checking', 'dispatching', 'accepted', 'failed', 'unknown', 'cancelled']), code: z.enum(errorCodes).optional() }).strict()
  .refine(value => value.phase !== 'accepted' || value.code === undefined);
export type ScaleOutcome = z.infer<typeof scaleOutcomeSchema>;
export const scaleResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('view'), grant: scaleViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), outcome: scaleOutcomeSchema, proof: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: scaleOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('closed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(scaleOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
// Pure input parse mirroring the upstream prompt rule: reject '', negative, fractional, numeric suffix and unsafe integers.
export function parseScaleReplicasInput(value: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return scaleReplicasSchema.safeParse(parsed).success ? parsed : undefined;
}
