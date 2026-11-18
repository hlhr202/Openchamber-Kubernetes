// User-triggered dependency update: bounded single-shot workspace write inside the chart
// directory, no queueing; a partial update is reported, never silently retried.
import { BoundaryError } from '../../shared/errors.ts';
import { helmDepUpRequestSchema } from '../../shared/helm-depup-protocol.ts';
import { depUpFailureCode } from '../../shared/helm-depup-protocol.ts';
import type { HelmDepUpResponse } from '../../shared/helm-depup-protocol.ts';
import type { HelmDepUpRun } from '../adapters/helm-depup-cli.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
const deadlineMs = 60_000;
export function createHelmDepUpOperations(options: { run: HelmDepUpRun; defaults?: () => HelmRepositorySource }) {
  let running = false, closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<HelmDepUpResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = helmDepUpRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (running) throw new BoundaryError('QUERY_LIMIT'); // one update at a time; never queued
      running = true;
      const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), deadlineMs);
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      try {
        if (!options.defaults) throw new BoundaryError('INVALID_INPUT');
        const content = await options.run({ root: parsed.data.root, path: parsed.data.path, source: options.defaults() }, controller.signal);
        return { protocol: 2, kind: 'helm-dep-updated', root: parsed.data.root, path: parsed.data.path, content };
      } catch (error) {
        return { protocol: 2, kind: 'helm-dep-up-unavailable', code: signal.aborted ? 'QUERY_CANCELLED' : depUpFailureCode(error) };
      } finally { signal.removeEventListener('abort', abort); clearTimeout(deadline); running = false; }
    },
    close() { closed = true; },
  };
}
