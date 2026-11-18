// User-triggered chart lint: bounded single-shot, no queueing, findings are a determinate result.
import { BoundaryError } from '../../shared/errors.ts';
import { helmLintRequestSchema } from '../../shared/helm-lint-protocol.ts';
import { lintFailureCode } from '../../shared/helm-lint-protocol.ts';
import type { HelmLintResponse } from '../../shared/helm-lint-protocol.ts';
import type { HelmLintRun } from '../adapters/helm-lint-cli.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
const deadlineMs = 30_000;
export function createHelmLintOperations(options: { run: HelmLintRun; defaults?: () => HelmRepositorySource }) {
  let running = false, closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<HelmLintResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = helmLintRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (running) throw new BoundaryError('QUERY_LIMIT'); // one lint at a time; never queued
      running = true;
      const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), deadlineMs);
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      try {
        if (!options.defaults) throw new BoundaryError('INVALID_INPUT');
        const result = await options.run({ root: parsed.data.root, path: parsed.data.path, source: options.defaults() }, controller.signal);
        return { protocol: 2, kind: 'helm-linted', root: parsed.data.root, path: parsed.data.path, failed: result.failed, content: result.stdout };
      } catch (error) {
        return { protocol: 2, kind: 'helm-lint-unavailable', code: signal.aborted ? 'QUERY_CANCELLED' : lintFailureCode(error) };
      } finally { signal.removeEventListener('abort', abort); clearTimeout(deadline); running = false; }
    },
    close() { closed = true; },
  };
}
