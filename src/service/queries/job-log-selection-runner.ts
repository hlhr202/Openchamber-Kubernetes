import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';
import type { JobLogSelectionSource, JobLogSelected } from '../../shared/job-log-selection-protocol.ts';
import type { PodLogReference, JobLogOrigin } from '../../shared/pod-log-protocol.ts';
import { compareJobLogCandidates, planJobPodWatch } from './job-log-selection-source.ts';
import type { JobLogCandidate } from './job-log-selection-source.ts';
import { createWatchFrameDecoder } from './watch-source.ts';
import { requireReadSuccess } from './resource-query.ts';
import type { WatchTransport } from './watch-runner.ts';

export async function runJobLogSelection(source: JobLogSelectionSource, signal: AbortSignal, emit: (value: Omit<JobLogSelected, 'sequence'>) => void, options: {
  list: (previous?: { resourceVersion: string; continuation: string; selector: string }) => Promise<{ selector: string; resourceVersion: string; continuation: string | null; candidates: JobLogCandidate[] }>;
  verify: (selector: string, reference?: PodLogReference, raw?: unknown) => Promise<PodLogReference | undefined>;
  transport?: WatchTransport; origin?: () => JobLogOrigin; charge: (bytes: number) => void; clock?: () => number; pause?: (signal: AbortSignal) => Promise<void>;
}) {
  let best: JobLogCandidate | undefined, count = 0, selector = '', resourceVersion = '', previous: { resourceVersion: string; continuation: string; selector: string } | undefined;
  const uids = new Set<string>(), names = new Set<string>(), cursors = new Set<string>(); const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const current = () => { if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); };
  for (let page = 0; page < 20; page++) {
    current(); const result = await options.list(previous); current();
    if (previous && (result.resourceVersion !== previous.resourceVersion || result.selector !== previous.selector)) throw new BoundaryError('STALE_TARGET');
    selector = result.selector; resourceVersion = result.resourceVersion;
    for (const value of result.candidates) { const uid = hash(value.reference.uid), name = hash(value.reference.name);
      if (uids.has(uid) || names.has(name) || ++count > 2000) throw new BoundaryError('RESOURCE_INVALID'); uids.add(uid); names.add(name);
      if (!best || compareJobLogCandidates(value, best) < 0) best = value;
    }
    if (!result.continuation) break;
    if (page === 19 || cursors.has(result.continuation)) throw new BoundaryError('QUERY_LIMIT'); cursors.add(result.continuation);
    previous = { resourceVersion, continuation: result.continuation, selector };
  }
  if (best) { const reference = await options.verify(selector, best.reference); current(); if (!reference) throw new BoundaryError('STALE_TARGET'); emit({ origin: options.origin?.() ?? source.origin, reference, candidates: count, waited: false }); return; }
  // An empty complete snapshot is not success: wait on its RV+selector, not periodic relists or Pod creation.
  if (!options.transport) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE'); let frames = 0;
  for (let window = 0; window < 10; window++) {
    current(); await options.verify(selector); current(); const child = new AbortController(), abort = () => child.abort(signal.reason); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); let raw: unknown, candidate: PodLogReference | undefined; const clock = options.clock ?? Date.now, started = clock();
    const decoder = createWatchFrameDecoder(input => {
      if (raw !== undefined) return; if (++frames > 4096) throw new BoundaryError('BUDGET_EXCEEDED');
      const parsed = z.object({ type: z.enum(['ADDED', 'MODIFIED', 'DELETED', 'BOOKMARK', 'ERROR']), object: z.unknown() }).safeParse(input);
      if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID'); const value = parsed.data;
      if (value.type === 'ERROR') { const status = z.object({ kind: z.literal('Status'), code: z.number().int() }).safeParse(value.object); if (!status.success) throw new BoundaryError('RESOURCE_INVALID'); requireReadSuccess(status.data.code); throw new BoundaryError('RESOURCE_INVALID'); }
      if (value.type !== 'BOOKMARK' && !z.object({ apiVersion: z.literal('v1'), kind: z.literal('Pod'), metadata: z.object({ namespace: z.literal(source.origin.namespace) }) }).safeParse(value.object).success) throw new BoundaryError('RESOURCE_INVALID');
      const meta = z.object({ metadata: z.object({ resourceVersion: boundedName }) }).safeParse(value.object); if (!meta.success) throw new BoundaryError('RESOURCE_INVALID'); resourceVersion = meta.data.metadata.resourceVersion;
      if (value.type === 'ADDED' || value.type === 'MODIFIED') raw = value.object;
    });
    try {
      await options.transport(source.selection, planJobPodWatch(source, selector, resourceVersion), child.signal, async bytes => {
        current(); options.charge(bytes.byteLength); if (candidate) return; await options.verify(selector); decoder.push(bytes);
        if (raw !== undefined) { candidate = await options.verify(selector, undefined, raw); current(); if (!candidate) throw new BoundaryError('STALE_TARGET'); child.abort(new BoundaryError('QUERY_CANCELLED')); }
      });
    } catch (error) { if (!candidate || signal.aborted || !(error instanceof BoundaryError) || error.code !== 'QUERY_CANCELLED' || !child.signal.aborted) throw error; }
    finally { signal.removeEventListener('abort', abort); }
    current();
    if (candidate) { const reference = await options.verify(selector, candidate); current(); if (!reference) throw new BoundaryError('STALE_TARGET'); emit({ origin: options.origin?.() ?? source.origin, reference, candidates: 1, waited: true }); return; }
    decoder.finish(); await options.verify(selector); current(); if (clock() - started < 1000) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
    if (window < 9) { try { if (options.pause) await options.pause(signal); else await delay(250, undefined, { signal }); } catch { throw new BoundaryError('QUERY_CANCELLED'); } }
  }
  throw new BoundaryError('QUERY_TIMEOUT');
}
