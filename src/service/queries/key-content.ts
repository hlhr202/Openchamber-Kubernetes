import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { keyContentChunkCharacters, keyContentRequestSchema, keyContentResponseSchema, keyReferenceId } from '../../shared/key-content-protocol.ts';
import type { KeyContentResponse } from '../../shared/key-content-protocol.ts';
import { protocolVersion } from '../../shared/protocol.ts';
import { createSealedCursor } from './sealed-cursor.ts';
import type { createResourceReader } from './resource-reader.ts';

const pageSchema = z.object({ binding: z.string().regex(/^[a-f0-9]{64}$/), identity: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(1).max(1_398_104),
  expiresAt: z.number().int().nonnegative(), pages: z.number().int().min(1).max(32) }).strict();
export function createKeyContentReader(reader: Pick<ReturnType<typeof createResourceReader>, 'keyContent'>, clock = Date.now) {
  const codec = createSealedCursor('kc1', 'openchamber-kubernetes-key-content-1'), identityKey = randomBytes(32);
  let closed = false;
  function now() { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) throw new BoundaryError('STATE_UNAVAILABLE'); return value; }
  return {
    async read(input: unknown, signal: AbortSignal): Promise<KeyContentResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = keyContentRequestSchema.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const request = parsed.data;
      const binding = createHash('sha256').update(JSON.stringify([request.target, keyReferenceId(request.reference)])).digest('hex');
      let previous: z.infer<typeof pageSchema> | undefined;
      if (request.cursor) {
        const parsed = pageSchema.safeParse(codec.open(request.cursor));
        if (!parsed.success || parsed.data.binding !== binding) throw new BoundaryError('STALE_TARGET');
        previous = parsed.data;
        if (now() >= previous.expiresAt) throw new BoundaryError('CONTINUATION_EXPIRED');
        if (previous.pages >= 32) throw new BoundaryError('QUERY_LIMIT');
      }
      const expiresAt = previous?.expiresAt ?? now() + 60_000;
      const page = await reader.keyContent({ target: request.target, reference: request.reference }, value => {
        const identity = createHmac('sha256', identityKey).update(JSON.stringify([binding, value.encoding, value.totalBytes, value.text])).digest('hex');
        if (previous && previous.identity !== identity) throw new BoundaryError('STALE_TARGET');
        const offset = previous?.offset ?? 0;
        const next = value.text.charCodeAt(offset);
        if (offset > value.text.length || (offset > 0 && (offset === value.text.length || (next >= 0xDC00 && next <= 0xDFFF)))) throw new BoundaryError('STALE_TARGET');
        let end = Math.min(value.text.length, offset + keyContentChunkCharacters);
        const last = value.text.charCodeAt(end - 1);
        if (end < value.text.length && last >= 0xD800 && last <= 0xDBFF) end--;
        return keyContentResponseSchema.parse({ protocol: protocolVersion, kind: 'key-content', target: request.target, reference: request.reference,
          encoding: value.encoding, totalBytes: value.totalBytes, totalCharacters: value.text.length, offset, end, text: value.text.slice(offset, end), contentIdentity: identity,
          nextCursor: end < value.text.length ? codec.seal({ binding, identity, offset: end, expiresAt, pages: (previous?.pages ?? 0) + 1 }) : null });
      }, signal);
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (now() >= expiresAt) throw new BoundaryError('CONTINUATION_EXPIRED');
      return page;
    },
    dispose() { closed = true; codec.dispose(); identityKey.fill(0); },
  };
}
