// User-triggered manifest-to-template conversion: parse+transform via the pure parsing module,
// then one exclusive new-file write. Single-shot, never queued, never repeated.
import { BoundaryError } from '../../shared/errors.ts';
import { helmConvertRequestSchema } from '../../shared/helm-convert-protocol.ts';
import { convertFailureCode } from '../../shared/helm-convert-protocol.ts';
import type { HelmConvertResponse } from '../../shared/helm-convert-protocol.ts';
import { convertToTemplateText } from '../../parsing/helm-template-transform.ts';
import type { HelmTemplateWriteRun } from '../adapters/helm-template-write.ts';
const deadlineMs = 30_000;
export function createHelmConvertOperations(options: { run: HelmTemplateWriteRun }) {
  let running = false, closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<HelmConvertResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = helmConvertRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (running) throw new BoundaryError('QUERY_LIMIT'); // one conversion at a time; never queued
      running = true;
      const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), deadlineMs);
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      try {
        const text = convertToTemplateText(parsed.data.document);
        await options.run({ root: parsed.data.root, path: parsed.data.path, name: parsed.data.name, text }, controller.signal);
        return { protocol: 2, kind: 'helm-template-written', root: parsed.data.root, path: parsed.data.path, name: parsed.data.name };
      } catch (error) {
        return { protocol: 2, kind: 'helm-convert-unavailable', code: signal.aborted ? 'QUERY_CANCELLED' : convertFailureCode(error) };
      } finally { signal.removeEventListener('abort', abort); clearTimeout(deadline); running = false; }
    },
    close() { closed = true; },
  };
}
