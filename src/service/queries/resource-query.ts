import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { apiGroup, apiVersion, boundedName, containsControlCharacters, dnsName, namespaceName, resourceTypeSchema, targetSchema } from '../../shared/identity.ts';
import type { ResourceType } from '../../shared/identity.ts';
import { resourceDescriptors } from '../../shared/tree.ts';
import { podSelection } from './selectors.ts';
import { projectResource } from './tree-projection.ts';
import { normalizeListItemType } from './list-item.ts';
import { isCustomMetadataType, prefersResourceListMetadata } from './resource-list-representation.ts';
import { definitionReferenceSchema } from '../../shared/branch-protocol.ts';

const continuation = z.string().max(8192).refine(value => !containsControlCharacters(value));
const requestSchema = z.object({
  target: targetSchema,
  type: resourceTypeSchema,
  listKind: boundedName.optional(),
  customDefinition: definitionReferenceSchema.optional(),
  namespaces: z.enum(['selected', 'all']).default('selected'),
  limit: z.number().int().min(1).max(100).default(100),
  continue: continuation.default(''),
  resourceVersion: boundedName.optional(),
  filter: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }).strict(),
    z.object({ kind: z.literal('node'), name: dnsName }).strict(),
    z.object({ kind: z.literal('selector'), source: z.enum(['workload', 'service']), selector: z.unknown() }).strict(),
  ]).default({ kind: 'none' }),
}).strict();
export type ListRequest = z.infer<typeof requestSchema>;
export type ListPlan = {
  readonly kind: 'list'; readonly request: ListRequest;
  readonly metadata: boolean;
  readonly path: string; readonly query: Readonly<Record<string, string>>; readonly key: readonly string[];
} | { readonly kind: 'empty'; readonly request: ListRequest };

export function apiDiscoveryPath(group: string, version: string): string {
  if (!apiGroup.safeParse(group).success || !apiVersion.safeParse(version).success) throw new BoundaryError('INVALID_INPUT');
  return group ? `/apis/${group}/${version}` : `/api/${version}`;
}

// Describes GET paths only. It never invokes kubectl, authentication, HTTP or a write/session adapter.
export function planResourceList(input: unknown): ListPlan {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
  const request = parsed.data;
  Object.freeze(request.target);
  Object.freeze(request.type);
  if (request.customDefinition) Object.freeze(request.customDefinition);
  Object.freeze(request);
  const { type, target, filter } = request;
  if (request.continue && !request.resourceVersion) throw new BoundaryError('INVALID_INPUT');
  if (request.customDefinition && (!request.listKind || !isCustomMetadataType(type, request.customDefinition.name)
    || request.namespaces !== 'selected' || filter.kind !== 'none')) throw new BoundaryError('INVALID_INPUT');
  const corePods = type.group === '' && type.version === 'v1' && type.resource === 'pods' && type.kind === 'Pod' && type.scope === 'namespace';
  if ((filter.kind !== 'none' && !corePods) || (request.namespaces === 'all' && (!corePods || filter.kind !== 'node'))) throw new BoundaryError('INVALID_INPUT');
  const query: Record<string, string> = { limit: String(request.limit) };
  if (request.continue) query.continue = request.continue;
  if (filter.kind === 'node') query.fieldSelector = `spec.nodeName=${filter.name}`;
  if (filter.kind === 'selector') {
    const selection = podSelection(filter.selector, filter.source);
    if (selection.kind === 'empty') return { kind: 'empty', request };
    query.labelSelector = selection.query;
  }
  const prefix = apiDiscoveryPath(type.group, type.version);
  const namespacePath = type.scope === 'namespace' && request.namespaces === 'selected' ? `/namespaces/${target.namespace}` : '';
  const path = `${prefix}${namespacePath}/${type.resource}`;
  // Hash is an in-memory lookup key only, never a credential fingerprint or public response field.
  const queryHash = createHash('sha256').update(JSON.stringify([path, query, request.resourceVersion ?? '', type.kind, request.listKind ?? `${type.kind}List`, request.customDefinition ?? null])).digest('hex');
  return { kind: 'list', request, path, query: Object.freeze(query), metadata: !!request.customDefinition || (!request.listKind && prefersResourceListMetadata(type)), key: Object.freeze([
    target.serviceGeneration, target.projectId, target.configIdentity, target.context, target.namespace,
    'resource-list', type.group || 'core', type.version, type.resource, type.scope, queryHash,
  ]) };
}

const discoverySchema = z.object({
  groupVersion: boundedName,
  resources: z.array(z.object({ name: boundedName, namespaced: z.boolean(), kind: boundedName, verbs: z.array(boundedName).max(64) })).max(10_000),
});

export function projectDiscovery(value: unknown, requiredVerbs: readonly string[] = ['list']): readonly ResourceType[] {
  const parsed = discoverySchema.safeParse(value);
  if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID');
  const parts = parsed.data.groupVersion.split('/');
  if (parts.length > 2) throw new BoundaryError('RESOURCE_INVALID');
  const group = parts.length === 2 ? parts[0] ?? '' : '';
  const version = parts.at(-1) ?? '';
  if (!apiGroup.safeParse(group).success || !apiVersion.safeParse(version).success || (parts.length === 2 && !group)) throw new BoundaryError('RESOURCE_INVALID');
  const seen = new Set<string>();
  const resources: ResourceType[] = [];
  for (const resource of parsed.data.resources) {
    if (resource.name.includes('/')) continue; // Never expose status/scale/exec/proxy subresources as tree kinds.
    const result = resourceTypeSchema.safeParse({ group, version, resource: resource.name, kind: resource.kind, scope: resource.namespaced ? 'namespace' : 'cluster' });
    if (!result.success || seen.has(resource.name)) throw new BoundaryError('RESOURCE_INVALID');
    seen.add(resource.name);
    if (requiredVerbs.every(verb => resource.verbs.includes(verb))) resources.push(Object.freeze(result.data));
  }
  return Object.freeze(resources);
}

export function requireReadSuccess(status: number): void {
  if (status === 401) throw new BoundaryError('UNAUTHENTICATED');
  if (status === 403) throw new BoundaryError('FORBIDDEN');
  if (status === 404) throw new BoundaryError('NOT_FOUND');
  if (status === 410) throw new BoundaryError('CONTINUATION_EXPIRED');
  if (status === 429) throw new BoundaryError('QUERY_LIMIT');
  if (status !== 200) throw new BoundaryError('STATE_UNAVAILABLE');
}

const pageSchema = z.object({
  apiVersion: boundedName, kind: boundedName,
  metadata: z.object({ resourceVersion: boundedName, continue: continuation.optional() }),
  items: z.array(z.unknown()).max(100),
});
export const partialMetadataListItem = z.object({
  apiVersion: z.literal('meta.k8s.io/v1').optional(), kind: z.literal('PartialObjectMetadata').optional(),
  metadata: z.object({ name: boundedName, namespace: namespaceName.optional(), uid: boundedName, resourceVersion: boundedName }),
}).strict();

// Accepts a bounded SINGLE upstream page; never fetches all resources and silently slices them.
// A future transport must also cap bytes while reading, before constructing this text.
export function projectResourcePage(status: number, text: string, plan: Extract<ListPlan, { kind: 'list' }>) {
  requireReadSuccess(status); // Do not parse/reflect untrusted upstream error bodies.
  if (Buffer.byteLength(text) > 2_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new BoundaryError('RESOURCE_INVALID'); }
  const result = pageSchema.safeParse(value);
  if (!result.success) throw new BoundaryError('RESOURCE_INVALID');
  const page = result.data;
  const { type, target } = plan.request;
  const version = type.group ? `${type.group}/${type.version}` : type.version;
  const partial = plan.metadata && page.apiVersion === 'meta.k8s.io/v1' && page.kind === 'PartialObjectMetadataList';
  if ((!partial && (page.apiVersion !== version || page.kind !== (plan.request.listKind ?? `${type.kind}List`))) || page.items.length > plan.request.limit) throw new BoundaryError('RESOURCE_INVALID');
  if (plan.request.resourceVersion && page.metadata.resourceVersion !== plan.request.resourceVersion) throw new BoundaryError('STALE_TARGET');
  if (page.metadata.continue && page.metadata.continue === plan.request.continue) throw new BoundaryError('RESOURCE_INVALID');
  const descriptor = Object.values(resourceDescriptors).find(item => item.group === type.group && item.version === type.version
    && item.resource === type.resource && item.kind === type.kind && item.scope === type.scope)
    ?? { ...type, label: type.resource, children: 'none' as const };
  const nodes = page.items.map(item => {
    const metadata = partial ? partialMetadataListItem.safeParse(item) : undefined;
    if (metadata && !metadata.success) throw new BoundaryError('RESOURCE_INVALID');
    const object = metadata?.data ?? normalizeListItemType(item, version, type.kind);
    const row = projectResource(object, descriptor, target);
    if (type.scope === 'namespace' && plan.request.namespaces === 'selected' && row.resource?.namespace !== target.namespace) throw new BoundaryError('STALE_TARGET');
    return row;
  });
  if (new Set(nodes.map(node => node.id)).size !== nodes.length) throw new BoundaryError('RESOURCE_INVALID');
  const projected = { target, type, nodes, resourceVersion: page.metadata.resourceVersion, continue: page.metadata.continue || null };
  if (Buffer.byteLength(JSON.stringify(projected)) > 480_000) throw new BoundaryError('BUDGET_EXCEEDED');
  return projected;
}
