// User-triggered chart inspection: bounded single-shot preview, no queueing, no rollback.
// Syntax is re-probed through the version reader on every run (upstream probes before inspect).
import { BoundaryError } from '../../shared/errors.ts';
import { helmInspectRequestSchema } from '../../shared/helm-inspect-protocol.ts';
import { inspectFailureCode } from '../../shared/helm-inspect-protocol.ts';
import type { HelmInspectResponse } from '../../shared/helm-inspect-protocol.ts';
import type { HelmInspectRun } from '../adapters/helm-inspect-cli.ts';
import type { HelmSyntax } from '../../shared/helm-version-protocol.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
const deadlineMs = 30_000;
export function createHelmInspectOperations(options: { run: HelmInspectRun; defaults?: () => HelmRepositorySource; syntax: (signal: AbortSignal) => Promise<HelmSyntax> }) {
  let running = false, closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<HelmInspectResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = helmInspectRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (running) throw new BoundaryError('QUERY_LIMIT'); // one inspection at a time; never queued
      running = true;
      const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), deadlineMs);
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      try {
        if (!options.defaults) throw new BoundaryError('INVALID_INPUT');
        const syntax = await options.syntax(signal);
        const content = await options.run({ syntax, chart: parsed.data.chart, ...(parsed.data.version ? { version: parsed.data.version } : {}), source: options.defaults() }, controller.signal);
        return { protocol: 2, kind: 'helm-chart-inspected', chart: parsed.data.chart, ...(parsed.data.version ? { version: parsed.data.version } : {}), content };
      } catch (error) {
        return { protocol: 2, kind: 'helm-chart-inspect-unavailable', code: signal.aborted ? 'QUERY_CANCELLED' : inspectFailureCode(error) };
      } finally { signal.removeEventListener('abort', abort); clearTimeout(deadline); running = false; }
    },
    close() { closed = true; },
  };
}
