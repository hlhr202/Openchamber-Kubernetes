// User-triggered dry run: bounded single-shot, no queueing; the syntax is re-probed through the
// version reader on every run (upstream probes before building the install arguments).
import { BoundaryError } from '../../shared/errors.ts';
import { helmDryRunRequestSchema } from '../../shared/helm-dryrun-protocol.ts';
import { dryRunFailureCode } from '../../shared/helm-dryrun-protocol.ts';
import type { HelmDryRunResponse } from '../../shared/helm-dryrun-protocol.ts';
import type { HelmDryRunRun } from '../adapters/helm-dryrun-cli.ts';
import type { HelmSyntax } from '../../shared/helm-version-protocol.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
const deadlineMs = 30_000;
export function createHelmDryRunOperations(options: { run: HelmDryRunRun; defaults?: () => HelmRepositorySource; syntax: (signal: AbortSignal) => Promise<HelmSyntax> }) {
  let running = false, closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<HelmDryRunResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = helmDryRunRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (running) throw new BoundaryError('QUERY_LIMIT'); // one dry run at a time; never queued
      running = true;
      const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), deadlineMs);
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      try {
        if (!options.defaults) throw new BoundaryError('INVALID_INPUT');
        const syntax = await options.syntax(signal);
        const content = await options.run({ syntax, root: parsed.data.root, path: parsed.data.path, source: options.defaults() }, controller.signal);
        return { protocol: 2, kind: 'helm-dry-ran', root: parsed.data.root, path: parsed.data.path, syntax, content };
      } catch (error) {
        return { protocol: 2, kind: 'helm-dry-run-unavailable', code: signal.aborted ? 'QUERY_CANCELLED' : dryRunFailureCode(error) };
      } finally { signal.removeEventListener('abort', abort); clearTimeout(deadline); running = false; }
    },
    close() { closed = true; },
  };
}
