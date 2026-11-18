// Pure computation reader — no filesystem, no writes, no queueing machinery: one bounded transform
// per call. The two output texts are returned for display only (human places them).
import { BoundaryError } from '../../shared/errors.ts';
import { helmParameteriseRequestSchema, keyReference } from '../../shared/helm-parameterise-protocol.ts';
import type { HelmParameteriseResponse } from '../../shared/helm-parameterise-protocol.ts';
import { parameteriseDocument } from '../../parsing/helm-parameterise-transform.ts';
export function createHelmParameteriseReader() {
  return {
    async read(input: unknown, signal: AbortSignal): Promise<HelmParameteriseResponse> {
      const parsed = helmParameteriseRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      const { document, entry } = parameteriseDocument(parsed.data.document, parsed.data.template, parsed.data.field, parsed.data.value);
      return Object.freeze({ protocol: 2 as const, kind: 'helm-parameterised' as const, template: parsed.data.template, field: parsed.data.field, keyReference: keyReference(parsed.data.template, parsed.data.field), document, entry });
    },
    close() { /* No resources held. */ },
  };
}
