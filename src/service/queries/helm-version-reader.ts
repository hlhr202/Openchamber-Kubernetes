// READ-ONLY Helm version query with the original finite scheduler shape; no cache, no cluster, no writes.
import { BoundaryError } from '../../shared/errors.ts';
import { helmVersionRequestSchema } from '../../shared/helm-version-protocol.ts';
import type { HelmVersionResponse } from '../../shared/helm-version-protocol.ts';
import { ReadScheduler } from './read-scheduler.ts';
export function createHelmVersionReader(run: (signal: AbortSignal) => Promise<{ syntax: 'v2' | 'v3' | 'v4' | 'unknown'; output: string }>) {
  const scheduler = new ReadScheduler<HelmVersionResponse>({ concurrency: 2, queued: 8, consumers: 32, timeoutMs: 7000 });
  let closed = false;
  return {
    async read(input: unknown, signal: AbortSignal): Promise<HelmVersionResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = helmVersionRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      const result = await scheduler.run(['helm-version'], async sharedSignal => {
        try { const value = await run(sharedSignal); return Object.freeze({ protocol: 2 as const, kind: 'helm-version' as const, syntax: value.syntax, output: value.output }); }
        catch (error) {
          const code = error instanceof BoundaryError && ['CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'BUDGET_EXCEEDED', 'QUERY_CANCELLED', 'STATE_UNAVAILABLE'].includes(error.code) ? error.code : 'STATE_UNAVAILABLE';
          return Object.freeze({ protocol: 2 as const, kind: 'helm-version-unavailable' as const, syntax: 'unknown' as const, code });
        }
      }, { signal });
      return result;
    },
    close() { closed = true; scheduler.close(); },
  };
}
