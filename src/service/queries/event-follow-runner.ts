import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BoundaryError } from '../../shared/errors.ts';
import type { EventFollowSource, EventFollowDelta } from '../../shared/event-follow-protocol.ts';
import { eventMaximumPages, eventPageLimit } from '../../shared/event-protocol.ts';
import { boundedName } from '../../shared/identity.ts';
import type { EventSourcePage } from './event-source.ts';
import { createWatchFrameDecoder } from './watch-source.ts';
import { planEventFollow, projectEventFollowDelta } from './event-follow-source.ts';
import type { WatchTransport } from './watch-runner.ts';

export async function runEventFollow(source: EventFollowSource, signal: AbortSignal, emit: (event: Omit<EventFollowDelta, 'sequence'>) => void, options: {
  transport: WatchTransport; verify: (initial: boolean) => Promise<void>; list: (previous?: { resourceVersion: string; continuation: string }) => Promise<EventSourcePage>;
  charge: (bytes: number) => void; clock?: () => number; pause?: (signal: AbortSignal) => Promise<void>;
}) {
  if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); await options.verify(true);
  let resourceVersion = '', events = 0, recovered = false;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const publish = (event: Omit<EventFollowDelta, 'sequence'>) => { if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); if (++events > 4096) throw new BoundaryError('BUDGET_EXCEEDED'); emit(event); };
  const pause = async () => { try { if (options.pause) await options.pause(signal); else await delay(250, undefined, { signal }); } catch { throw new BoundaryError('QUERY_CANCELLED'); } if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); };
  // Every snapshot starts with fresh continuation/dedup state; never continue an expired snapshot or mix API versions.
  const snapshot = async () => {
    const seenUids = new Set<string>(), seenNames = new Set<string>(), cursors = new Set<string>(); let previous: { resourceVersion: string; continuation: string } | undefined;
    for (let page = 0; page < eventMaximumPages; page++) {
    if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); await options.verify(false);
    const result = await options.list(previous); await options.verify(false);
    if (result.apiVersion !== source.apiVersion || result.namespace.name !== source.namespace.name || result.namespace.uid !== source.namespace.uid
      || previous && result.resourceVersion !== previous.resourceVersion) throw new BoundaryError('STALE_TARGET');
    if (!boundedName.safeParse(result.resourceVersion).success || result.resourceVersion === '0' || result.rows.length > eventPageLimit) throw new BoundaryError('RESOURCE_INVALID');
    resourceVersion = result.resourceVersion;
    for (const row of result.rows) {
      if (row.namespace !== source.namespace.name) throw new BoundaryError('STALE_TARGET');
      const uid = hash(row.uid), name = hash(row.name); if (seenUids.has(uid) || seenNames.has(name)) throw new BoundaryError('RESOURCE_INVALID'); seenUids.add(uid); seenNames.add(name);
      publish({ type: 'SEED', resourceVersion: row.resourceVersion, row });
    }
    if (!result.continuation) { publish({ type: 'RESYNC', resourceVersion }); return; }
    if (page + 1 === eventMaximumPages || cursors.has(result.continuation)) throw new BoundaryError('QUERY_LIMIT'); cursors.add(result.continuation);
    previous = { resourceVersion, continuation: result.continuation };
    }
  };
  await snapshot();
  for (let window = 0; window < 10; window++) {
    if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); await options.verify(false); const clock = options.clock ?? Date.now, started = clock();
    const decoder = createWatchFrameDecoder(value => { const event = projectEventFollowDelta(value, source.namespace.name, source.apiVersion); resourceVersion = event.resourceVersion; publish(event); });
    let verificationFailed = false;
    try {
      // Transport settles only after its old worker closes. Namespace/config/charge errors are never stream expiry retries.
      await options.transport(source.selection, planEventFollow(source, resourceVersion), signal, async chunk => {
        try { if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); options.charge(chunk.byteLength); await options.verify(false); }
        catch (error) { verificationFailed = true; throw error; }
        decoder.push(chunk);
      });
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); decoder.finish();
    } catch (error) {
      if (!(error instanceof BoundaryError) || error.code !== 'CONTINUATION_EXPIRED' || verificationFailed || recovered || window === 9) throw error;
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); await options.verify(false); recovered = true;
      publish({ type: 'RELISTING', resourceVersion }); await pause(); await options.verify(false);
      await snapshot(); continue; // One complete relist at the same Namespace/API; no fallback or reset of task budgets/deadlines.
    }
    await options.verify(false);
    if (clock() - started < 1000) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
    if (window < 9) await pause();
  }
}
