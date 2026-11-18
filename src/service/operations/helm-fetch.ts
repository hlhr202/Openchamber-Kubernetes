// User-triggered chart fetch: bounded single-shot workspace write (untar into the designated
// destination), no queueing, never repeated; a partial result is reported, never silently retried.
import { BoundaryError } from '../../shared/errors.ts';
import { helmFetchRequestSchema } from '../../shared/helm-fetch-protocol.ts';
import { fetchFailureCode } from '../../shared/helm-fetch-protocol.ts';
import type { HelmFetchResponse } from '../../shared/helm-fetch-protocol.ts';
import type { HelmFetchRun } from '../adapters/helm-fetch-cli.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
const deadlineMs = 60_000;
export function createHelmFetchOperations(options: { run: HelmFetchRun; defaults?: () => HelmRepositorySource }) {
  let running = false, closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<HelmFetchResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = helmFetchRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (running) throw new BoundaryError('QUERY_LIMIT'); // one fetch at a time; never queued
      running = true;
      const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), deadlineMs);
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      try {
        if (!options.defaults) throw new BoundaryError('INVALID_INPUT');
        const content = await options.run({ chart: parsed.data.chart, ...(parsed.data.version ? { version: parsed.data.version } : {}), root: parsed.data.root, path: parsed.data.path, source: options.defaults() }, controller.signal);
        return { protocol: 2, kind: 'helm-fetched', chart: parsed.data.chart, ...(parsed.data.version ? { version: parsed.data.version } : {}), root: parsed.data.root, path: parsed.data.path, content };
      } catch (error) {
        return { protocol: 2, kind: 'helm-fetch-unavailable', code: signal.aborted ? 'QUERY_CANCELLED' : fetchFailureCode(error) };
      } finally { signal.removeEventListener('abort', abort); clearTimeout(deadline); running = false; }
    },
    close() { closed = true; },
  };
}
