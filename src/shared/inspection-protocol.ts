import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { customDocumentReferenceSchema, documentReferenceSchema } from './document-protocol.ts';
import { documentReferenceId } from './document-protocol.ts';
import type { LoadDocumentReference } from './document-protocol.ts';
import { hasWellFormedUnicode, targetSchema } from './identity.ts';

export const inspectionBytes = 1_048_576, inspectionChunkCharacters = 65_536;
// Explicit read-only admission; sharing CRD identity fields does not authorize Delete/Explain or writes.
export const inspectionReferenceSchema = z.union([documentReferenceSchema, customDocumentReferenceSchema]);
export type InspectionReference = z.infer<typeof inspectionReferenceSchema>;
const requestFields = { protocol: z.literal(2), selection: configSelectionSchema, target: targetSchema, cursor: z.string().min(1).max(17_000).optional() };
export const inspectionRequestSchema = z.discriminatedUnion('mode', [
  z.object({ ...requestFields, reference: inspectionReferenceSchema, mode: z.enum(['wide', 'describe']), refresh: z.literal(true).optional() }).strict(),
  z.object({ ...requestFields, mode: z.literal('cluster-info') }).strict(),
]).refine(value => value.mode === 'cluster-info' || !value.refresh || !value.cursor);
export type InspectionRequest = z.infer<typeof inspectionRequestSchema>;
export function sameInspectionObject(first: LoadDocumentReference, second: LoadDocumentReference): boolean {
  return documentReferenceId({ ...first, resourceVersion: second.resourceVersion }) === documentReferenceId(second);
}
const pageFields = { protocol: z.literal(2), kind: z.literal('inspection-output'), target: targetSchema,
  contentIdentity: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative(),
  totalBytes: z.number().int().min(1).max(inspectionBytes), totalCharacters: z.number().int().min(1).max(inspectionBytes),
  offset: z.number().int().min(0).max(inspectionBytes), end: z.number().int().min(1).max(inspectionBytes),
  text: z.string().min(1).max(inspectionChunkCharacters).refine(hasWellFormedUnicode), nextCursor: z.string().min(1).max(17_000).nullable() };
export const inspectionPageSchema = z.discriminatedUnion('mode', [
  z.object({ ...pageFields, reference: inspectionReferenceSchema, mode: z.enum(['wide', 'describe']) }).strict(),
  z.object({ ...pageFields, mode: z.literal('cluster-info'), serviceNamespace: z.literal('kube-system') }).strict(),
])
  .refine(value => value.end - value.offset === value.text.length && value.end <= value.totalCharacters && (value.end < value.totalCharacters) === (value.nextCursor !== null));
export type InspectionPage = z.infer<typeof inspectionPageSchema>;
