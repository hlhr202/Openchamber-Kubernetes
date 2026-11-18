import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { documentBytes, documentChunkCharacters, documentPageSchema, documentRequestSchema } from '../../shared/document-protocol.ts';
import type { DocumentPage } from '../../shared/document-protocol.ts';
import type { createResourceReader } from './resource-reader.ts';
import { createSealedCursor } from './sealed-cursor.ts';

const cursorSchema = z.object({ binding: z.string().regex(/^[a-f0-9]{64}$/), identity: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(1).max(documentBytes), expiresAt: z.number().int().nonnegative() }).strict();
export function createDocumentReader(reader: Pick<ReturnType<typeof createResourceReader>, 'document'>, clock = Date.now) {
  const codec = createSealedCursor('doc1', 'openchamber-kubernetes-document-1'), identityKey = randomBytes(32); let closed = false;
  function now() { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) throw new BoundaryError('STATE_UNAVAILABLE'); return value; }
  return {
    async read(input: unknown, signal: AbortSignal): Promise<DocumentPage> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = documentRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const { cursor, ...request } = parsed.data, binding = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      let previous: z.infer<typeof cursorSchema> | undefined;
      if (cursor) { const value = cursorSchema.safeParse(codec.open(cursor)); if (!value.success || value.data.binding !== binding) throw new BoundaryError('STALE_TARGET'); previous = value.data; }
      if (previous && now() >= previous.expiresAt) throw new BoundaryError('CONTINUATION_EXPIRED');
      const expiresAt = previous?.expiresAt ?? now() + 60_000;
      const page = await reader.document(request.target, request.reference, request.format, value => {
        const identity = createHmac('sha256', identityKey).update(binding).update(value.text).digest('hex'), offset = previous?.offset ?? 0;
        if (previous && (identity !== previous.identity || offset >= value.text.length)) throw new BoundaryError('STALE_TARGET');
        let end = Math.min(value.text.length, offset + documentChunkCharacters);
        if (end < value.text.length && value.text.charCodeAt(end - 1) >= 0xD800 && value.text.charCodeAt(end - 1) <= 0xDBFF) end--;
        return documentPageSchema.parse({ protocol: 2, kind: 'resource-document', target: request.target, reference: request.reference, format: request.format,
          contentIdentity: identity, totalBytes: value.bytes, totalCharacters: value.text.length, offset, end, text: value.text.slice(offset, end),
          nextCursor: end < value.text.length ? codec.seal({ binding, identity, offset: end, expiresAt }) : null });
      }, signal);
      if (closed) throw new BoundaryError('SERVICE_CLOSED'); if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (now() >= expiresAt) throw new BoundaryError('CONTINUATION_EXPIRED'); return page;
    },
    dispose() { closed = true; codec.dispose(); identityKey.fill(0); },
  };
}
