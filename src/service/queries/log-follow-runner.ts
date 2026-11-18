import { BoundaryError } from '../../shared/errors.ts';
import type { LogFollowSource, LogFollowEvent } from '../../shared/log-follow-protocol.ts';
import type { WatchTransport } from './watch-runner.ts';
import { createLogFollowDecoder, planLogFollow } from './log-follow-source.ts';
import { setTimeout as delay } from 'node:timers/promises';

export async function runLogFollow(source: LogFollowSource, signal: AbortSignal, emit: (event: Omit<LogFollowEvent, 'sequence'>) => void,
  options: { transport: WatchTransport; verify: (initial: boolean, signal: AbortSignal) => Promise<string>; wait?: (signal: AbortSignal) => Promise<void> }) {
  const proof = await options.verify(true, signal), local = new AbortController(), readSignal = AbortSignal.any([signal, local.signal]);
  let failure: BoundaryError | undefined, checks = 0, check: Promise<void> | undefined;
  const verify = () => check ??= (async () => { if (++checks > 256) throw new BoundaryError('BUDGET_EXCEEDED'); if (await options.verify(false, readSignal) !== proof) throw new BoundaryError('STALE_TARGET'); })().finally(() => { check = undefined; });
  const decoder = createLogFollowDecoder(emit);
  const monitor = (async () => {
    try { while (!readSignal.aborted) { if (options.wait) await options.wait(readSignal); else await delay(1000, undefined, { signal: readSignal }); if (!readSignal.aborted) await verify(); } }
    catch (error) { if (!readSignal.aborted) { failure = error instanceof BoundaryError ? error : new BoundaryError('STATE_UNAVAILABLE'); local.abort(failure); } }
  })();
  try {
    await options.transport(source.selection, planLogFollow(source), readSignal, async chunk => {
      if (readSignal.aborted) throw failure ?? new BoundaryError('QUERY_CANCELLED');
      await verify(); if (readSignal.aborted) throw failure ?? new BoundaryError('QUERY_CANCELLED'); decoder.push(chunk);
    });
    if (readSignal.aborted) throw failure ?? new BoundaryError('QUERY_CANCELLED');
    await verify(); decoder.finish();
  } catch (error) { throw failure ?? error; }
  finally { local.abort(); await monitor; await check?.catch(() => {}); }
  // One stream only. No reconnect/since replay: the logs API has no exactly-once resume cursor.
}
