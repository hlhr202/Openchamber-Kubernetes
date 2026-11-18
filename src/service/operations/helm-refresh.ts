// User-triggered Helm repo refresh: bounded, single-shot, no queueing, no rollback. Never auto-invoked.
import { BoundaryError } from '../../shared/errors.ts';
import { helmRefreshRequestSchema } from '../../shared/helm-refresh-protocol.ts';
import { refreshFailureCode } from '../../shared/helm-refresh-protocol.ts';
import type { HelmRefreshResponse } from '../../shared/helm-refresh-protocol.ts';
import type { HelmRefreshRun } from '../adapters/helm-repo-refresh-cli.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
export function createHelmRefreshOperations(options: { run: HelmRefreshRun; defaults?: () => HelmRepositorySource }) {
  let running = false, closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<HelmRefreshResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = helmRefreshRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (running) throw new BoundaryError('QUERY_LIMIT'); // one refresh at a time; never queued, never repeated
      running = true;
      try {
        if (!options.defaults) throw new BoundaryError('INVALID_INPUT');
        const source = options.defaults(); // the same resolved read-only repository file the reader uses
        await options.run(source, signal);
        return { protocol: 2, kind: 'helm-repo-refreshed' };
      } catch (error) {
        return { protocol: 2, kind: 'helm-repo-refresh-unavailable', code: refreshFailureCode(error) };
      } finally { running = false; }
    },
    close() { closed = true; },
  };
}
