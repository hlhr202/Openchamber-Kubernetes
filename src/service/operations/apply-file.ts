// D-02 approved ApplyFile WRITE control plane (apply verb): one workspace file -> <=16 strict
// documents -> per-document fresh probe (exists -> apply-merge, missing -> create) -> one 60s
// confirmation pinning the exact document digests -> ONE dispatch (one request per document).
// Built on the universal G4 submit gate; never imported/instantiated/called from functional tests.
import { createHash } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import { applyFileGateRequestSchema, applyFileGateResponseSchema, applyFileParametersSchema } from '../../shared/apply-file-protocol.ts';
import type { ApplyFileOutcome, ApplyFileGateResponse, ApplyFileResult } from '../../shared/apply-file-protocol.ts';
import { readApplyFileDocuments } from '../../parsing/apply-file-documents.ts';
import type { ApplyFileDocument } from '../../parsing/apply-file-documents.ts';
import { bindResourceTarget } from '../queries/resource-target.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import type { createResourceGateway } from '../queries/resource-gateway.ts';
import type { createWorkspaceReader } from '../queries/workspace-reader.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';
import { createG4SubmitGate } from './g4-submit.ts';
import type { ApplyFileDispatch, ApplyFileDispatchResult } from '../adapters/apply-file-https.ts';

type PlanDocument = { readonly index: number; readonly locator: ApplyFileDocument['locator']; readonly action: 'apply-merge' | 'create'; readonly digest: string; readonly liveVersion: string | null };
type Parameters = { readonly file: { readonly root: string; readonly path: string; readonly version: string; readonly identity: string; readonly format: 'yaml' | 'json' }; readonly sourceDigest: string; readonly documents: readonly PlanDocument[] };
type Attachment = { readonly texts: readonly string[] };
const digestOf = (value: string) => createHash('sha256').update(value).digest('hex');
const withResults = (outcome: ApplyFileOutcome, results: readonly ApplyFileResult[] | undefined): ApplyFileOutcome =>
  results === undefined ? outcome : { ...outcome, results } as ApplyFileOutcome;

export function createApplyFileOperations(options: { serviceGeneration: string; config: ReturnType<typeof createConfigReader>; resources: ReturnType<typeof createResourceGateway>;
  workspace: Pick<ReturnType<typeof createWorkspaceReader>, 'rebind' | 'capture' | 'release'>; lock: ConfigurationWriteLock;
  execute: (input: ApplyFileDispatch, beforeDispatch: () => void, signal: AbortSignal) => Promise<ApplyFileDispatchResult> }) {
  const gate = createG4SubmitGate<Parameters, Attachment>({
    serviceGeneration: options.serviceGeneration, lock: options.lock, step: 'apply-file', dispatchTimeoutMs: 62_000,
    bind: async (target, selection, signal) => bindResourceTarget(target, await options.config.read(selection, signal), options.serviceGeneration),
    lockKey: target => target.configIdentity,
    dispatch: async (record, beforeDispatch, signal) => {
      const attachment = record.attachment;
      if (!attachment) throw new BoundaryError('STATE_UNAVAILABLE');
      const result = await options.execute({ target: record.view.target, selection: record.view.selection, notAfter: record.expiresAt,
        documents: record.outcome.parameters.documents.map((plan, position) => ({ index: plan.index, text: attachment.texts[position] ?? '', action: plan.action,
          locator: { group: plan.locator.group, version: plan.locator.version, kind: plan.locator.kind, name: plan.locator.name, ...(plan.locator.namespace !== undefined ? { namespace: plan.locator.namespace } : {}) } })) },
        beforeDispatch, signal);
      return { outcome: result.outcome, ...(result.code !== undefined ? { code: result.code } : {}), ...(result.results.length ? { details: result.results } : {}) };
    },
  });
  let closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<ApplyFileGateResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const request = applyFileGateRequestSchema.parse(input);
      gate.prune();
      if (request.kind === 'outcomes') {
        const page = gate.outcomes(request.after);
        return applyFileGateResponseSchema.parse({ protocol: 2, kind: 'outcomes', serviceGeneration: options.serviceGeneration,
          outcomes: page.outcomes.map(outcome => withResults(outcome as ApplyFileOutcome, outcome.details as readonly ApplyFileResult[] | undefined)), next: page.next });
      }
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (request.kind === 'open') {
        const grant = await gate.open(request.selection, request.target, signal);
        return applyFileGateResponseSchema.parse({ protocol: 2, kind: 'view', grant });
      }
      if (request.kind === 'close') { gate.closeView(request.grant); return { protocol: 2, kind: 'closed' } as const; }
      if (request.kind === 'prepare') {
        const owner = gate.viewOf(request.grant), file = request.file;
        // Rebind the ORIGINAL read proof to a private scope and capture the file's exact bytes.
        const scope = await options.workspace.rebind({ protocol: 2, root: file.root, path: file.path, proof: request.fileProof }, signal);
        let texts: readonly string[] = [];
        try {
          const captured = await options.workspace.capture({ protocol: 2, scope: scope.scope, path: file.path }, signal);
          if (captured.version !== file.version || captured.identity !== file.identity) throw new BoundaryError('STALE_TARGET');
          const documents: readonly ApplyFileDocument[] = readApplyFileDocuments(captured.text, file.format);
          const plans: PlanDocument[] = [];
          for (const document of documents) {
            const probe = await options.resources.probeApplyFileDocument({ target: owner.target, selection: owner.selection, locator: document.locator }, signal);
            plans.push({ index: document.index, locator: document.locator, action: probe.exists ? 'apply-merge' : 'create', digest: digestOf(document.text),
              liveVersion: probe.exists ? digestOf(`${probe.reference.type.resource}:${probe.reference.name}`) : null });
            texts = [...texts, document.text];
          }
          const parameters = applyFileParametersSchema.parse({ file: { root: file.root, path: file.path, version: file.version, identity: file.identity, format: file.format }, sourceDigest: request.sourceDigest, documents: plans });
          const prepared = await gate.prepare(request.grant, parameters as unknown as Parameters, { texts }, signal);
          return applyFileGateResponseSchema.parse({ protocol: 2, kind: 'confirmation', outcome: prepared.record.outcome as ApplyFileOutcome, proof: prepared.proof, expiresAt: prepared.expiresAt });
        } finally {
          try { options.workspace.release({ protocol: 2, scope: scope.scope }); } catch { /* private read scope expiry; no filesystem cleanup */ }
        }
      }
      const record = request.kind === 'cancel' ? gate.cancel(request.grant, request.id) : gate.submit(request.grant, request.id, request.proof);
      return applyFileGateResponseSchema.parse({ protocol: 2, kind: 'outcome', outcome: withResults(record.outcome as ApplyFileOutcome, record.outcome.details as readonly ApplyFileResult[] | undefined) });
    },
    counts(): Record<string, number> {
      // Stop-gate aggregate over the universal G4 gate (phase counts only).
      const state = gate.state;
      return { inFlight: state.inFlight, unknown: state.unknown, records: state.records };
    },
    close() { closed = true; gate.close(); },
  };
}
