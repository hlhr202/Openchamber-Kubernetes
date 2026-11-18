import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName, containsControlCharacters } from '../../shared/identity.ts';
import { eventApiVersionSchema, eventMaximumPages, eventReadRequestSchema, eventReadResponseSchema, namespaceReferenceSchema } from '../../shared/event-protocol.ts';
import type { EventReadResponse } from '../../shared/event-protocol.ts';
import type { createResourceReader } from './resource-reader.ts';
import { createSealedCursor } from './sealed-cursor.ts';

const cursorSchema = z.object({ binding: z.string().regex(/^[a-f0-9]{64}$/), namespace: namespaceReferenceSchema, apiVersion: eventApiVersionSchema,
  continuation: z.string().min(1).max(8192).refine(value => !containsControlCharacters(value)), resourceVersion: boundedName,
  page: z.number().int().min(1).max(eventMaximumPages), expiresAt: z.number().int().nonnegative() }).strict();

// Finite event LIST pages only. No Watch, background retries, persistent cache or M5 session.
export function createEventReader(reader: Pick<ReturnType<typeof createResourceReader>, 'events'>, clock = Date.now) {
  const codec = createSealedCursor('ev1', 'openchamber-kubernetes-events-1');
  let disposed = false;
  function now() { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) throw new BoundaryError('STATE_UNAVAILABLE'); return value; }
  return {
    async read(input: unknown, signal: AbortSignal): Promise<EventReadResponse> {
      if (disposed) throw new BoundaryError('SERVICE_CLOSED');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      const parsed = eventReadRequestSchema.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const { cursor, ...request } = parsed.data, binding = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      let previous: z.infer<typeof cursorSchema> | undefined;
      if (cursor) {
        try { previous = cursorSchema.parse(codec.open(cursor)); }
        catch { throw new BoundaryError('STALE_TARGET'); }
        if (previous.binding !== binding) throw new BoundaryError('STALE_TARGET');
        if (now() >= previous.expiresAt) throw new BoundaryError('CONTINUATION_EXPIRED');
        if (previous.page >= eventMaximumPages) throw new BoundaryError('QUERY_LIMIT');
      }
      const expiresAt = previous?.expiresAt ?? now() + 60_000, page = (previous?.page ?? 0) + 1;
      const result = await reader.events(request.target, request.scope, signal, previous);
      if (disposed) throw new BoundaryError('SERVICE_CLOSED');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (now() >= expiresAt) throw new BoundaryError('CONTINUATION_EXPIRED');
      if (previous && result.apiVersion !== previous.apiVersion) throw new BoundaryError('STALE_TARGET');
      const nextCursor = result.continuation ? codec.seal({ binding, namespace: result.namespace, apiVersion: result.apiVersion, continuation: result.continuation,
        resourceVersion: result.resourceVersion, page, expiresAt }) : null;
      const response = eventReadResponseSchema.safeParse({ protocol: 2, kind: 'events', target: request.target, scope: request.scope, namespace: result.namespace, apiVersion: result.apiVersion,
        resourceVersion: result.resourceVersion, page, rows: result.rows, nextCursor });
      if (!response.success) throw new BoundaryError('RESOURCE_INVALID');
      if (Buffer.byteLength(JSON.stringify(response.data)) > 480_000) throw new BoundaryError('BUDGET_EXCEEDED');
      return response.data;
    },
    dispose() { disposed = true; codec.dispose(); },
  };
}
