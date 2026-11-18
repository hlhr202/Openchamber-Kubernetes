// User-triggered chart scaffolding: bounded single-shot workspace write, no queueing, never repeated.
import { BoundaryError } from '../../shared/errors.ts';
import { helmCreateRequestSchema } from '../../shared/helm-create-protocol.ts';
import { createFailureCode } from '../../shared/helm-create-protocol.ts';
import type { HelmCreateResponse } from '../../shared/helm-create-protocol.ts';
import type { HelmCreateRun } from '../adapters/helm-create-cli.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
const deadlineMs = 30_000;
export function createHelmCreateOperations(options: { run: HelmCreateRun; defaults?: () => HelmRepositorySource }) {
  let running = false, closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<HelmCreateResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = helmCreateRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (running) throw new BoundaryError('QUERY_LIMIT'); // one create at a time; never queued
      running = true;
      const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), deadlineMs);
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      try {
        if (!options.defaults) throw new BoundaryError('INVALID_INPUT');
        const content = await options.run({ root: parsed.data.root, path: parsed.data.path, name: parsed.data.name, source: options.defaults() }, controller.signal);
        return { protocol: 2, kind: 'helm-chart-created', root: parsed.data.root, path: parsed.data.path, name: parsed.data.name, content };
      } catch (error) {
        return { protocol: 2, kind: 'helm-chart-create-unavailable', code: signal.aborted ? 'QUERY_CANCELLED' : createFailureCode(error) };
      } finally { signal.removeEventListener('abort', abort); clearTimeout(deadline); running = false; }
    },
    close() { closed = true; },
  };
}
