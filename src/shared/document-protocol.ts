import { z } from 'zod';
import { boundedName, dnsName, hasWellFormedUnicode, namespaceName, resourceTypeSchema, targetSchema } from './identity.ts';
import { configSelectionSchema } from './configuration.ts';
import { resourceNodeSchema } from './resource-protocol.ts';
import { resourceDescriptors } from './tree.ts';
import { definitionReferenceSchema } from './branch-protocol.ts';

export const documentBytes = 1_048_576, documentChunkCharacters = 65_536;
export const documentReferenceSchema = z.object({ type: resourceTypeSchema, name: dnsName, namespace: namespaceName.optional(), uid: boundedName, resourceVersion: boundedName }).strict()
  .refine(ref => Object.values(resourceDescriptors).some(type => type.group === ref.type.group && type.version === ref.type.version && type.resource === ref.type.resource
    && type.kind === ref.type.kind && type.scope === ref.type.scope) && (ref.type.scope === 'namespace' ? ref.namespace !== undefined : ref.namespace === undefined));
export type DocumentReference = z.infer<typeof documentReferenceSchema>;
export const customDocumentReferenceSchema = z.object({ type: resourceTypeSchema, name: dnsName, namespace: namespaceName.optional(), uid: boundedName, resourceVersion: boundedName,
  definition: definitionReferenceSchema }).strict().refine(ref => !!ref.type.group && ref.definition.name === `${ref.type.resource}.${ref.type.group}`
    && !Object.values(resourceDescriptors).some(type => JSON.stringify(typeFields(type)) === JSON.stringify(typeFields(ref.type)))
    && (ref.type.scope === 'namespace' ? ref.namespace !== undefined : ref.namespace === undefined));
function typeFields(type: z.infer<typeof resourceTypeSchema>) { return [type.group, type.version, type.resource, type.kind, type.scope]; }
export const loadDocumentReferenceSchema = z.union([documentReferenceSchema, customDocumentReferenceSchema]);
export type LoadDocumentReference = z.infer<typeof loadDocumentReferenceSchema>;
export function documentReferenceId(ref: LoadDocumentReference): string { return JSON.stringify([ref.type.group, ref.type.version, ref.type.resource, ref.type.kind, ref.type.scope, ref.namespace ?? '', ref.name, ref.uid, ref.resourceVersion,
  ...('definition' in ref ? [ref.definition.name, ref.definition.uid, ref.definition.resourceVersion] : [])]); }
export function customDocumentReferenceFromNode(input: unknown, definition: unknown): LoadDocumentReference | null {
  const parsed = resourceNodeSchema.safeParse(input); if (!parsed.success) return null; const ref = parsed.data.resource;
  const reference = customDocumentReferenceSchema.safeParse({ type: { group: ref.group, version: ref.version, resource: ref.resource, kind: ref.kind, scope: ref.scope }, name: ref.name,
    namespace: ref.namespace, uid: ref.uid, resourceVersion: ref.resourceVersion, definition });
  return reference.success ? reference.data : null;
}
export function documentReferenceFromNode(input: unknown): DocumentReference | null {
  const parsed = resourceNodeSchema.safeParse(input);
  if (!parsed.success) return null;
  const ref = parsed.data.resource;
  const reference = documentReferenceSchema.safeParse({ type: { group: ref.group, version: ref.version, resource: ref.resource, kind: ref.kind, scope: ref.scope },
    name: ref.name, namespace: ref.namespace, uid: ref.uid, resourceVersion: ref.resourceVersion });
  return reference.success ? reference.data : null;
}
export const documentRequestSchema = z.object({ protocol: z.literal(2), selection: configSelectionSchema, target: targetSchema, reference: loadDocumentReferenceSchema,
  format: z.enum(['yaml', 'json']), cursor: z.string().min(1).max(17_000).optional() }).strict();
export type DocumentRequest = z.infer<typeof documentRequestSchema>;
export const documentPageSchema = z.object({ protocol: z.literal(2), kind: z.literal('resource-document'), target: targetSchema, reference: loadDocumentReferenceSchema,
  format: z.enum(['yaml', 'json']), contentIdentity: z.string().regex(/^[a-f0-9]{64}$/), totalBytes: z.number().int().min(1).max(documentBytes),
  totalCharacters: z.number().int().min(1).max(documentBytes), offset: z.number().int().min(0).max(documentBytes), end: z.number().int().min(1).max(documentBytes),
  text: z.string().min(1).max(documentChunkCharacters).refine(hasWellFormedUnicode), nextCursor: z.string().min(1).max(17_000).nullable() }).strict();
export type DocumentPage = z.infer<typeof documentPageSchema>;
