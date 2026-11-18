import { z } from 'zod';
import { boundedName, dnsName, hasWellFormedUnicode, namespaceName, targetSchema } from './identity.ts';
import { configSelectionSchema } from './configuration.ts';
import { resourceNodeSchema } from './resource-protocol.ts';
import { protocolVersion } from './protocol.ts';
import { BoundaryError } from './errors.ts';

export const eventPageLimit = 100;
export const eventMaximumPages = 20;
export const eventApiVersionSchema = z.enum(['v1', 'events.k8s.io/v1']);
export type EventApiVersion = z.infer<typeof eventApiVersionSchema>;
export function eventCollectionPath(apiVersion: EventApiVersion, namespace: string): string {
  if (!eventApiVersionSchema.safeParse(apiVersion).success || !namespaceName.safeParse(namespace).success) throw new BoundaryError('INVALID_INPUT');
  return `${apiVersion === 'v1' ? '/api/v1' : '/apis/events.k8s.io/v1'}/namespaces/${namespace}/events`;
}
export const namespaceReferenceSchema = z.object({ name: namespaceName, uid: boundedName, resourceVersion: boundedName }).strict();
export type NamespaceReference = z.infer<typeof namespaceReferenceSchema>;
export const eventScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current') }).strict(),
  namespaceReferenceSchema.extend({ kind: z.literal('namespace') }).strict(),
]);
export type EventScope = z.infer<typeof eventScopeSchema>;
export function eventScopeId(scope: EventScope): string { return JSON.stringify(scope.kind === 'current' ? ['current'] : ['namespace', scope.name, scope.uid, scope.resourceVersion]); }
export function eventScopeFromNode(value: unknown): EventScope | null {
  const parsed = resourceNodeSchema.safeParse(value);
  if (!parsed.success) return null;
  const ref = parsed.data.resource;
  if (ref.group !== '' || ref.version !== 'v1' || ref.resource !== 'namespaces' || ref.kind !== 'Namespace' || ref.scope !== 'cluster' || ref.namespace !== undefined) return null;
  const scope = eventScopeSchema.safeParse({ kind: 'namespace', name: ref.name, uid: ref.uid, resourceVersion: ref.resourceVersion });
  return scope.success ? scope.data : null;
}
export const eventReadRequestSchema = z.object({ protocol: z.literal(protocolVersion), selection: configSelectionSchema, target: targetSchema,
  scope: eventScopeSchema, cursor: z.string().min(1).max(17_000).optional() }).strict();
export type EventReadRequest = z.infer<typeof eventReadRequestSchema>;
export const eventText = (maximum: number) => z.string().max(maximum).refine(hasWellFormedUnicode);
export const eventTimestamp = z.string().max(64).regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/).refine(value => {
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? leap ? 29 : 28 : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return month >= 1 && month <= 12 && day >= 1 && day <= days && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60
    && Number(value.slice(17, 19)) < 60 && Number.isFinite(Date.parse(value));
});
export const eventRowSchema = z.object({ name: dnsName, namespace: namespaceName, uid: boundedName, resourceVersion: boundedName,
  type: eventText(1024), reason: eventText(1024), message: eventText(16_384), action: eventText(1024), reporter: eventText(2051),
  object: z.object({ apiVersion: eventText(1024), kind: eventText(1024), name: eventText(1024), namespace: namespaceName.nullable(), uid: eventText(1024) }).strict(),
  created: eventTimestamp.nullable(), first: eventTimestamp.nullable(), last: eventTimestamp.nullable(), eventTime: eventTimestamp.nullable(),
  series: z.object({ count: z.number().int().min(0).max(2_147_483_647).nullable(), lastObservedTime: eventTimestamp.nullable() }).strict().nullable(),
  count: z.number().int().min(0).max(2_147_483_647).nullable(),
}).strict();
export type EventRow = z.infer<typeof eventRowSchema>;
export const eventReadResponseSchema = z.object({ protocol: z.literal(protocolVersion), kind: z.literal('events'), target: targetSchema, scope: eventScopeSchema,
  namespace: namespaceReferenceSchema, apiVersion: eventApiVersionSchema, resourceVersion: boundedName, page: z.number().int().min(1).max(eventMaximumPages),
  rows: z.array(eventRowSchema).max(eventPageLimit), nextCursor: z.string().min(1).max(17_000).nullable() }).strict();
export type EventReadResponse = z.infer<typeof eventReadResponseSchema>;

// Counters describe one Event/series; never sum snapshots or fabricate a count of one.
export function eventOccurrences(row: EventRow): number | null { return row.series?.count ?? row.count; }
export function eventLastObserved(row: EventRow): string | null { return row.series?.lastObservedTime ?? row.last ?? row.eventTime ?? row.created; }
