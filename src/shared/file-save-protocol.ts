import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { workspaceBytes, workspaceRootSchema, workspaceRelativeSchema, workspaceScopeSchema } from './workspace-protocol.ts';
export const saveDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const path = workspaceRelativeSchema.refine(value => !!value && !value.split('/').at(-1)?.startsWith('.oc-k8s-save-'));
export const savedFileReceiptSchema = z.object({ id: z.uuid(), generation: z.uuid(), root: workspaceRootSchema, path, version: saveDigestSchema }).strict();
export type SavedFileReceipt = z.infer<typeof savedFileReceiptSchema>;
export const saveSourceSummarySchema = z.object({ kind: z.enum(['live', 'file']), identity: saveDigestSchema, revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
export type SaveSourceSummary = z.infer<typeof saveSourceSummarySchema>;
export const fileSaveSourceSchema = saveSourceSummarySchema.extend({ previousFile: savedFileReceiptSchema.optional(),
  file: z.object({ root: workspaceRootSchema, path, version: saveDigestSchema, scope: workspaceScopeSchema, detached: z.boolean().optional() }).strict().optional() }).strict()
  .refine(value => value.kind === 'file' ? !!value.file : value.file === undefined);
export type FileSaveSource = z.infer<typeof fileSaveSourceSchema>;
export const fileSaveTargetSchema = z.object({ root: workspaceRootSchema, path }).strict();
// Inputs are schema-validated canonical roots/relative paths; splitting a location at another directory does not make Save As.
export function fileSaveLocation(target: z.infer<typeof fileSaveTargetSchema>): string { return `${target.root}/${target.path}`; }
export const fileSaveGrantSchema = z.object({ id: z.uuid(), generation: z.uuid(), capability: saveDigestSchema, expiresAt: z.number().int().nonnegative() }).strict();
export type FileSaveGrant = z.infer<typeof fileSaveGrantSchema>;
export const fileSaveOutcomeSchema = z.object({ id: z.uuid(), generation: z.uuid(), target: fileSaveTargetSchema, source: saveSourceSummarySchema,
  bytes: z.number().int().min(0).max(workspaceBytes), digest: saveDigestSchema, received: z.number().int().min(0).max(workspaceBytes),
  action: z.enum(['create', 'replace']), version: saveDigestSchema.nullable(), mode: z.number().int().min(0).max(0o777),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  phase: z.enum(['uploading', 'prepared', 'queued', 'checking', 'staging', 'cancelling', 'committing', 'succeeded', 'failed', 'cancelled', 'unknown']),
  cleanup: z.enum(['none', 'pending', 'manual-check']), stagingName: z.string().regex(/^\.oc-k8s-save-[a-f0-9-]{36}\.tmp$/).optional(),
  result: z.enum(['created', 'replaced', 'unchanged']).optional(), versionAfter: saveDigestSchema.optional(), code: z.enum(errorCodes).optional(),
}).strict().refine(value => value.received <= value.bytes && (value.action === 'create' ? value.version === null && value.mode === 0o600 : value.version !== null)
  && (value.phase !== 'prepared' && value.phase !== 'succeeded' || value.received === value.bytes)
  && (value.phase === 'succeeded' ? !!value.result && !!value.versionAfter && value.cleanup === 'none' && value.code === undefined
    && (value.result === 'unchanged' || value.result === (value.action === 'create' ? 'created' : 'replaced')) : value.result === undefined && value.versionAfter === undefined)
  && (value.phase !== 'unknown' || value.code === 'OPERATION_UNKNOWN'));
export type FileSaveOutcome = z.infer<typeof fileSaveOutcomeSchema>;
export const fileSaveChunkBytes = 24_576;
export const fileSaveRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('begin'), requestId: z.uuid(), target: fileSaveTargetSchema, source: fileSaveSourceSchema,
    bytes: z.number().int().min(0).max(workspaceBytes), digest: saveDigestSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('upload'), grant: fileSaveGrantSchema, offset: z.number().int().min(0).max(workspaceBytes),
    data: z.string().min(4).max(fileSaveChunkBytes / 3 * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('finish'), grant: fileSaveGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: fileSaveGrantSchema, confirmation: z.literal('save-exact-snapshot') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: fileSaveGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('status'), grant: fileSaveGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.uuid().optional() }).strict(),
]);
export type FileSaveRequest = z.infer<typeof fileSaveRequestSchema>;
export const fileSaveResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('upload'), grant: fileSaveGrantSchema, outcome: fileSaveOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), grant: fileSaveGrantSchema, outcome: fileSaveOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: fileSaveOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), generation: z.uuid(), outcomes: z.array(fileSaveOutcomeSchema).max(16), next: z.uuid().nullable() }).strict(),
]);
export type FileSaveResponse = z.infer<typeof fileSaveResponseSchema>;
export function sameFileSave(a: FileSaveOutcome, b: FileSaveOutcome): boolean {
  return a.id === b.id && a.generation === b.generation && a.target.root === b.target.root && a.target.path === b.target.path
    && a.source.kind === b.source.kind && a.source.identity === b.source.identity && a.source.revision === b.source.revision
    && a.digest === b.digest && a.bytes === b.bytes && a.action === b.action && a.version === b.version && a.mode === b.mode && a.expiresAt === b.expiresAt && a.createdAt === b.createdAt;
}
