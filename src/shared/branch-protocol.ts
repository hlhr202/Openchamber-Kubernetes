import { z } from 'zod';
import { boundedName, dnsName, namespaceName, resourceTypeSchema, targetSchema } from './identity.ts';
import { configSelectionSchema } from './configuration.ts';
import { protocolVersion } from './protocol.ts';
import { resourceIdentitySchema, resourceNodeSchema } from './resource-protocol.ts';
import { helmReleaseEntrySchema, helmReleaseRevisionSchema } from './helm-release-protocol.ts';
import { resourceDescriptors } from './tree.ts';

export const expandableResourceKey = z.enum(['nodes', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'services', 'pods', 'configmaps', 'secrets']);
export const parentReferenceSchema = z.object({ resource: expandableResourceKey, name: dnsName, namespace: namespaceName.optional(), uid: boundedName, resourceVersion: boundedName }).strict();
export type ParentReference = z.infer<typeof parentReferenceSchema>;
export const definitionReferenceSchema = z.object({ name: dnsName, uid: boundedName, resourceVersion: boundedName }).strict();
export type DefinitionReference = z.infer<typeof definitionReferenceSchema>;
const cursor = z.string().min(1).max(17_000);
const base = { protocol: z.literal(protocolVersion), selection: configSelectionSchema, target: targetSchema };
export const branchReadRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('children'), parent: parentReferenceSchema, cursor: cursor.optional() }).strict(),
  z.object({ ...base, kind: z.literal('custom-types'), cursor: cursor.optional() }).strict(),
  z.object({ ...base, kind: z.literal('custom-resources'), definition: definitionReferenceSchema, cursor: cursor.optional() }).strict(),
  z.object({ ...base, kind: z.literal('helm-releases'), cursor: cursor.optional() }).strict(),
  z.object({ ...base, kind: z.literal('helm-release-history'), release: boundedName.max(253), namespace: namespaceName, cursor: cursor.optional() }).strict(),
]);
export type BranchReadRequest = z.infer<typeof branchReadRequestSchema>;
const leaf = z.object({ id: z.string().min(1).max(16_000), type: z.enum(['info', 'message']), label: boundedName, expandable: z.literal(false) }).strict();
export const configKeyNodeSchema = z.object({ id: z.string().min(1).max(16_000), type: z.literal('config-key'), label: boundedName, key: boundedName,
  expandable: z.literal(false), resource: resourceIdentitySchema }).strict();
export const customTypeNodeSchema = z.object({ id: z.string().min(1).max(16_000), type: z.literal('folder'), label: boundedName,
  expandable: z.literal(true), definition: definitionReferenceSchema }).strict();
export type CustomTypeNode = z.infer<typeof customTypeNodeSchema>;
export const helmReleaseTreeNodeSchema = z.object({
  id: z.string().min(1).max(16_000), type: z.literal('release'), label: boundedName.max(253), expandable: z.literal(true),
  description: boundedName.optional(), tooltip: z.string().max(2100).optional(),
  icon: z.enum(['helm-deployed', 'helm-failed']), release: helmReleaseEntrySchema, partial: z.boolean(),
}).strict();
export const helmRevisionTreeNodeSchema = z.object({
  id: z.string().min(1).max(16_000), type: z.literal('revision'), label: boundedName, expandable: z.literal(false),
  description: boundedName.optional(), tooltip: z.string().max(2100).optional(),
  releaseName: boundedName.max(253), namespace: namespaceName, revision: helmReleaseRevisionSchema, partial: z.boolean(),
}).strict();
const page = { protocol: z.literal(protocolVersion), target: targetSchema, nextCursor: cursor.nullable() };
export const branchReadResponseSchema = z.discriminatedUnion('kind', [
  z.object({ ...page, kind: z.literal('children'), parent: parentReferenceSchema, resourceVersion: boundedName.nullable(),
    nodes: z.array(z.union([resourceNodeSchema, configKeyNodeSchema, leaf])).max(100) }).strict(),
  z.object({ ...page, kind: z.literal('custom-types'), resourceVersion: boundedName, nodes: z.array(customTypeNodeSchema).max(100) }).strict(),
  z.object({ ...page, kind: z.literal('custom-resources'), definition: definitionReferenceSchema, resourceType: resourceTypeSchema, listKind: boundedName,
    resourceVersion: boundedName, nodes: z.array(resourceNodeSchema).max(100) }).strict(),
  z.object({ ...page, kind: z.literal('helm-releases'), resourceVersion: z.null(), partial: z.boolean(), nodes: z.array(helmReleaseTreeNodeSchema).max(100) }).strict(),
  z.object({ ...page, kind: z.literal('helm-release-history'), resourceVersion: z.null(), release: boundedName.max(253), namespace: namespaceName, partial: z.boolean(),
    nodes: z.array(helmRevisionTreeNodeSchema).max(100) }).strict(),
]);
export type BranchReadResponse = z.infer<typeof branchReadResponseSchema>;
export function referenceKey(value: ParentReference | DefinitionReference): string {
  return JSON.stringify(['resource' in value ? value.resource : 'custom-resource-definition', value.name,
    'namespace' in value ? value.namespace ?? '' : '', value.uid, value.resourceVersion]);
}

export function parentFromResource(input: unknown): ParentReference | null {
  const parsed = resourceNodeSchema.safeParse(input);
  if (!parsed.success || !parsed.data.expandable) return null;
  const identity = parsed.data.resource;
  const key = expandableResourceKey.options.find(key => {
    const type = resourceDescriptors[key];
    return type.group === identity.group && type.version === identity.version && type.resource === identity.resource && type.kind === identity.kind && type.scope === identity.scope;
  });
  const reference = parentReferenceSchema.safeParse({ resource: key, name: identity.name, namespace: identity.namespace, uid: identity.uid, resourceVersion: identity.resourceVersion });
  return reference.success ? reference.data : null; // Never invent stable references for incomplete list rows.
}
