import { z } from 'zod';
import { apiGroup, apiVersion, boundedName, dnsName, namespaceName, resourceTypeSchema, targetSchema } from './identity.ts';
import { configSelectionSchema } from './configuration.ts';
import { errorCodes } from './errors.ts';
import { documentBytes } from './document-protocol.ts';
export const manifestLocatorSchema = z.object({ group: apiGroup, version: apiVersion, kind: boundedName, name: dnsName, namespace: namespaceName.optional() }).strict();
export type ManifestLocator = z.infer<typeof manifestLocatorSchema>;
export const manifestComparisonReferenceSchema = z.object({ type: resourceTypeSchema, name: dnsName, namespace: namespaceName.optional() }).strict()
  .refine(value => value.type.scope === 'namespace' ? value.namespace !== undefined : value.namespace === undefined);
export type ManifestComparisonReference = z.infer<typeof manifestComparisonReferenceSchema>;
export function manifestComparisonPath(value: ManifestComparisonReference): string {
  const ref = manifestComparisonReferenceSchema.parse(value), type = ref.type;
  return `${type.group ? `/apis/${type.group}/${type.version}` : `/api/${type.version}`}${ref.namespace ? `/namespaces/${ref.namespace}` : ''}/${type.resource}/${ref.name}`;
}
export const manifestDiffRequestSchema = z.object({ protocol: z.literal(2), target: targetSchema, selection: configSelectionSchema, locator: manifestLocatorSchema,
  format: z.enum(['yaml', 'json']), expectedUid: boundedName.optional(), cursor: z.string().min(1).max(17000).optional() }).strict();
export type ManifestDiffRequest = z.infer<typeof manifestDiffRequestSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const common = { protocol: z.literal(2), target: targetSchema, locator: manifestLocatorSchema, format: z.enum(['yaml', 'json']) };
export const manifestDiffPageSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('live-comparison'), reference: manifestComparisonReferenceSchema, uid: boundedName, resourceVersion: boundedName,
    identity: hash, expiresAt: z.number().int().nonnegative(), totalBytes: z.number().int().min(1).max(documentBytes), totalCharacters: z.number().int().min(1).max(documentBytes),
    offset: z.number().int().min(0).max(documentBytes), end: z.number().int().min(1).max(documentBytes), text: z.string().min(1).max(65_536), nextCursor: z.string().min(1).max(17000).nullable() }).strict()
    .refine(value => value.end === value.offset + value.text.length && value.end <= value.totalCharacters && ((value.end < value.totalCharacters) === (value.nextCursor !== null))),
  z.object({ ...common, kind: z.literal('comparison-missing'), reference: manifestComparisonReferenceSchema }).strict(),
  z.object({ ...common, kind: z.literal('comparison-unresolved'), code: z.enum(errorCodes) }).strict(),
]);
export type ManifestDiffPage = z.infer<typeof manifestDiffPageSchema>;
