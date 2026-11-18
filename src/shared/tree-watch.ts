import { sameTarget } from './identity.ts';
import type { TreeQuery } from './tree-entries.ts';
import type { WatchSource } from './watch-protocol.ts';
import { referenceKey } from './branch-protocol.ts';

// Metadata cannot prove selector membership (including newly matching Pods). Invalidate lists, never patch spec/status or RV.
export function treeQueryAffectedByWatch(query: TreeQuery, source: WatchSource): boolean {
  if (!sameTarget(query.target, source.target)) return false;
  if (source.custom) return query.kind === 'custom-resources' && referenceKey(query.definition) === referenceKey(source.custom.definition);
  if (query.kind === 'resources') return query.resource === source.resource;
  return source.resource === 'pods' && query.kind === 'children'
    && ['nodes', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'services'].includes(query.parent.resource);
}

// Preserve expansion intent only across the same full query identity with an advanced opaque RV.
export function sameTreeQueryIdentity(left: TreeQuery | null, right: TreeQuery | null): boolean {
  const identity = (query: TreeQuery | null) => {
    if (query?.kind === 'children') { const { resourceVersion: _rv, ...parent } = query.parent; return { ...query, parent }; }
    if (query?.kind === 'custom-resources') { const { resourceVersion: _rv, ...definition } = query.definition; return { ...query, definition }; }
    return query;
  };
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}
