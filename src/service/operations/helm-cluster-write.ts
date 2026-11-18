// Approved D-01 helm cluster WRITE control plane (install/rollback/uninstall) on the universal
// G4 gate: prepare re-proves the release state (rollback/uninstall pin the CURRENT newest
// revision's Secret uid/resourceVersion; install requires the name to be absent), the 60s
// confirmation pins the exact action, and the single dispatch runs ONE helm invocation through
// the zero-materialisation CLI transport. Never imported/instantiated/called from tests.
import { BoundaryError } from '../../shared/errors.ts';
import { helmWriteRequestSchema, helmWriteResponseSchema, helmWriteParametersSchema } from '../../shared/helm-release-protocol.ts';
import type { HelmWriteOutcome, HelmWriteResponse, HelmWriteParameters } from '../../shared/helm-release-protocol.ts';
import { bindResourceTarget } from '../queries/resource-target.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import type { createResourceGateway } from '../queries/resource-gateway.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';
import { createG4SubmitGate } from './g4-submit.ts';
import type { HelmClusterDispatch, HelmClusterResult } from '../adapters/helm-cluster-cli.ts';

export function createHelmClusterWriteOperations(options: { serviceGeneration: string; config: ReturnType<typeof createConfigReader>; resources: ReturnType<typeof createResourceGateway>; lock: ConfigurationWriteLock;
  execute: (input: HelmClusterDispatch, beforeDispatch: () => void, signal: AbortSignal) => Promise<HelmClusterResult> }) {
  const gate = createG4SubmitGate<HelmWriteParameters>({
    serviceGeneration: options.serviceGeneration, lock: options.lock, step: 'helm-cluster-write', dispatchTimeoutMs: 62_000,
    bind: async (target, selection, signal) => bindResourceTarget(target, await options.config.read(selection, signal), options.serviceGeneration),
    lockKey: target => target.configIdentity,
    dispatch: async (record, beforeDispatch, signal) => {
      const result = await options.execute({ target: record.view.target, selection: record.view.selection, namespace: record.outcome.parameters.namespace, parameters: record.outcome.parameters, notAfter: record.expiresAt }, beforeDispatch, signal);
      return { outcome: result.outcome, ...(result.code !== undefined ? { code: result.code } : {}), ...(result.stdoutTail !== undefined ? { details: { stdoutTail: result.stdoutTail } } : {}) };
    },
  });
  let closed = false;
  const withDetails = (outcome: HelmWriteOutcome, details: unknown): HelmWriteOutcome =>
    details === undefined || details === null ? outcome : { ...outcome, ...(details as { stdoutTail?: string }) };
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<HelmWriteResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const request = helmWriteRequestSchema.parse(input);
      gate.prune();
      if (request.kind === 'outcomes') {
        const page = gate.outcomes(request.after);
        return helmWriteResponseSchema.parse({ protocol: 2, kind: 'outcomes', serviceGeneration: options.serviceGeneration, outcomes: page.outcomes.map(outcome => withDetails(outcome as HelmWriteOutcome, outcome.details)), next: page.next });
      }
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (request.kind === 'open') return helmWriteResponseSchema.parse({ protocol: 2, kind: 'view', grant: await gate.open(request.selection, request.target, signal) });
      if (request.kind === 'close') { gate.closeView(request.grant); return { protocol: 2, kind: 'closed' } as const; }
      if (request.kind === 'prepare') {
        const parameters = helmWriteParametersSchema.parse(request.parameters);
        const owner = gate.viewOf(request.grant);
        // Fresh release proof: rollback/uninstall pin the newest revision's Secret identity
        // (M6-C4 provenance); install requires the release name to be absent right now.
        const state = await options.resources.readHelmReleases({ protocol: 2, kind: 'read', selection: owner.selection, target: owner.target, namespace: parameters.namespace }, signal);
        if (state.kind !== 'releases') throw new BoundaryError('STATE_UNAVAILABLE');
        const existing = state.releases.find(release => release.name === parameters.release);
        if (parameters.action === 'install' && existing) throw new BoundaryError('CONFLICT');
        if (parameters.action !== 'install') {
          if (!existing) throw new BoundaryError('NOT_FOUND');
          const newest = existing.revisions[0];
          if (!newest || newest.uid !== parameters.provenanceUid || newest.resourceVersion !== parameters.provenanceResourceVersion) throw new BoundaryError('STALE_TARGET');
        }
        const prepared = await gate.prepare(request.grant, parameters, undefined, signal);
        return helmWriteResponseSchema.parse({ protocol: 2, kind: 'confirmation', outcome: prepared.record.outcome as HelmWriteOutcome, proof: prepared.proof, expiresAt: prepared.expiresAt });
      }
      const record = request.kind === 'cancel' ? gate.cancel(request.grant, request.id) : gate.submit(request.grant, request.id, request.proof);
      return helmWriteResponseSchema.parse({ protocol: 2, kind: 'outcome', outcome: withDetails(record.outcome as HelmWriteOutcome, record.outcome.details) });
    },
    counts(): Record<string, number> {
      // Stop-gate aggregate over the universal G4 gate (phase counts only).
      const state = gate.state;
      return { inFlight: state.inFlight, unknown: state.unknown, records: state.records };
    },
    close() { closed = true; gate.close(); },
  };
}
