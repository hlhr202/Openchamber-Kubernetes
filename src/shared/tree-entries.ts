import { z } from 'zod';
import { BoundaryError } from './errors.ts';
import { definitionReferenceSchema, helmReleaseTreeNodeSchema, helmRevisionTreeNodeSchema, parentFromResource, parentReferenceSchema } from './branch-protocol.ts';
import type { DefinitionReference, ParentReference } from './branch-protocol.ts';
import { boundedName, namespaceName, resourceTypeSchema, stableNodeId, targetSchema } from './identity.ts';
import type { ResourceType, TargetIdentity } from './identity.ts';
import { contextFolders, resourceDescriptors } from './tree.ts';
import type { TreeNode } from './tree.ts';
import { builtinResourceKey, resourceIdentitySchema, resourceNodeSchema } from './resource-protocol.ts';

export type TreeQuery = { readonly target: TargetIdentity } & (
  { readonly kind: 'context' } | { readonly kind: 'group'; readonly label: string }
  | { readonly kind: 'resources'; readonly resource: string }
  | { readonly kind: 'children'; readonly parent: ParentReference }
  | { readonly kind: 'custom-types' } | { readonly kind: 'custom-resources'; readonly definition: DefinitionReference }
  | { readonly kind: 'helm-dependency' }
  | { readonly kind: 'helm-releases' }
  | { readonly kind: 'helm-release-history'; readonly release: string; readonly namespace: string });
export type TreeEntry = { readonly node: TreeNode; readonly query: TreeQuery | null };
export type TreePageProof = { readonly resourceVersion: string | null; readonly resourceType?: ResourceType; readonly listKind?: string };
export type TreePage = { readonly entries: readonly TreeEntry[]; readonly cursor: string | null; readonly proof: TreePageProof };
export function readTreeProof(input: unknown): TreePageProof {
  const parsed = z.object({ resourceVersion: boundedName.nullable(), resourceType: resourceTypeSchema.optional(), listKind: boundedName.optional() }).strict().safeParse(input);
  if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
  return Object.freeze({ resourceVersion: parsed.data.resourceVersion, ...(parsed.data.resourceType ? { resourceType: Object.freeze(parsed.data.resourceType) } : {}),
    ...(parsed.data.listKind ? { listKind: parsed.data.listKind } : {}) });
}
const target = { target: targetSchema };
const querySchema = z.discriminatedUnion('kind', [
  z.object({ ...target, kind: z.literal('context') }).strict(),
  z.object({ ...target, kind: z.literal('group'), label: z.enum(['Workloads', 'Network', 'Storage', 'Configuration']) }).strict(),
  z.object({ ...target, kind: z.literal('resources'), resource: builtinResourceKey }).strict(),
  z.object({ ...target, kind: z.literal('children'), parent: parentReferenceSchema }).strict(),
  z.object({ ...target, kind: z.literal('custom-types') }).strict(),
  z.object({ ...target, kind: z.literal('custom-resources'), definition: definitionReferenceSchema }).strict(),
  z.object({ ...target, kind: z.literal('helm-dependency') }).strict(),
  z.object({ ...target, kind: z.literal('helm-releases') }).strict(),
  z.object({ ...target, kind: z.literal('helm-release-history'), release: boundedName.max(253), namespace: namespaceName }).strict(),
]);
const id = z.string().min(1).max(16_000);
const entrySchema = z.object({ query: querySchema.nullable(), node: z.union([
  z.object({ id, type: z.literal('context'), label: boundedName, expandable: z.boolean(), tooltip: z.string().max(2100), icon: z.enum(['kubernetes', 'aks', 'minikube']).optional() }).strict(),
  z.object({ id, type: z.literal('folder'), label: boundedName, expandable: z.literal(true) }).strict(),
  resourceNodeSchema,
  z.object({ id, type: z.literal('config-key'), label: boundedName, key: boundedName, resource: resourceIdentitySchema, expandable: z.literal(false) }).strict(),
  z.object({ id, type: z.enum(['info', 'message']), label: boundedName, expandable: z.literal(false) }).strict(),
  helmReleaseTreeNodeSchema,
  helmRevisionTreeNodeSchema,
]) }).strict().refine(value => value.node.expandable === (value.query !== null));

export function readTreeEntry(input: unknown): TreeEntry {
  const parsed = entrySchema.safeParse(input);
  if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
  const freeze = (value: unknown): void => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } };
  const node = parsed.data.node;
  const entry: TreeEntry = { query: parsed.data.query, node: { id: node.id, type: node.type, label: node.label, expandable: node.expandable,
    ...('tooltip' in node && node.tooltip !== undefined ? { tooltip: node.tooltip } : {}),
    ...('description' in node && node.description !== undefined ? { description: node.description } : {}),
    ...('icon' in node && node.icon !== undefined ? { icon: node.icon } : {}),
    ...('forwardPorts' in node && node.forwardPorts !== undefined ? { forwardPorts: node.forwardPorts } : {}),
    ...('children' in node ? { children: node.children } : {}), ...('key' in node ? { key: node.key } : {}),
    ...('release' in node ? { release: node.release } : {}),
    ...('revision' in node ? { revision: node.revision } : {}),
    ...('releaseName' in node ? { releaseName: node.releaseName } : {}),
    ...('namespace' in node ? { namespace: node.namespace } : {}),
    ...('partial' in node ? { partial: node.partial } : {}),
    ...('resource' in node ? { resource: { group: node.resource.group, version: node.resource.version, resource: node.resource.resource, kind: node.resource.kind, scope: node.resource.scope, name: node.resource.name,
      ...(node.resource.namespace !== undefined ? { namespace: node.resource.namespace } : {}), ...(node.resource.uid !== undefined ? { uid: node.resource.uid } : {}),
      ...(node.resource.resourceVersion !== undefined ? { resourceVersion: node.resource.resourceVersion } : {}) } } : {}) } };
  freeze(entry);
  return entry;
}

export function resourceTreeEntry(input: unknown, target: TargetIdentity): TreeEntry {
  const parsed = resourceNodeSchema.safeParse(input);
  if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
  const node = parsed.data, parent = parentFromResource(node);
  // Missing stable references do not manufacture a query. The row remains present as a leaf.
  return readTreeEntry({ node: { ...node, expandable: !!parent }, query: parent ? { target, kind: 'children', parent } : null });
}

export function localTreeEntries(query: TreeQuery, options: { readonly helmReleases?: boolean } = {}): readonly TreeEntry[] | null {
  if (query.kind !== 'context' && query.kind !== 'group') return null;
  const folders = query.kind === 'context' ? contextFolders : (contextFolders.find(folder => folder.label === query.label)?.resources ?? []).map(resource => ({ label: resourceDescriptors[resource].label, resource }));
  return folders.map(folder => {
    let child: TreeQuery;
    if ('resource' in folder && folder.resource) child = { target: query.target, kind: 'resources', resource: folder.resource };
    else if ('resources' in folder && folder.resources) child = { target: query.target, kind: 'group', label: folder.label };
    else child = { target: query.target, kind: folder.label === 'Custom Resources' ? 'custom-types' : options.helmReleases ? 'helm-releases' : 'helm-dependency' };
    return { node: { id: stableNodeId(query.target, 'tree-folder', folder.label), type: 'folder', label: folder.label, expandable: true }, query: child };
  });
}
