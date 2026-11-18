import { sameTarget } from './identity.ts';
import type { TargetIdentity } from './identity.ts';
import type { ManifestComparisonReference } from './manifest-diff-protocol.ts';
import type { TreeQuery } from './tree-entries.ts';
import { resourceDescriptors } from './tree.ts';
// Pure metadata invalidation, not an operation/refresh: never adopt server body, UID/RV or schema as an editor baseline.
export function treeQueryAffectedByCreate(query: TreeQuery, target: TargetIdentity, reference: ManifestComparisonReference): boolean {
  if (!sameTarget(query.target, target)) return false;
  const type = reference.type;
  if (query.kind === 'resources') {
    const descriptor = Object.entries(resourceDescriptors).find(([key]) => key === query.resource)?.[1];
    return !!descriptor && descriptor.group === type.group && descriptor.resource === type.resource && (type.scope === 'cluster' || reference.namespace === query.target.namespace);
  }
  if (query.kind === 'children') return type.group === '' && type.resource === 'pods' && (query.parent.resource === 'nodes'
    || query.parent.namespace === reference.namespace && ['deployments', 'statefulsets', 'daemonsets', 'jobs', 'services'].includes(query.parent.resource));
  if (query.kind === 'custom-resources') return query.definition.name === `${type.resource}.${type.group}` && (type.scope === 'cluster' || reference.namespace === query.target.namespace);
  return query.kind === 'custom-types' && type.group === 'apiextensions.k8s.io' && type.resource === 'customresourcedefinitions';
}
