import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName, containsControlCharacters, dnsName, namespaceName } from '../../shared/identity.ts';
import { eventApiVersionSchema, eventPageLimit, eventText, eventTimestamp } from '../../shared/event-protocol.ts';
import type { EventApiVersion, EventRow, NamespaceReference } from '../../shared/event-protocol.ts';

const timestamp = eventTimestamp.nullable().optional();
const reference = z.object({ apiVersion: eventText(1024).optional(), kind: eventText(1024).optional(), name: eventText(1024).optional(),
  namespace: namespaceName.optional(), uid: eventText(1024).optional() });
const metadataSchema = z.object({ name: dnsName, namespace: namespaceName, uid: boundedName, resourceVersion: boundedName, creationTimestamp: timestamp });
const reporterSchema = z.object({ component: eventText(1024).optional(), host: eventText(1024).optional() });
const count = z.number().int().min(0).max(2_147_483_647);
const series = z.object({ count: count.optional(), lastObservedTime: timestamp }).nullable().optional();
const itemSchema = z.object({ apiVersion: z.literal('v1').optional(), kind: z.literal('Event').optional(),
  metadata: metadataSchema,
  involvedObject: reference, type: eventText(1024).optional(), reason: eventText(1024).optional(), message: eventText(16_384).optional(), action: eventText(1024).optional(),
  source: reporterSchema.optional(), reportingComponent: eventText(1024).optional(), reportingInstance: eventText(1024).optional(),
  firstTimestamp: timestamp, lastTimestamp: timestamp, eventTime: timestamp, count: count.optional(), series,
});
const groupedItemSchema = z.object({ apiVersion: z.literal('events.k8s.io/v1').optional(), kind: z.literal('Event').optional(), metadata: metadataSchema,
  regarding: reference.optional(), type: eventText(1024).optional(), reason: eventText(1024).optional(), note: eventText(16_384).optional(), action: eventText(1024).optional(),
  reportingController: eventText(1024).optional(), reportingInstance: eventText(1024).optional(), eventTime: eventTimestamp.nullable(), series,
  deprecatedSource: reporterSchema.optional(), deprecatedFirstTimestamp: timestamp, deprecatedLastTimestamp: timestamp, deprecatedCount: count.optional(),
});
const pageSchema = z.object({ apiVersion: eventApiVersionSchema, kind: z.literal('EventList'),
  metadata: z.object({ resourceVersion: boundedName, continue: z.string().max(8192).refine(value => !containsControlCharacters(value)).optional() }),
  items: z.array(z.unknown()).max(eventPageLimit),
});
export type EventSourcePage = { readonly apiVersion: EventApiVersion; readonly rows: readonly EventRow[]; readonly resourceVersion: string; readonly continuation: string | null; readonly namespace: NamespaceReference };

export function projectEventNamespace(input: unknown, name: string, expected?: NamespaceReference): NamespaceReference {
  // Namespace metadata has other fields. Parse only the identity, not the entire raw resource.
  const identity = z.object({ apiVersion: z.literal('v1'), kind: z.literal('Namespace'),
    metadata: z.object({ name: namespaceName, uid: boundedName, resourceVersion: boundedName, namespace: z.never().optional() }) }).safeParse(input);
  if (!identity.success) throw new BoundaryError('RESOURCE_INVALID');
  const value = identity.data.metadata;
  if (value.name !== name || (expected && (value.name !== expected.name || value.uid !== expected.uid || value.resourceVersion !== expected.resourceVersion))) throw new BoundaryError('STALE_TARGET');
  return value;
}

export function projectEventPage(input: unknown, namespace: NamespaceReference, previous?: { resourceVersion: string; continuation: string }, apiVersion: EventApiVersion = 'v1'): EventSourcePage {
  const parsed = pageSchema.safeParse(input);
  if (!parsed.success || parsed.data.apiVersion !== apiVersion) throw new BoundaryError('RESOURCE_INVALID');
  const { items, metadata } = parsed.data;
  if (previous && metadata.resourceVersion !== previous.resourceVersion) throw new BoundaryError('STALE_TARGET');
  if (metadata.continue && metadata.continue === previous?.continuation) throw new BoundaryError('RESOURCE_INVALID');
  const rows: EventRow[] = items.map(value => projectEventRow(value, namespace.name, apiVersion));
  if (new Set(rows.map(row => row.uid)).size !== rows.length || new Set(rows.map(row => row.name)).size !== rows.length) throw new BoundaryError('RESOURCE_INVALID');
  const result = { apiVersion, rows, resourceVersion: metadata.resourceVersion, continuation: metadata.continue || null, namespace };
  if (Buffer.byteLength(JSON.stringify(result)) > 480_000) throw new BoundaryError('BUDGET_EXCEEDED');
  return result; // Raw annotations, managedFields, arbitrary extensions and source objects never escape.
}
export function projectEventRow(input: unknown, namespace: string, apiVersion: EventApiVersion = 'v1'): EventRow {
  if (!eventApiVersionSchema.safeParse(apiVersion).success) throw new BoundaryError('RESOURCE_INVALID');
  if (apiVersion === 'events.k8s.io/v1') {
    const parsed = groupedItemSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID'); const value = parsed.data;
    // Exact version-specific mapping, never prefer similarly named unreviewed core fields from an events.k8s.io response.
    return projectEventRow({ metadata: value.metadata, involvedObject: value.regarding ?? {}, type: value.type, reason: value.reason, message: value.note, action: value.action,
      source: value.deprecatedSource, reportingComponent: value.reportingController, reportingInstance: value.reportingInstance, firstTimestamp: value.deprecatedFirstTimestamp,
      lastTimestamp: value.deprecatedLastTimestamp, eventTime: value.eventTime, count: value.deprecatedCount, series: value.series }, namespace, 'v1');
  }
  const parsed = itemSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID'); const value = parsed.data;
  if (value.metadata.namespace !== namespace) throw new BoundaryError('STALE_TARGET');
  return { name: value.metadata.name, namespace: value.metadata.namespace, uid: value.metadata.uid, resourceVersion: value.metadata.resourceVersion,
      type: value.type ?? '', reason: value.reason ?? '', message: value.message ?? '', action: value.action ?? '',
      reporter: [value.reportingComponent || value.source?.component, value.reportingInstance || value.source?.host].filter(Boolean).join(' / '),
      object: { apiVersion: value.involvedObject.apiVersion ?? '', kind: value.involvedObject.kind ?? '', name: value.involvedObject.name ?? '', namespace: value.involvedObject.namespace ?? null, uid: value.involvedObject.uid ?? '' },
      created: value.metadata.creationTimestamp ?? null, first: value.firstTimestamp ?? null, last: value.lastTimestamp ?? null, eventTime: value.eventTime ?? null,
      series: value.series ? { count: value.series.count ?? null, lastObservedTime: value.series.lastObservedTime ?? null } : null, count: value.count ?? null };
}
