import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { manifestDiffRequestSchema, manifestDiffPageSchema } from '../../shared/manifest-diff-protocol.ts';
import type { ManifestDiffPage, ManifestDiffRequest } from '../../shared/manifest-diff-protocol.ts';
import type { ManifestComparison } from './manifest-comparison.ts';
import type { createResourceReader } from './resource-reader.ts';
import { createSealedCursor } from './sealed-cursor.ts';
type Live = Extract<ManifestComparison, { kind: 'live' }>;
const cursorSchema = z.object({ id: z.uuid(), binding: z.string(), identity: z.string(), offset: z.number().int().min(1).max(1_048_576), expiresAt: z.number().int().nonnegative() }).strict();
// Captured live snapshots only. Local edited bodies never reach this service; no uploads, writer, dry-run or external diff tool.
export function createManifestDiffReader(reader: Pick<ReturnType<typeof createResourceReader>, 'compareManifest' | 'comparisonSnapshot'>, clock = Date.now) {
  const key = randomBytes(32), codec = createSealedCursor('md1', 'openchamber-manifest-diff-1');
  const records = new Map<string, { id: string; binding: string; identity: string; expiresAt: number; value: Live; bytes: number; pages: number }>(); let closed = false, preparing = 0;
  function collect() { for (const [id, value] of records) if (value.expiresAt <= clock()) records.delete(id); }
  function page(request: ManifestDiffRequest, record: { id: string; binding: string; identity: string; expiresAt: number; value: Live; bytes: number }, offset: number): ManifestDiffPage {
    if (closed || clock() >= record.expiresAt) throw new BoundaryError('VIEW_EXPIRED');
    const value = record.value; let end = Math.min(value.text.length, offset + 65_536);
    if (end < value.text.length && value.text.charCodeAt(end - 1) >= 0xD800 && value.text.charCodeAt(end - 1) <= 0xDBFF) end--;
    const result = manifestDiffPageSchema.parse({ protocol: 2, kind: 'live-comparison', target: request.target, locator: request.locator, format: request.format,
      reference: value.reference, uid: value.uid, resourceVersion: value.resourceVersion, identity: record.identity, expiresAt: record.expiresAt,
      totalBytes: record.bytes, totalCharacters: value.text.length, offset, end, text: value.text.slice(offset, end), nextCursor: end < value.text.length ? codec.seal({ id: record.id, binding: record.binding, identity: record.identity, offset: end, expiresAt: record.expiresAt }) : null });
    if (end === value.text.length) records.delete(record.id); return result;
  }
  return {
    async read(input: unknown, signal: AbortSignal): Promise<ManifestDiffPage> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED'); if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      const parsed = manifestDiffRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const request = parsed.data; collect();
      const binding = createHash('sha256').update(JSON.stringify([request.target, request.locator, request.format, request.expectedUid ?? ''])).digest('hex');
      if (request.cursor) {
        const parsed = cursorSchema.safeParse(codec.open(request.cursor)); if (!parsed.success || parsed.data.binding !== binding) throw new BoundaryError('STALE_TARGET'); const cursor = parsed.data, record = records.get(cursor.id);
        if (!record || record.binding !== binding || record.identity !== cursor.identity || record.expiresAt !== cursor.expiresAt || cursor.offset >= record.value.text.length || ++record.pages > 64) throw new BoundaryError('VIEW_EXPIRED');
        return reader.comparisonSnapshot(request.target, () => page(request, record, cursor.offset), signal);
      }
      const retained = [...records.values()].reduce((sum, value) => sum + value.bytes, 0);
      if (preparing >= 2 || records.size + preparing >= 16 || retained + (preparing + 1) * 1_048_576 > 4_194_304) throw new BoundaryError('QUERY_LIMIT'); preparing++;
      const expiresAt = clock() + 60_000;
      try {
        return await reader.compareManifest(request.target, request.locator, request.format, request.expectedUid, value => {
          if (closed || signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); if (clock() >= expiresAt) throw new BoundaryError('VIEW_EXPIRED');
          const common = { protocol: 2, target: request.target, locator: request.locator, format: request.format };
          if (value.kind === 'missing') return manifestDiffPageSchema.parse({ ...common, kind: 'comparison-missing', reference: value.reference });
          if (value.kind === 'unresolved') return manifestDiffPageSchema.parse({ ...common, kind: 'comparison-unresolved', code: 'RESOURCE_INVALID' });
          const id = randomUUID(), bytes = Buffer.byteLength(value.text); if (bytes > 1_048_576 || bytes < 1) throw new BoundaryError('BUDGET_EXCEEDED');
          const identity = createHmac('sha256', key).update(binding).update(value.uid).update(value.resourceVersion).update(value.text).digest('hex');
          const record = { id, binding, identity, expiresAt, value, bytes, pages: 1 }; records.set(id, record); return page(request, record, 0);
        }, signal);
      } finally { preparing--; }
    },
    close() { closed = true; records.clear(); codec.dispose(); key.fill(0); },
  };
}
