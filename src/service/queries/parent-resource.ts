import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { parentReferenceSchema } from '../../shared/branch-protocol.ts';
import type { ParentReference } from '../../shared/branch-protocol.ts';
import { boundedName, dnsName, namespaceName } from '../../shared/identity.ts';
import type { ResourceType, TargetIdentity } from '../../shared/identity.ts';
import { resourceDescriptors } from '../../shared/tree.ts';
import { apiDiscoveryPath } from './resource-query.ts';
import { normalizePodSelector, podSelection } from './selectors.ts';
import { projectConfigurationKeys, projectPodInformation, projectResource } from './tree-projection.ts';

export const crdType: ResourceType = Object.freeze({ group: 'apiextensions.k8s.io', version: 'v1', resource: 'customresourcedefinitions', kind: 'CustomResourceDefinition', scope: 'cluster' });
const objectSchema = z.object({ apiVersion: boundedName, kind: boundedName,
  metadata: z.object({ name: dnsName, namespace: namespaceName.optional(), uid: boundedName, resourceVersion: boundedName }) });
const selectorSpec = z.object({ spec: z.object({ selector: z.unknown().optional() }).optional() });

export function resourceObjectPath(type: ResourceType, name: string, namespace?: string): string {
  if (!dnsName.safeParse(name).success || (type.scope === 'namespace' ? !namespaceName.safeParse(namespace).success : namespace !== undefined)) throw new BoundaryError('INVALID_INPUT');
  return `${apiDiscoveryPath(type.group, type.version)}${namespace ? `/namespaces/${namespace}` : ''}/${type.resource}/${name}`;
}

export function verifyResourceObject(input: unknown, type: ResourceType, reference: { name: string; namespace?: string | undefined; uid: string; resourceVersion: string }): void {
  const parsed = objectSchema.safeParse(input);
  if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID');
  const value = parsed.data, metadata = value.metadata;
  if (value.apiVersion !== (type.group ? `${type.group}/${type.version}` : type.version) || value.kind !== type.kind
    || metadata.name !== reference.name || metadata.namespace !== reference.namespace || metadata.uid !== reference.uid || metadata.resourceVersion !== reference.resourceVersion) throw new BoundaryError('STALE_TARGET');
}

export function planParentResource(input: unknown, target: TargetIdentity) {
  const parsed = parentReferenceSchema.safeParse(input);
  if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
  const parent = parsed.data, descriptor = resourceDescriptors[parent.resource];
  if (descriptor.scope === 'namespace' && parent.resource !== 'pods' && parent.namespace !== target.namespace) throw new BoundaryError('STALE_TARGET');
  return { parent, descriptor, path: resourceObjectPath(descriptor, parent.name, parent.namespace) };
}

// Never returns a raw parent resource, Secret values, workload template or arbitrary spec.
export function projectParentResource(input: unknown, parent: ParentReference, target: TargetIdentity, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2000 || offset % 100) throw new BoundaryError('INVALID_INPUT');
  const { descriptor } = planParentResource(parent, target);
  verifyResourceObject(input, descriptor, parent);
  const node = projectResource(input, descriptor, target);
  if (descriptor.children === 'selected-pods') {
    if (offset) throw new BoundaryError('INVALID_INPUT');
    const parsed = selectorSpec.safeParse(input);
    if (!parsed.success) throw new BoundaryError('SELECTOR_INVALID');
    const selector = normalizePodSelector(parsed.data.spec?.selector, parent.resource === 'services' ? 'service' : 'workload');
    podSelection(selector, 'workload'); // Validate expression cardinality/budget before sharing a projected selector.
    return { kind: 'selected-pods' as const, selector };
  }
  if (descriptor.children === 'pods-on-node') {
    if (offset) throw new BoundaryError('INVALID_INPUT');
    return { kind: 'pods-on-node' as const };
  }
  if (descriptor.children === 'pod-info') {
    if (offset) throw new BoundaryError('INVALID_INPUT');
    return { kind: 'pod-info' as const, nodes: projectPodInformation(input, node) };
  }
  const keys = projectConfigurationKeys(input, node);
  if (offset > keys.length || (offset > 0 && offset === keys.length)) throw new BoundaryError('STALE_TARGET');
  return { kind: 'config-keys' as const, nodes: keys.slice(offset, offset + 100), nextOffset: offset + 100 < keys.length ? offset + 100 : null,
    order: createHash('sha256').update(JSON.stringify(keys.map(node => node.key))).digest('hex') };
}
