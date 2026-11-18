// User-triggered values preview: bounded single-shot, no queueing, no rollback, no workspace write.
import { BoundaryError } from '../../shared/errors.ts';
import { helmValuesRequestSchema } from '../../shared/helm-values-protocol.ts';
import { valuesFailureCode } from '../../shared/helm-values-protocol.ts';
import type { HelmValuesResponse } from '../../shared/helm-values-protocol.ts';
import type { HelmValuesRun } from '../adapters/helm-values-cli.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
const deadlineMs = 30_000;
export function createHelmValuesOperations(options: { run: HelmValuesRun; defaults?: () => HelmRepositorySource }) {
  let running = false, closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<HelmValuesResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = helmValuesRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (running) throw new BoundaryError('QUERY_LIMIT'); // one preview at a time; never queued
      running = true;
      const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), deadlineMs);
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      try {
        if (!options.defaults) throw new BoundaryError('INVALID_INPUT');
        const content = await options.run({ chart: parsed.data.chart, ...(parsed.data.version ? { version: parsed.data.version } : {}), source: options.defaults() }, controller.signal);
        return { protocol: 2, kind: 'helm-values-fetched', chart: parsed.data.chart, ...(parsed.data.version ? { version: parsed.data.version } : {}), content };
      } catch (error) {
        return { protocol: 2, kind: 'helm-values-fetch-unavailable', code: signal.aborted ? 'QUERY_CANCELLED' : valuesFailureCode(error) };
      } finally { signal.removeEventListener('abort', abort); clearTimeout(deadline); running = false; }
    },
    close() { closed = true; },
  };
}
