import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { inspectionBytes, inspectionChunkCharacters, inspectionPageSchema, inspectionRequestSchema, sameInspectionObject } from '../../shared/inspection-protocol.ts';
import type { InspectionPage, InspectionRequest, InspectionReference } from '../../shared/inspection-protocol.ts';
import { documentReferenceId } from '../../shared/document-protocol.ts';
import type { createResourceReader } from './resource-reader.ts';
import { createSealedCursor } from './sealed-cursor.ts';

const cursorSchema = z.object({ id: z.string().uuid(), binding: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(1).max(inspectionBytes) }).strict();
type Snapshot = { binding: string; text: string; bytes: number; identity: string; expiresAt: number };
// Bounded ephemeral snapshots: CLI ages/events may change between calls; continuation NEVER re-runs Get/Describe.
export function createInspectionReader(reader: Pick<ReturnType<typeof createResourceReader>, 'inspect' | 'verifyReference' | 'clusterInfo' | 'verifyTarget'> & Partial<Pick<ReturnType<typeof createResourceReader>, 'verifyCustomInspection'>>, clock = Date.now) {
  const codec = createSealedCursor('ins1', 'openchamber-kubernetes-inspection-1'), secret = randomBytes(32), snapshots = new Map<string, Snapshot>();
  let closed = false, retainedBytes = 0;
  function now() { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) throw new BoundaryError('STATE_UNAVAILABLE'); return value; }
  function expire() { for (const [id, item] of snapshots) if (item.expiresAt <= now()) { snapshots.delete(id); retainedBytes -= item.bytes; } }
  function page(request: InspectionRequest, id: string, item: Snapshot, offset: number): InspectionPage {
    let end = Math.min(item.text.length, offset + inspectionChunkCharacters);
    if (end < item.text.length && item.text.charCodeAt(end - 1) >= 0xD800 && item.text.charCodeAt(end - 1) <= 0xDBFF) end--;
    const source = request.mode === 'cluster-info' ? { mode: request.mode, serviceNamespace: 'kube-system' } : { reference: request.reference, mode: request.mode };
    return inspectionPageSchema.parse({ protocol: 2, kind: 'inspection-output', target: request.target, ...source,
      contentIdentity: item.identity, expiresAt: item.expiresAt, totalBytes: item.bytes, totalCharacters: item.text.length, offset, end, text: item.text.slice(offset, end),
      nextCursor: end < item.text.length ? codec.seal({ id, binding: item.binding, offset: end }) : null });
  }
  return {
    async read(input: unknown, signal: AbortSignal): Promise<InspectionPage> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = inspectionRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const request = parsed.data, { cursor, ...bound } = request, binding = createHash('sha256').update(JSON.stringify(bound)).digest('hex'); expire();
      if (cursor) {
        const parsedCursor = cursorSchema.safeParse(codec.open(cursor)); if (!parsedCursor.success || parsedCursor.data.binding !== binding) throw new BoundaryError('STALE_TARGET');
        const { id, offset } = parsedCursor.data, item = snapshots.get(id);
        if (!item || item.expiresAt <= now()) throw new BoundaryError('CONTINUATION_EXPIRED');
        if (item.binding !== binding || offset >= item.text.length) throw new BoundaryError('STALE_TARGET');
        if (request.mode === 'cluster-info') await reader.verifyTarget(request.target, signal);
        else if ('definition' in request.reference) {
          if (!reader.verifyCustomInspection) throw new BoundaryError('STATE_UNAVAILABLE');
          await reader.verifyCustomInspection(request.target, request.reference, signal);
        }
        else await reader.verifyReference(request.target, request.reference, signal);
        if (closed) throw new BoundaryError('SERVICE_CLOSED'); if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
        if (item.expiresAt <= now()) throw new BoundaryError('CONTINUATION_EXPIRED'); return page(request, id, item, offset);
      }
      if (snapshots.size >= 16 || retainedBytes >= 4 * inspectionBytes) throw new BoundaryError('QUERY_LIMIT');
      const project = (text: string, reference?: InspectionReference) => {
        if (closed) throw new BoundaryError('SERVICE_CLOSED'); if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); expire();
        if (request.mode !== 'cluster-info' && request.refresh && !reference) throw new BoundaryError('STATE_UNAVAILABLE');
        const source = inspectionRequestSchema.parse(request.mode === 'cluster-info' ? request : { protocol: request.protocol, selection: request.selection, target: request.target,
          mode: request.mode, reference: reference ?? request.reference });
        if (request.mode !== 'cluster-info' && source.mode !== 'cluster-info' && (!sameInspectionObject(request.reference, source.reference)
          || (!request.refresh && documentReferenceId(request.reference) !== documentReferenceId(source.reference)))) throw new BoundaryError('STALE_TARGET');
        // Refresh rebinds ONLY the observed RV, never UID/GVR/name/namespace. Future cursors use this exact, flag-free reference.
        const normalizedBinding = createHash('sha256').update(JSON.stringify(source)).digest('hex');
        const bytes = Buffer.byteLength(text); if (!text || bytes > inspectionBytes) throw new BoundaryError('BUDGET_EXCEEDED');
        if (snapshots.size >= 16 || retainedBytes + bytes > 4 * inspectionBytes) throw new BoundaryError('QUERY_LIMIT');
        const id = randomUUID(), item: Snapshot = { binding: normalizedBinding, text, bytes, identity: createHmac('sha256', secret).update(id).update(normalizedBinding).update(text).digest('hex'), expiresAt: now() + 60_000 };
        const result = page(source, id, item, 0);
        // Single-page output requires no retained service snapshot. No explicit cache refresh or disk persistence.
        if (result.nextCursor) { snapshots.set(id, item); retainedBytes += bytes; }
        return result;
      };
      return request.mode === 'cluster-info' ? reader.clusterInfo(request.target, project, signal) : reader.inspect(request.target, request.reference, request.mode, project, signal, !!request.refresh);
    },
    dispose() { closed = true; snapshots.clear(); retainedBytes = 0; secret.fill(0); codec.dispose(); },
  };
}
