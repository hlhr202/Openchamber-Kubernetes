// User-triggered chart template render: bounded single-shot, no queueing, render failure is a fixed code.
import { BoundaryError } from '../../shared/errors.ts';
import { helmTemplateRequestSchema } from '../../shared/helm-template-protocol.ts';
import { templateFailureCode } from '../../shared/helm-template-protocol.ts';
import type { HelmTemplateResponse } from '../../shared/helm-template-protocol.ts';
import type { HelmTemplateRun } from '../adapters/helm-template-cli.ts';
import type { HelmRepositorySource } from '../../shared/helm-repository-protocol.ts';
const deadlineMs = 30_000;
export function createHelmTemplateOperations(options: { run: HelmTemplateRun; defaults?: () => HelmRepositorySource }) {
  let running = false, closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<HelmTemplateResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = helmTemplateRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (running) throw new BoundaryError('QUERY_LIMIT'); // one render at a time; never queued
      running = true;
      const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), deadlineMs);
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      try {
        if (!options.defaults) throw new BoundaryError('INVALID_INPUT');
        const content = await options.run({ root: parsed.data.root, path: parsed.data.path, source: options.defaults() }, controller.signal);
        return { protocol: 2, kind: 'helm-templated', root: parsed.data.root, path: parsed.data.path, content };
      } catch (error) {
        return { protocol: 2, kind: 'helm-template-unavailable', code: signal.aborted ? 'QUERY_CANCELLED' : templateFailureCode(error) };
      } finally { signal.removeEventListener('abort', abort); clearTimeout(deadline); running = false; }
    },
    close() { closed = true; },
  };
}
