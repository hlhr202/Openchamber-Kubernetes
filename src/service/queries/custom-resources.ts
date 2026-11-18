import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { apiGroup, apiVersion, boundedName, containsControlCharacters, dnsName, resourceName, resourceTypeSchema, stableNodeId } from '../../shared/identity.ts';
import type { ResourceType, TargetIdentity } from '../../shared/identity.ts';
import { normalizeListItemType } from './list-item.ts';
import { partialMetadataListItem } from './resource-query.ts';

const groupName = apiGroup.refine(value => !!value);
const version = z.object({ name: apiVersion, served: z.boolean(), storage: z.boolean() });
const definitionSchema = z.object({
  apiVersion: z.literal('apiextensions.k8s.io/v1'), kind: z.literal('CustomResourceDefinition'),
  metadata: z.object({ name: dnsName, uid: boundedName, resourceVersion: boundedName }),
  spec: z.object({ group: groupName, scope: z.enum(['Namespaced', 'Cluster']),
    names: z.object({ plural: resourceName, kind: boundedName, listKind: boundedName.optional() }), versions: z.array(version).min(1).max(64) }),
});
export type CustomResourceDefinition = z.infer<typeof definitionSchema>;

const definitionPageSchema = z.object({ apiVersion: z.enum(['apiextensions.k8s.io/v1', 'meta.k8s.io/v1']), kind: z.enum(['CustomResourceDefinitionList', 'PartialObjectMetadataList']),
  metadata: z.object({ resourceVersion: boundedName, continue: z.string().max(8192).refine(value => !containsControlCharacters(value)).optional() }), items: z.array(z.unknown()).max(100) });

export function projectDefinitionPage(input: unknown, request: { limit: number; continue: string; resourceVersion?: string }) {
  const parsed = definitionPageSchema.safeParse(input);
  if (!parsed.success || parsed.data.items.length > request.limit) throw new BoundaryError('RESOURCE_INVALID');
  const page = parsed.data;
  if (page.apiVersion !== 'apiextensions.k8s.io/v1' || page.kind !== 'CustomResourceDefinitionList') throw new BoundaryError('RESOURCE_INVALID');
  if (request.resourceVersion && request.resourceVersion !== page.metadata.resourceVersion) throw new BoundaryError('STALE_TARGET');
  if (page.metadata.continue && page.metadata.continue === request.continue) throw new BoundaryError('RESOURCE_INVALID');
  const definitions = page.items.map(item => projectCustomResourceDefinition(normalizeListItemType(item, page.apiVersion, 'CustomResourceDefinition')));
  if (new Set(definitions.map(item => item.metadata.name)).size !== definitions.length) throw new BoundaryError('RESOURCE_INVALID');
  return { definitions, resourceVersion: page.metadata.resourceVersion, continue: page.metadata.continue || null };
}

export function projectDefinitionFolderPage(input: unknown, request: Parameters<typeof projectDefinitionPage>[1]) {
  const parsed = definitionPageSchema.safeParse(input);
  if (!parsed.success || parsed.data.items.length > request.limit) throw new BoundaryError('RESOURCE_INVALID');
  const page = parsed.data;
  if (page.apiVersion !== 'meta.k8s.io/v1' || page.kind !== 'PartialObjectMetadataList') {
    const full = projectDefinitionPage(input, request);
    return { resourceVersion: full.resourceVersion, continue: full.continue,
      folders: full.definitions.map(item => ({ label: item.spec.names.plural, definition: item.metadata })) };
  }
  if (request.resourceVersion && request.resourceVersion !== page.metadata.resourceVersion) throw new BoundaryError('STALE_TARGET');
  if (page.metadata.continue && page.metadata.continue === request.continue) throw new BoundaryError('RESOURCE_INVALID');
  const seen = new Set<string>();
  const folders = page.items.map(item => {
    const metadata = partialMetadataListItem.safeParse(item);
    if (!metadata.success) throw new BoundaryError('RESOURCE_INVALID');
    const { name, uid, resourceVersion, namespace } = metadata.data.metadata;
    const dot = name.indexOf('.'), label = name.slice(0, dot);
    if (namespace !== undefined || dot < 1 || !dnsName.safeParse(name).success || !resourceName.safeParse(label).success
      || !groupName.safeParse(name.slice(dot + 1)).success || seen.has(name)) throw new BoundaryError('RESOURCE_INVALID');
    seen.add(name);
    // Label only. The single-object CRD proof and live discovery decide the actual route.
    return { label, definition: { name, uid, resourceVersion } };
  });
  return { folders, resourceVersion: page.metadata.resourceVersion, continue: page.metadata.continue || null };
}

// Unknown schema/conversion/webhook/annotations are never retained in this descriptor.
export function projectCustomResourceDefinition(input: unknown): CustomResourceDefinition {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID');
  const definition = parsed.data;
  const { spec, metadata } = definition;
  if (metadata.name !== `${spec.names.plural}.${spec.group}` || spec.versions.filter(item => item.storage).length !== 1
    || new Set(spec.versions.map(item => item.name)).size !== spec.versions.length) throw new BoundaryError('RESOURCE_INVALID');
  return definition;
}

const groupSchema = z.object({ name: groupName, versions: z.array(z.object({ groupVersion: boundedName, version: apiVersion })).min(1).max(64),
  preferredVersion: z.object({ groupVersion: boundedName, version: apiVersion }) });

export function projectApiGroup(input: unknown) {
  const parsed = groupSchema.safeParse(input);
  if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID');
  const group = parsed.data;
  if (new Set(group.versions.map(item => item.version)).size !== group.versions.length
    || [...group.versions, group.preferredVersion].some(item => item.groupVersion !== `${group.name}/${item.version}`)
    || !group.versions.some(item => item.version === group.preferredVersion.version)) throw new BoundaryError('RESOURCE_INVALID');
  return Object.freeze({ group: group.name, versions: Object.freeze([group.preferredVersion.version,
    ...group.versions.map(item => item.version).filter(item => item !== group.preferredVersion.version)]) });
}

// Storage is NOT a routing preference. Select a served, LIST-able complete GVR in API-group
// discovery order (preferred first), including non-storage versions. Never use shortNames.
export function resolveCustomResourceType(definitionInput: unknown, apiGroupInput: unknown, discoveries: readonly ResourceType[]) {
  return resolveCustomResourceTypeInGroup(definitionInput, projectApiGroup(apiGroupInput), discoveries);
}

// Reader discovery is already normalized; never feed this DTO back into the raw APIGroup parser.
export function resolveCustomResourceTypeInGroup(definitionInput: unknown, groupInput: unknown, discoveries: readonly ResourceType[]) {
  const definition = projectCustomResourceDefinition(definitionInput);
  const parsedGroup = z.object({ group: groupName, versions: z.array(apiVersion).min(1).max(64) }).strict().safeParse(groupInput);
  if (!parsedGroup.success || new Set(parsedGroup.data.versions).size !== parsedGroup.data.versions.length) throw new BoundaryError('RESOURCE_INVALID');
  const group = parsedGroup.data;
  const parsedDiscovery = z.array(resourceTypeSchema).max(10_000).safeParse(discoveries);
  if (!parsedDiscovery.success) throw new BoundaryError('RESOURCE_INVALID');
  if (group.group !== definition.spec.group) throw new BoundaryError('STALE_TARGET');
  for (const version of group.versions) {
    if (!definition.spec.versions.some(item => item.name === version && item.served)) continue;
    const matches = parsedDiscovery.data.filter(type => type.group === group.group && type.version === version && type.resource === definition.spec.names.plural);
    if (matches.length > 1) throw new BoundaryError('RESOURCE_INVALID');
    const match = matches[0];
    if (!match) continue;
    if (match.kind !== definition.spec.names.kind || match.scope !== (definition.spec.scope === 'Namespaced' ? 'namespace' : 'cluster')) throw new BoundaryError('STALE_TARGET');
    return Object.freeze({ type: Object.freeze({ ...match }), listKind: definition.spec.names.listKind ?? `${match.kind}List`,
      label: definition.spec.names.plural, crd: Object.freeze({ ...definition.metadata }) });
  }
  throw new BoundaryError('NOT_FOUND'); // Not an empty/healthy custom-resource collection.
}

export function customResourceFolder(resolved: ReturnType<typeof resolveCustomResourceType>, target: TargetIdentity) {
  return { id: stableNodeId(target, 'custom-resource-type', resolved.type.group, resolved.type.version, resolved.type.resource, resolved.crd.uid),
    type: 'folder' as const, label: resolved.label, expandable: true, resourceType: resolved.type, listKind: resolved.listKind, crd: resolved.crd };
}
