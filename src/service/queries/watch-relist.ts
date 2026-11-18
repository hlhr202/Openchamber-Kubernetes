import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName, containsControlCharacters } from '../../shared/identity.ts';
import type { WatchSource } from '../../shared/watch-protocol.ts';
import { planResourceWatch, projectWatchEvent, watchResourceType } from './watch-source.ts';
import type { ResourceReadRequest } from './resource-reader.ts';
import { normalizeListItemType } from './list-item.ts';

export function planWatchRelist(source: WatchSource, continuation = ''): ResourceReadRequest {
  if (continuation.length > 8192 || containsControlCharacters(continuation)) throw new BoundaryError('INVALID_INPUT');
  const watch = planResourceWatch(source);
  return { ...watch, purpose: source.custom ? 'custom-resource-relist' : 'resource-list', query: { limit: '100', ...(continuation ? { continue: continuation } : {}),
    ...(source.object ? { fieldSelector: `metadata.name=${source.object.name}` } : {}) } }; // No stale RV, watch flag or alternate GVR.
}
const list = z.object({ apiVersion: boundedName, kind: boundedName, metadata: z.object({ resourceVersion: boundedName.refine(value => value !== '0'),
  continue: z.string().max(8192).refine(value => !containsControlCharacters(value)).default('') }), items: z.array(z.unknown()).max(100) });
export function projectWatchRelist(value: unknown, source: WatchSource) {
  const parsed = list.safeParse(value), type = watchResourceType(source);
  if (!parsed.success || parsed.data.kind !== (source.custom?.listKind ?? `${type.kind}List`) || parsed.data.apiVersion !== (type.group ? `${type.group}/${type.version}` : type.version)) throw new BoundaryError('RESOURCE_INVALID');
  // Validate metadata only; never retain/spec-project complete list items or fabricate ADDED events.
  const identities = parsed.data.items.map(item => {
    const object = normalizeListItemType(item, parsed.data.apiVersion, type.kind);
    const event = projectWatchEvent({ type: 'ADDED', object }, source);
    if (!event.name || !event.uid) throw new BoundaryError('RESOURCE_INVALID'); return { name: event.name, uid: event.uid };
  });
  return { resourceVersion: parsed.data.metadata.resourceVersion, continuation: parsed.data.metadata.continue, identities };
}
