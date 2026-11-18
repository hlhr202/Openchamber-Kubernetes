import { z } from 'zod';
import { targetSchema, boundedName } from './identity.ts';
import { configSelectionSchema } from './configuration.ts';
import { customDocumentReferenceSchema } from './document-protocol.ts';
import { errorCodes } from './errors.ts';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const applyGrantSchema = z.object({ id: z.uuid(), generation: z.uuid(), capability: hash, expiresAt: z.number().int().nonnegative() }).strict();
export type ApplyGrant = z.infer<typeof applyGrantSchema>;
// Pure routing projection only. Full versioned reference remains on the independent intent/outcome.
export function applyComparisonReference(input: z.infer<typeof customDocumentReferenceSchema>) {
  const ref = customDocumentReferenceSchema.parse(input);
  return { type: ref.type, name: ref.name, ...(ref.namespace ? { namespace: ref.namespace } : {}) };
}
export const applySourceSchema = z.object({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), identity: hash, format: z.enum(['yaml', 'json']) }).strict();
export const applyOutcomeSchema = z.object({ id: z.uuid(), generation: z.uuid(), requestId: z.uuid(), target: targetSchema, reference: customDocumentReferenceSchema, source: applySourceSchema,
  bytes: z.number().int().min(1).max(1_048_576), received: z.number().int().min(0).max(1_048_576), phase: z.enum(['uploading', 'preparing', 'prepared', 'queued', 'checking', 'dispatching', 'succeeded', 'failed', 'cancelled', 'unknown']),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  patchDigest: hash.optional(), patchBytes: z.number().int().min(1).max(1_048_576).optional(), unchanged: z.boolean().optional(), baseline: z.enum(['annotation', 'absent']).optional(), missing: z.boolean().optional(),
  resourceVersionAfter: boundedName.optional(), uidAfter: boundedName.optional(), code: z.enum(errorCodes).optional() }).strict().refine(value => value.received <= value.bytes
    && (!['prepared', 'queued', 'checking', 'dispatching', 'succeeded'].includes(value.phase) || value.received === value.bytes && value.patchDigest !== undefined && value.patchBytes !== undefined && value.unchanged !== undefined && value.baseline !== undefined && value.missing !== undefined)
    && (value.phase !== 'succeeded' || value.resourceVersionAfter !== undefined && (!value.unchanged || value.resourceVersionAfter === value.reference.resourceVersion))
    && (value.phase !== 'succeeded' || !value.missing || !value.unchanged && value.uidAfter !== undefined && value.uidAfter !== value.reference.uid));
export type ApplyOutcome = z.infer<typeof applyOutcomeSchema>;
export const manifestApplyChunkBytes = 24_576;
export const manifestApplyRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('begin'), requestId: z.uuid(), target: targetSchema, selection: configSelectionSchema, reference: customDocumentReferenceSchema, source: applySourceSchema, bytes: z.number().int().min(1).max(1_048_576) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('upload'), grant: applyGrantSchema, offset: z.number().int().min(0).max(1_048_576), data: z.string().min(4).max(32_768).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('finish'), grant: applyGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: applyGrantSchema, patchDigest: hash, confirmation: z.enum(['apply-exact-crd-version', 'create-missing-crd-object']) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('status'), grant: applyGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: applyGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.uuid().optional() }).strict(),
]);
export const manifestApplyResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.enum(['upload', 'confirmation']), grant: applyGrantSchema, outcome: applyOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: applyOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), generation: z.uuid(), outcomes: z.array(applyOutcomeSchema).max(8), next: z.uuid().nullable() }).strict(),
]);
export type ManifestApplyResponse = z.infer<typeof manifestApplyResponseSchema>;
export function sameApplyIntent(left: ApplyOutcome, right: ApplyOutcome): boolean {
  return JSON.stringify([left.id, left.generation, left.requestId, left.target, left.reference, left.source, left.bytes, left.createdAt, left.expiresAt]) === JSON.stringify([right.id, right.generation, right.requestId, right.target, right.reference, right.source, right.bytes, right.createdAt, right.expiresAt]);
}
