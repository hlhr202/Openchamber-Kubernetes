// Approved batch-2 Sync WRITE control plane (G4 chain): prepare re-probes the commit creation
// time with a READ-ONLY git log (fresh disclosure), the 60s confirmation pins the exact commit,
// and the single dispatch is ONE git checkout in the project root. Never force/reset/clean.
import { BoundaryError } from '../../shared/errors.ts';
import { gitSyncGateRequestSchema, gitSyncGateResponseSchema, gitSyncParametersSchema, imageTagCommit } from '../../shared/git-sync-protocol.ts';
import type { GitSyncOutcome, GitSyncGateResponse } from '../../shared/git-sync-protocol.ts';
import { bindResourceTarget } from '../queries/resource-target.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';
import { createG4SubmitGate } from './g4-submit.ts';

type Parameters = { readonly root: string; readonly path: string; readonly image: string; readonly commitId: string; readonly whenCreated: string | null };
export function createGitSyncOperations(options: { serviceGeneration: string; config: ReturnType<typeof createConfigReader>; lock: ConfigurationWriteLock;
  probe: (root: string, commitId: string, signal: AbortSignal) => Promise<string | null>;
  checkout: (root: string, commitId: string, signal: AbortSignal) => Promise<void> }) {
  const gate = createG4SubmitGate<Parameters>({
    serviceGeneration: options.serviceGeneration, lock: options.lock, step: 'git-sync', dispatchTimeoutMs: 60_000,
    bind: async (target, selection, signal) => bindResourceTarget(target, await options.config.read(selection, signal), options.serviceGeneration),
    lockKey: target => target.configIdentity,
    dispatch: async (record, beforeDispatch, signal) => {
      const parameters = record.outcome.parameters;
      beforeDispatch(); // the checkout is the one dispatched effect
      await options.checkout(parameters.root, parameters.commitId, signal);
      return { outcome: 'accepted' };
    },
  });
  let closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<GitSyncGateResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const request = gitSyncGateRequestSchema.parse(input);
      gate.prune();
      if (request.kind === 'outcomes') {
        const page = gate.outcomes(request.after);
        return gitSyncGateResponseSchema.parse({ protocol: 2, kind: 'outcomes', serviceGeneration: options.serviceGeneration, outcomes: page.outcomes as GitSyncOutcome[], next: page.next });
      }
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (request.kind === 'open') return gitSyncGateResponseSchema.parse({ protocol: 2, kind: 'view', grant: await gate.open(request.selection, request.target, signal) });
      if (request.kind === 'close') { gate.closeView(request.grant); return { protocol: 2, kind: 'closed' } as const; }
      if (request.kind === 'prepare') {
        const input0 = gitSyncParametersSchema.parse(request.parameters);
        if (imageTagCommit(input0.image) !== input0.commitId) throw new BoundaryError('INVALID_INPUT'); // the tag rule stays the only commit source
        // Fresh read-only probe: the disclosed creation time is re-derived server-side.
        const whenCreated = await options.probe(input0.root, input0.commitId, signal);
        const parameters = { ...input0, whenCreated } as unknown as Parameters;
        const prepared = await gate.prepare(request.grant, parameters, undefined, signal);
        return gitSyncGateResponseSchema.parse({ protocol: 2, kind: 'confirmation', outcome: prepared.record.outcome as GitSyncOutcome, proof: prepared.proof, expiresAt: prepared.expiresAt });
      }
      const record = request.kind === 'cancel' ? gate.cancel(request.grant, request.id) : gate.submit(request.grant, request.id, request.proof);
      return gitSyncGateResponseSchema.parse({ protocol: 2, kind: 'outcome', outcome: record.outcome as GitSyncOutcome });
    },
    counts(): Record<string, number> {
      // Stop-gate aggregate over the universal G4 gate (phase counts only).
      const state = gate.state;
      return { inFlight: state.inFlight, unknown: state.unknown, records: state.records };
    },
    close() { closed = true; gate.close(); },
  };
}
