import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { logBytes, logChunkCharacters, podLogPageSchema, podLogRequestSchema } from '../../shared/pod-log-protocol.ts';
import type { PodLogPage, PodLogResponse } from '../../shared/pod-log-protocol.ts';
import { createSealedCursor } from './sealed-cursor.ts';
import type { createResourceReader } from './resource-reader.ts';

type Snapshot = { readonly id: string; readonly binding: string; readonly runtime: string; readonly text: string; readonly bytes: number; readonly expiresAt: number; readonly timer: ReturnType<typeof setTimeout> };
const cursorSchema = z.object({ id: z.string().uuid(), binding: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(1).max(logBytes), expiresAt: z.number().int().nonnegative() }).strict();
// Finite read snapshots, not live subscriptions, PTYs, or a host-authenticated owner/lease service.
export function createPodLogReader(reader: Pick<ReturnType<typeof createResourceReader>, 'logContainers' | 'logRuntime' | 'podLogs'>, clock = Date.now) {
  const codec = createSealedCursor('pl1', 'openchamber-kubernetes-pod-log-1'), snapshots = new Map<string, Snapshot>();
  let pending = 0, closed = false;
  function now() { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) throw new BoundaryError('STATE_UNAVAILABLE'); return value; }
  function remove(id: string) { const item = snapshots.get(id); if (item) clearTimeout(item.timer); snapshots.delete(id); }
  function expire() { for (const [id, item] of snapshots) if (item.expiresAt <= now()) remove(id); }
  function current(signal: AbortSignal, expiresAt?: number) {
    if (closed) throw new BoundaryError('SERVICE_CLOSED');
    if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
    if (expiresAt !== undefined && now() >= expiresAt) throw new BoundaryError('CONTINUATION_EXPIRED');
  }
  return {
    async read(input: unknown, signal: AbortSignal): Promise<PodLogResponse> {
      current(signal); expire();
      const parsed = podLogRequestSchema.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const request = parsed.data;
      if (request.kind === 'containers') {
        const containers = await reader.logContainers(request.target, request.reference, signal, request.origin); current(signal);
        return { protocol: 2, kind: 'log-containers', target: request.target, reference: request.reference, ...(request.origin ? { origin: request.origin } : {}), containers };
      }
      const { cursor: _cursor, selection: _selection, ...identity } = request;
      const binding = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      let item: Snapshot, offset = 0;
      if (request.cursor) {
        const parsed = cursorSchema.safeParse(codec.open(request.cursor));
        if (!parsed.success || parsed.data.binding !== binding) throw new BoundaryError('STALE_TARGET');
        current(signal, parsed.data.expiresAt);
        const stored = snapshots.get(parsed.data.id);
        if (!stored || stored.binding !== binding || stored.expiresAt !== parsed.data.expiresAt) throw new BoundaryError('CONTINUATION_EXPIRED');
        item = stored; offset = parsed.data.offset;
        // Continuations never re-read/mix changing log text. Recheck the original Pod before delivery.
        if (await reader.logRuntime(request.target, request.reference, request.container, signal, request.origin) !== item.runtime) throw new BoundaryError('STALE_TARGET');
      } else {
        const used = [...snapshots.values()].reduce((sum, value) => sum + value.bytes, 0);
        if (snapshots.size + pending >= 8 || used + (pending + 1) * logBytes > 4 * logBytes) throw new BoundaryError('QUERY_LIMIT');
        pending++;
        try {
          const expiresAt = now() + 60_000;
          const { text, runtime } = await reader.podLogs(request.target, request.reference, request.container, request.options, signal, request.origin);
          current(signal, expiresAt);
          const id = randomUUID(), bytes = Buffer.byteLength(text);
          if (bytes > logBytes) throw new BoundaryError('BUDGET_EXCEEDED');
          const timer = setTimeout(() => remove(id), Math.max(0, expiresAt - now())); timer.unref();
          item = { id, binding, runtime, text, bytes, expiresAt, timer }; snapshots.set(id, item);
        } finally { pending--; }
      }
      current(signal, item.expiresAt);
      if (offset >= item.text.length && offset !== 0) throw new BoundaryError('STALE_TARGET');
      const next = item.text.charCodeAt(offset);
      if (next >= 0xDC00 && next <= 0xDFFF) throw new BoundaryError('STALE_TARGET');
      let end = Math.min(item.text.length, offset + logChunkCharacters);
      const last = item.text.charCodeAt(end - 1);
      if (end < item.text.length && last >= 0xD800 && last <= 0xDBFF) end--;
      const page: PodLogPage = { protocol: 2, kind: 'pod-log', target: request.target, reference: request.reference, container: request.container, options: request.options,
        ...(request.origin ? { origin: request.origin } : {}),
        snapshotId: item.id, totalBytes: item.bytes, totalCharacters: item.text.length, offset, end, text: item.text.slice(offset, end),
        nextCursor: end < item.text.length ? codec.seal({ id: item.id, binding, offset: end, expiresAt: item.expiresAt }) : null };
      return podLogPageSchema.parse(page);
    },
    dispose() { closed = true; for (const id of snapshots.keys()) remove(id); codec.dispose(); },
    get state() { expire(); return Object.freeze({ snapshots: snapshots.size, bytes: [...snapshots.values()].reduce((sum, item) => sum + item.bytes, 0), pending }); },
  };
}
