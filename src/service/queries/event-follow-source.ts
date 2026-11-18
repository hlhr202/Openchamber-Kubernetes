import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';
import { eventCollectionPath } from '../../shared/event-protocol.ts';
import type { EventApiVersion } from '../../shared/event-protocol.ts';
import type { EventFollowDelta } from '../../shared/event-follow-protocol.ts';
import { eventFollowSourceSchema } from '../../shared/event-follow-protocol.ts';
import { projectEventRow } from './event-source.ts';
import { requireReadSuccess } from './resource-query.ts';
import type { ResourceReadRequest } from './resource-reader.ts';

export function planEventFollow(input: unknown, resourceVersion: string): ResourceReadRequest {
  const parsed = eventFollowSourceSchema.safeParse(input); if (!parsed.success || !boundedName.safeParse(resourceVersion).success || resourceVersion === '0') throw new BoundaryError('INVALID_INPUT');
  const source = parsed.data;
  return { method: 'GET', purpose: 'namespace-event-watch', target: source.target, path: eventCollectionPath(source.apiVersion, source.namespace.name), maximumBytes: 2_000_000,
    query: { watch: 'true', resourceVersion, timeoutSeconds: '5' } };
}
export function projectEventFollowDelta(value: unknown, namespace: string, apiVersion: EventApiVersion = 'v1'): Omit<EventFollowDelta, 'sequence'> {
  const parsed = z.object({ type: z.enum(['ADDED', 'MODIFIED', 'DELETED', 'BOOKMARK', 'ERROR']), object: z.unknown() }).safeParse(value);
  if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID'); const event = parsed.data;
  if (event.type === 'ERROR') { const status = z.object({ kind: z.literal('Status'), code: z.number().int() }).safeParse(event.object); if (!status.success) throw new BoundaryError('RESOURCE_INVALID'); requireReadSuccess(status.data.code); throw new BoundaryError('RESOURCE_INVALID'); }
  if (event.type === 'BOOKMARK') { const meta = z.object({ apiVersion: z.literal(apiVersion).optional(), kind: z.literal('Event').optional(), metadata: z.object({ resourceVersion: boundedName }) }).safeParse(event.object); if (!meta.success) throw new BoundaryError('RESOURCE_INVALID'); return { type: 'BOOKMARK', resourceVersion: meta.data.metadata.resourceVersion }; }
  if (!z.object({ apiVersion: z.literal(apiVersion), kind: z.literal('Event') }).safeParse(event.object).success) throw new BoundaryError('RESOURCE_INVALID');
  const row = projectEventRow(event.object, namespace, apiVersion); return { type: event.type, resourceVersion: row.resourceVersion, row };
}
