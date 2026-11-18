import { z } from 'zod';
import { targetSchema, boundedName, dnsName } from './identity.ts';
import { configSelectionSchema } from './configuration.ts';
import { errorCodes } from './errors.ts';
import { manifestLocatorSchema, manifestComparisonReferenceSchema } from './manifest-diff-protocol.ts';
import { manifestCreateBytes } from './manifest-create-payload.ts';
import { manifestFileSchema } from './manifest-file-protocol.ts';
import { workspaceProofSchema } from './workspace-protocol.ts';
export const createDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const createSourceSchema = z.object({ kind: z.enum(['scratch', 'live', 'selection', 'file', 'file-command']), identity: createDigestSchema, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), file: manifestFileSchema.optional() }).strict()
  .refine(value => (value.kind === 'file' || value.kind === 'file-command') === (value.file !== undefined) && (value.kind !== 'file-command' || value.file?.receipt === undefined));
export type CreateSource = z.infer<typeof createSourceSchema>;
export const createGrantSchema = z.object({ id: z.uuid(), generation: z.uuid(), capability: createDigestSchema, expiresAt: z.number().int().nonnegative() }).strict();
export type CreateGrant = z.infer<typeof createGrantSchema>;
export const createStepSchema = z.object({ index: z.number().int().min(0).max(31), locator: manifestLocatorSchema, reference: manifestComparisonReferenceSchema.optional(),
  generated: z.boolean().optional(), name: dnsName.optional(),
  phase: z.enum(['pending', 'checking', 'dispatching', 'succeeded', 'failed', 'unknown', 'not-started']), uid: boundedName.optional(), resourceVersion: boundedName.optional(), code: z.enum(errorCodes).optional() }).strict()
  .refine(value => value.phase === 'succeeded' ? !!value.reference && !!value.uid && !!value.resourceVersion && value.code === undefined : value.uid === undefined && value.resourceVersion === undefined)
  // The server-assigned name exists only on a SUCCEEDED generated create; a named create never backfills one.
  .refine(value => value.name === undefined || value.generated === true && value.phase === 'succeeded');
export const createOutcomeSchema = z.object({ id: z.uuid(), generation: z.uuid(), requestId: z.uuid(), target: targetSchema, source: createSourceSchema,
  bytes: z.number().int().min(1).max(manifestCreateBytes), digest: createDigestSchema, received: z.number().int().min(0).max(manifestCreateBytes),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  phase: z.enum(['uploading', 'preparing', 'prepared', 'queued', 'checking', 'dispatching', 'succeeded', 'failed', 'cancelled', 'unknown']),
  steps: z.array(createStepSchema).max(32), cleanup: z.enum(['none', 'manual-check']), code: z.enum(errorCodes).optional() }).strict().refine(value => value.received <= value.bytes
    && (!['prepared', 'succeeded'].includes(value.phase) || value.received === value.bytes && value.steps.length > 0)
    && (value.phase !== 'succeeded' || value.steps.every(step => step.phase === 'succeeded') && value.code === undefined)
    && (value.phase !== 'unknown' || value.code === 'OPERATION_UNKNOWN'));
export type CreateOutcome = z.infer<typeof createOutcomeSchema>;
export const manifestCreateChunkBytes = 24_576;
export const manifestCreateRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('begin'), requestId: z.uuid(), target: targetSchema, selection: configSelectionSchema, source: createSourceSchema,
    bytes: z.number().int().min(1).max(manifestCreateBytes), digest: createDigestSchema, fileProof: workspaceProofSchema.optional() }).strict()
    .refine(value => value.source.file ? value.source.file.receipt ? value.fileProof === undefined : value.fileProof !== undefined : value.fileProof === undefined),
  z.object({ protocol: z.literal(2), kind: z.literal('upload'), grant: createGrantSchema, offset: z.number().int().min(0).max(manifestCreateBytes),
    data: z.string().min(4).max(manifestCreateChunkBytes / 3 * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('finish'), grant: createGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: createGrantSchema, confirmation: z.literal('create-exact-documents') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('status'), grant: createGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: createGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.uuid().optional() }).strict(),
]);
export type ManifestCreateRequest = z.infer<typeof manifestCreateRequestSchema>;
export const manifestCreateResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('upload'), grant: createGrantSchema, outcome: createOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), grant: createGrantSchema, outcome: createOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: createOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), generation: z.uuid(), outcomes: z.array(createOutcomeSchema).max(4), next: z.uuid().nullable() }).strict(),
]);
export type ManifestCreateResponse = z.infer<typeof manifestCreateResponseSchema>;
export function sameCreateIntent(a: CreateOutcome, b: CreateOutcome): boolean {
  return JSON.stringify([a.id, a.generation, a.requestId, a.target, a.source, a.bytes, a.digest, a.createdAt, a.expiresAt]) === JSON.stringify([b.id, b.generation, b.requestId, b.target, b.source, b.bytes, b.digest, b.createdAt, b.expiresAt]);
}
