// User-triggered dependency listing: bounded single-shot fetch+list, no queueing, no rollback of
// the plugin-isolated cache; the plugin-owned temp directory is always cleaned (upstream finally).
import { BoundaryError } from '../../shared/errors.ts';
import { helmDependenciesRequestSchema, parseDependencyTable, dependenciesFailureCode } from '../../shared/helm-dependencies-protocol.ts';
import type { HelmDependenciesResponse } from '../../shared/helm-dependencies-protocol.ts';
import type { HelmDependenciesRun } from '../adapters/helm-dependencies-cli.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
const deadlineMs = 30_000;
export function createHelmDependenciesOperations(options: { run: HelmDependenciesRun; defaults?: () => HelmRepositorySource }) {
  let running = false, closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<HelmDependenciesResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = helmDependenciesRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (running) throw new BoundaryError('QUERY_LIMIT'); // one listing at a time; never queued
      running = true;
      const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), deadlineMs);
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      try {
        if (!options.defaults) throw new BoundaryError('INVALID_INPUT');
        const stdout = await options.run({ chart: parsed.data.chart, ...(parsed.data.version ? { version: parsed.data.version } : {}), source: options.defaults() }, controller.signal);
        const table = parseDependencyTable(stdout);
        return { protocol: 2, kind: 'helm-dependencies', chart: parsed.data.chart, ...(parsed.data.version ? { version: parsed.data.version } : {}), headers: [...table.headers], rows: table.rows.map(row => [...row]) };
      } catch (error) {
        return { protocol: 2, kind: 'helm-dependencies-unavailable', code: signal.aborted ? 'QUERY_CANCELLED' : dependenciesFailureCode(error) };
      } finally { signal.removeEventListener('abort', abort); clearTimeout(deadline); running = false; }
    },
    close() { closed = true; },
  };
}
