// User-triggered chart packaging: bounded single-shot workspace write, no queueing, no rollback of
// the plugin-isolated cache; a partially written archive is reported, never silently retried.
import { BoundaryError } from '../../shared/errors.ts';
import { helmPackageRequestSchema } from '../../shared/helm-package-protocol.ts';
import { packageFailureCode } from '../../shared/helm-package-protocol.ts';
import type { HelmPackageResponse } from '../../shared/helm-package-protocol.ts';
import type { HelmPackageRun } from '../adapters/helm-package-cli.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
const deadlineMs = 30_000;
export function createHelmPackageOperations(options: { run: HelmPackageRun; defaults?: () => HelmRepositorySource }) {
  let running = false, closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<HelmPackageResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = helmPackageRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (running) throw new BoundaryError('QUERY_LIMIT'); // one packaging at a time; never queued
      running = true;
      const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), deadlineMs);
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      try {
        if (!options.defaults) throw new BoundaryError('INVALID_INPUT');
        const content = await options.run({ root: parsed.data.root, path: parsed.data.path, destinationRoot: parsed.data.destinationRoot, destinationPath: parsed.data.destinationPath, source: options.defaults() }, controller.signal);
        return { protocol: 2, kind: 'helm-packaged', root: parsed.data.root, path: parsed.data.path, destinationRoot: parsed.data.destinationRoot, destinationPath: parsed.data.destinationPath, content };
      } catch (error) {
        return { protocol: 2, kind: 'helm-package-unavailable', code: signal.aborted ? 'QUERY_CANCELLED' : packageFailureCode(error) };
      } finally { signal.removeEventListener('abort', abort); clearTimeout(deadline); running = false; }
    },
    close() { closed = true; },
  };
}
