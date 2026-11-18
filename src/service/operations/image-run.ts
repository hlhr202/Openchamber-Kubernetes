// Approved batch-2 ImageRun WRITE control plane (G4 chain): ONE 60s confirmation pins the exact
// workspace root/version/image, then a single sequential dispatch build -> push -> Pod POST.
// Built on the universal G4 submit gate; never imported/instantiated/called from functional tests.
import { BoundaryError } from '../../shared/errors.ts';
import { imageRunGateRequestSchema, imageRunGateResponseSchema, imageRunParametersSchema } from '../../shared/image-run-protocol.ts';
import type { ImageRunOutcome, ImageRunGateResponse } from '../../shared/image-run-protocol.ts';
import { bindResourceTarget } from '../queries/resource-target.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';
import { createG4SubmitGate } from './g4-submit.ts';
import type { ImageRunDispatch, ImageRunResult } from '../adapters/image-run-cli.ts';

type Parameters = { readonly root: string; readonly contextPath: string; readonly version: string; readonly user?: string | undefined; readonly image: string; readonly name: string };
export function createImageRunOperations(options: { serviceGeneration: string; config: ReturnType<typeof createConfigReader>; lock: ConfigurationWriteLock;
  execute: (input: ImageRunDispatch, beforeDispatch: () => void, signal: AbortSignal) => Promise<ImageRunResult> }) {
  const gate = createG4SubmitGate<Parameters>({
    serviceGeneration: options.serviceGeneration, lock: options.lock, step: 'image-run', dispatchTimeoutMs: 420_000,
    bind: async (target, selection, signal) => bindResourceTarget(target, await options.config.read(selection, signal), options.serviceGeneration),
    lockKey: target => target.configIdentity,
    dispatch: async (record, beforeDispatch, signal) => {
      const parameters = record.outcome.parameters;
      const result = await options.execute({ target: record.view.target, selection: record.view.selection, root: parameters.root, contextPath: parameters.contextPath,
        image: parameters.image, name: parameters.name, version: parameters.version, notAfter: record.expiresAt }, beforeDispatch, signal);
      return { outcome: result.outcome, ...(result.code !== undefined ? { code: result.code } : {}),
        ...(result.built !== undefined || result.pushed !== undefined || result.podUid !== undefined ? { details: {
          ...(result.built !== undefined ? { built: result.built } : {}), ...(result.pushed !== undefined ? { pushed: result.pushed } : {}),
          ...(result.podUid !== undefined ? { podUid: result.podUid } : {}), ...(result.podResourceVersion !== undefined ? { podResourceVersion: result.podResourceVersion } : {}) } } : {}) };
    },
  });
  let closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<ImageRunGateResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const request = imageRunGateRequestSchema.parse(input);
      gate.prune();
      if (request.kind === 'outcomes') {
        const page = gate.outcomes(request.after);
        return imageRunGateResponseSchema.parse({ protocol: 2, kind: 'outcomes', serviceGeneration: options.serviceGeneration,
          outcomes: page.outcomes.map(outcome => withDetails(outcome as ImageRunOutcome, outcome.details)), next: page.next });
      }
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (request.kind === 'open') return imageRunGateResponseSchema.parse({ protocol: 2, kind: 'view', grant: await gate.open(request.selection, request.target, signal) });
      if (request.kind === 'close') { gate.closeView(request.grant); return { protocol: 2, kind: 'closed' } as const; }
      if (request.kind === 'prepare') {
        const parameters = imageRunParametersSchema.parse(request.parameters) as unknown as Parameters;
        const prepared = await gate.prepare(request.grant, parameters, undefined, signal);
        return imageRunGateResponseSchema.parse({ protocol: 2, kind: 'confirmation', outcome: prepared.record.outcome as ImageRunOutcome, proof: prepared.proof, expiresAt: prepared.expiresAt });
      }
      const record = request.kind === 'cancel' ? gate.cancel(request.grant, request.id) : gate.submit(request.grant, request.id, request.proof);
      return imageRunGateResponseSchema.parse({ protocol: 2, kind: 'outcome', outcome: withDetails(record.outcome as ImageRunOutcome, record.outcome.details) });
    },
    counts(): Record<string, number> {
      // Stop-gate aggregate over the universal G4 gate (phase counts only).
      const state = gate.state;
      return { inFlight: state.inFlight, unknown: state.unknown, records: state.records };
    },
    close() { closed = true; gate.close(); },
  };
}
function withDetails(outcome: ImageRunOutcome, details: unknown): ImageRunOutcome {
  if (details === undefined || details === null) return outcome;
  return { ...outcome, ...(details as { built?: boolean; pushed?: boolean; podUid?: string; podResourceVersion?: string }) };
}
