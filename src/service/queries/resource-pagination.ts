import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName, containsControlCharacters } from '../../shared/identity.ts';
import { planResourceList } from './resource-query.ts';
import type { createResourceReader } from './resource-reader.ts';
import { createSealedCursor } from './sealed-cursor.ts';

const cursorSchema = z.object({ format: z.literal(1), binding: z.string().regex(/^[a-f0-9]{64}$/),
  continuation: z.string().min(1).max(8192).refine(value => !containsControlCharacters(value)), resourceVersion: boundedName,
  expiresAt: z.number().int().nonnegative(), pages: z.number().int().min(1).max(1000) }).strict();
type Cursor = z.infer<typeof cursorSchema>;
const requestSchema = z.object({ query: z.unknown(), cursor: z.string().min(1).max(17_000).optional(), binding: z.string().max(64).optional() }).strict();

// In-memory, per-pager AES-GCM key: no upstream continuation, raw content hash or credential
// is disclosed/persisted in a public cursor. It is a READ capability, not a host owner lease.
export function createResourcePager(reader: Pick<ReturnType<typeof createResourceReader>, 'list'>, clock = Date.now) {
  const codec = createSealedCursor('rp1', 'openchamber-kubernetes-resource-page-1');
  let disposed = false;
  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new BoundaryError('STATE_UNAVAILABLE');
    return value;
  }
  function seal(value: Cursor): string {
    const parsed = cursorSchema.safeParse(value);
    if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
    return codec.seal(parsed.data);
  }
  function open(token: string, binding: string): Cursor {
    try {
      const value = cursorSchema.parse(codec.open(token));
      if (value.binding !== binding) throw new Error('binding');
      if (now() >= value.expiresAt) throw new BoundaryError('CONTINUATION_EXPIRED');
      return value;
    } catch (error) {
      if (error instanceof BoundaryError) throw error;
      throw new BoundaryError('STALE_TARGET'); // No ciphertext/parser/authenticator detail escapes.
    }
  }
  return {
    async read(input: unknown, signal?: AbortSignal) {
      if (disposed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const query = parsed.data.query;
      if (typeof query !== 'object' || query === null || Object.hasOwn(query, 'continue') || Object.hasOwn(query, 'resourceVersion')) throw new BoundaryError('INVALID_INPUT');
      const plan = planResourceList(query);
      if (plan.kind === 'empty' && parsed.data.cursor) throw new BoundaryError('INVALID_INPUT');
      const binding = createHash('sha256').update(JSON.stringify([plan.kind === 'list' ? plan.key : plan.request, parsed.data.binding ?? ''])).digest('hex');
      const previous = parsed.data.cursor ? open(parsed.data.cursor, binding) : undefined;
      if (previous && previous.pages >= 1000) throw new BoundaryError('QUERY_LIMIT');
      const expiresAt = previous?.expiresAt ?? now() + 60_000;
      const result = await reader.list({ ...plan.request,
          ...(previous ? { continue: previous.continuation, resourceVersion: previous.resourceVersion } : {}) }, signal, parsed.data.binding !== undefined);
      if (disposed) throw new BoundaryError('SERVICE_CLOSED');
      if (signal?.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (now() >= expiresAt) throw new BoundaryError('CONTINUATION_EXPIRED');
      if (result.kind === 'empty-selector') return result;
      const { continue: continuation, ...page } = result.page;
      const nextCursor = continuation ? seal({ format: 1, binding, continuation, resourceVersion: page.resourceVersion, expiresAt, pages: (previous?.pages ?? 0) + 1 }) : null;
      const response = { kind: 'resources' as const, ...page, nextCursor, expiresAt }; // Internal: branch post-check must respect the original page deadline too.
      if (Buffer.byteLength(JSON.stringify(response)) > 480_000) throw new BoundaryError('BUDGET_EXCEEDED');
      return Object.freeze(response);
    },
    dispose() { disposed = true; codec.dispose(); }, // Does not terminate another user's/shared reader.
  };
}
