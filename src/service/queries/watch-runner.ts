import { setTimeout as delay } from 'node:timers/promises';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import type { WatchEvent, WatchSource } from '../../shared/watch-protocol.ts';
import type { ResourceReadRequest } from './resource-reader.ts';
import { createWatchDecoder, planResourceWatch } from './watch-source.ts';

export type WatchTransport = (selection: ConfigSelection, request: ResourceReadRequest, signal: AbortSignal, emit: (bytes: Uint8Array) => Promise<void>) => Promise<void>;
export async function runResourceWatch(source: WatchSource, signal: AbortSignal, emit: (event: Omit<WatchEvent, 'sequence'>) => void,
  options: { transport: WatchTransport; verify: (source: WatchSource, signal: AbortSignal) => Promise<void>;
    relist?: (source: WatchSource, signal: AbortSignal, budget: { bytes: number; reads: number }) => Promise<string>;
    clock?: () => number; pause?: (signal: AbortSignal) => Promise<void> }) {
  let resourceVersion = source.resourceVersion, events = 0, recovered = false; const budget = { bytes: 0, reads: 0 };
  const publish = (event: Omit<WatchEvent, 'sequence'>) => { if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); if (++events > 4096) throw new BoundaryError('BUDGET_EXCEEDED'); emit(event); };
  const pause = async () => { try { if (options.pause) await options.pause(signal); else await delay(250, undefined, { signal }); } catch { throw new BoundaryError('QUERY_CANCELLED'); } if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); };
  // Exactly one expired-history recovery; never retry authentication, network errors or an expired relist.
  for (let window = 0; window < 10; window++) {
    if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
    await options.verify(source, signal);
    const decoder = createWatchDecoder(source, event => { resourceVersion = event.resourceVersion; publish(event); });
    const clock = options.clock ?? Date.now, started = clock();
    try {
    budget.reads++;
    await options.transport(source.selection, planResourceWatch({ ...source, resourceVersion }), signal, async chunk => {
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if ((budget.bytes += chunk.byteLength) > 8_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
      await options.verify(source, signal); decoder.push(chunk);
    });
    if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
    await options.verify(source, signal); decoder.finish();
    } catch (error) {
      if (!(error instanceof BoundaryError) || error.code !== 'CONTINUATION_EXPIRED' || recovered || !options.relist || window === 9) throw error;
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      await options.verify(source, signal); recovered = true; publish({ type: 'RELISTING', resourceVersion });
      await pause(); await options.verify(source, signal);
      const next = await options.relist(source, signal, budget);
      if (!boundedName.safeParse(next).success || next === '0') throw new BoundaryError('RESOURCE_INVALID');
      if (budget.bytes > 8_000_000 || budget.reads > 30) throw new BoundaryError('BUDGET_EXCEEDED');
      await options.verify(source, signal); resourceVersion = next; publish({ type: 'RESYNC', resourceVersion }); continue;
    }
    if (clock() - started < 1000) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE'); // Fast EOF is not a successful timeout loop.
    if (window < 9) await pause();
  }
}
