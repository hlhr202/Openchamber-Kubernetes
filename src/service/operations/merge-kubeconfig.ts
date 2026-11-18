// Approved batch-2 mergeIntoKubeconfig WRITE control plane on the universal G4 gate: prepare
// computes the upstream-verbatim collision preview against the FIRST EXISTING path of the bound
// selection, the 60s confirmation pins the exact preview + strategy, and the dispatch is ONE
// staged replace. Upstream merge semantics live in the shared pure projections.
import { createHash } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { mergeKubeconfigRequest2Schema, mergeKubeconfigResponse2Schema, mergeKubeconfigGateParametersSchema } from '../../shared/merge-kubeconfig-protocol.ts';
import type { MergeKubeconfigGateResponse, MergeKubeconfigPreview } from '../../shared/merge-kubeconfig-protocol.ts';
import { collisionState, duplicateNamesDescription, keepBothSuffix, applyKeepBothSuffix, mergeFirstStanzas, shouldSetCurrentContext } from '../../shared/merge-kubeconfig-protocol.ts';
import type { KubeconfigLike } from '../../shared/merge-kubeconfig-protocol.ts';
import { resolveConfigSelection } from '../queries/config-source.ts';
import type { DefaultConfigPaths } from '../queries/config-discovery.ts';
import type { ConfigurationWriteLock } from './configuration-lock.ts';
import { createG4SubmitGate } from './g4-submit.ts';
import type { createMergeKubeconfigFileAdapter } from '../adapters/merge-kubeconfig-file.ts';
import type { ErrorCode } from '../../shared/errors.ts';

const kubeconfigLike = z.object({
  clusters: z.array(z.object({ name: z.string().min(1).max(253) }).passthrough()).max(5000).optional(),
  users: z.array(z.object({ name: z.string().min(1).max(253) }).passthrough()).max(5000).optional(),
  contexts: z.array(z.object({ name: z.string().min(1).max(253) }).passthrough()).max(5000).optional(),
  'current-context': z.string().max(253).optional(),
}).passthrough();
function parseKubeconfigLike(text: string, limit: number): KubeconfigLike {
  if (Buffer.byteLength(text) > limit) throw new BoundaryError('BUDGET_EXCEEDED');
  try {
    const doc = parseDocument(text, { uniqueKeys: true, strict: true });
    if (doc.errors.length || doc.warnings.length) throw new BoundaryError('CONFIG_INVALID');
    return kubeconfigLike.parse(doc.toJS({ maxAliasCount: 50 }) ?? {}) as KubeconfigLike;
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    throw new BoundaryError('CONFIG_INVALID');
  }
}
type Parameters = { readonly strategy: 'overwrite' | 'keep-both'; readonly incoming: string };
type Attachment = { readonly targetPath: string; readonly exists: boolean; readonly version: string; readonly intended: string; readonly preview: MergeKubeconfigPreview };
const digestOf = (value: string) => createHash('sha256').update(value).digest('hex');
export function buildMergedDocument(existingText: string, incomingText: string, strategy: 'overwrite' | 'keep-both', targetExists: boolean): { readonly document: KubeconfigLike; readonly next: string } {
  const existing = parseKubeconfigLike(existingText, 2_000_000), incoming = parseKubeconfigLike(incomingText, 48_000);
  const newCluster = incoming.clusters?.[0], newUser = incoming.users?.[0], newContext = incoming.contexts?.[0];
  if (!newCluster || !newUser || !newContext) throw new BoundaryError('CONTENT_INVALID'); // upstream merges one complete stanza triple
  const collisions = collisionState(existing, incoming);
  const anyCollision = collisions.clusterExists || collisions.userExists || collisions.contextExists;
  let effectiveIncoming = incoming;
  if (strategy === 'keep-both' && anyCollision) {
    const suffix = keepBothSuffix(newUser.name, newCluster.name, (existing.clusters ?? []).map(entry => entry.name));
    const rewritten = applyKeepBothSuffix(newCluster, newUser, newContext, suffix);
    effectiveIncoming = { ...incoming, clusters: [rewritten.cluster], users: [rewritten.user], contexts: [rewritten.context] };
  }
  // upstream Overwrite: mergeFirstStanzas replaces the exact-name first stanzas in place.
  let merged = mergeFirstStanzas(existing, effectiveIncoming);
  const currentTarget = effectiveIncoming.contexts?.[0];
  if (shouldSetCurrentContext(targetExists, currentTarget) && currentTarget) merged = { ...merged, 'current-context': currentTarget.name };
  return { document: merged, next: `${stringify(merged)}\n` };
}
export function createMergeKubeconfigOperations(options: { serviceGeneration: string; defaultPaths: DefaultConfigPaths; lock: ConfigurationWriteLock;
  files: ReturnType<typeof createMergeKubeconfigFileAdapter> }) {
  const defaultPaths = options.defaultPaths;
  const gate = createG4SubmitGate<Parameters, Attachment>({
    serviceGeneration: options.serviceGeneration, lock: options.lock, step: 'merge-kubeconfig',
    // The merge target is a CONFIG FILE, not a cluster resource: the lock key is the bound selection.
    lockKey: () => 'kubeconfig-merge',
    bind: async (_target, selection) => {
      // Bind by validating the selection resolves to ordered server-side paths; the returned
      // identity keys the shared lock on the ORDERED PATH SET (a config write, not a resource).
      const ordered = resolveConfigSelection(selection, defaultPaths).orderedPaths;
      if (!ordered.length || ordered.some(path => typeof path !== 'string' || !path.startsWith('/'))) throw new BoundaryError('CONFIG_NOT_FOUND');
      return { serviceGeneration: options.serviceGeneration, projectId: 'kubeconfig', configIdentity: digestOf(ordered.join('\n')), context: '', namespace: '' };
    },
    dispatch: async (record, beforeDispatch, signal) => {
      const attachment = record.attachment;
      if (!attachment) throw new BoundaryError('STATE_UNAVAILABLE');
      const snapshot = await options.files.snapshot(attachment.targetPath, signal);
      if (snapshot.exists !== attachment.exists || snapshot.version !== attachment.version) throw new BoundaryError('CONFIG_CHANGED');
      beforeDispatch();
      const result = await options.files.replace(snapshot, (await buildMergedDocument(snapshot.body, record.outcome.parameters.incoming, record.outcome.parameters.strategy, attachment.exists)).next,
        attachment.intended, record.outcome.id, () => {}, () => {}, signal);
      return result.phase === 'succeeded' ? { outcome: 'accepted' } : { outcome: result.phase === 'unknown' ? 'unknown' : 'failed', code: result.code as ErrorCode };
    },
  });
  let closed = false;
  return {
    async handle(input: unknown, signal: AbortSignal): Promise<MergeKubeconfigGateResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const request = mergeKubeconfigRequest2Schema.parse(input);
      gate.prune();
      if (request.kind === 'outcomes') {
        const page = gate.outcomes(request.after);
        return mergeKubeconfigResponse2Schema.parse({ protocol: 2, kind: 'outcomes', serviceGeneration: options.serviceGeneration, outcomes: page.outcomes, next: page.next });
      }
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (request.kind === 'open') {
        const ordered = resolveConfigSelection(request.selection, defaultPaths).orderedPaths;
        const grant = await gate.open(request.selection, { serviceGeneration: options.serviceGeneration, projectId: 'kubeconfig', configIdentity: digestOf(ordered.join('\n')), context: '', namespace: '' }, signal);
        return mergeKubeconfigResponse2Schema.parse({ protocol: 2, kind: 'view', grant });
      }
      if (request.kind === 'close') { gate.closeView(request.grant); return { protocol: 2, kind: 'closed' } as const; }
      if (request.kind === 'prepare') {
        const parameters = mergeKubeconfigGateParametersSchema.parse(request.parameters) as Parameters;
        const owner = gate.viewOf(request.grant);
        const ordered = resolveConfigSelection(owner.selection, defaultPaths).orderedPaths;
        const targetPath = ordered.find(path => typeof path === 'string') ?? ordered[0];
        if (!targetPath) throw new BoundaryError('CONFIG_NOT_FOUND');
        const snapshot = await options.files.snapshot(targetPath, signal);
        const existing = parseKubeconfigLike(snapshot.body, 2_000_000), incoming = parseKubeconfigLike(parameters.incoming, 48_000);
        const newCluster = incoming.clusters?.[0], newUser = incoming.users?.[0], newContext = incoming.contexts?.[0];
        if (!newCluster || !newUser || !newContext) throw new BoundaryError('CONTENT_INVALID');
        const collisions = collisionState(existing, incoming);
        const anyCollision = collisions.clusterExists || collisions.userExists || collisions.contextExists;
        const suffix = anyCollision ? keepBothSuffix(newUser.name, newCluster.name, (existing.clusters ?? []).map(entry => entry.name)) : null;
        const preview: MergeKubeconfigPreview = { targetPath, creates: !snapshot.exists,
          duplicates: anyCollision ? duplicateNamesDescription(collisions.clusterExists, collisions.userExists, collisions.contextExists, newCluster.name, newUser.name, newContext.name) : '',
          keepBothSuffix: suffix, clusters: (existing.clusters ?? []).length, users: (existing.users ?? []).length, contexts: (existing.contexts ?? []).length,
          setsCurrentContext: shouldSetCurrentContext(snapshot.exists, newContext) };
        const built = buildMergedDocument(snapshot.body, parameters.incoming, parameters.strategy, snapshot.exists);
        const prepared = await gate.prepare(request.grant, parameters, { targetPath, exists: snapshot.exists, version: snapshot.version, intended: digestOf(built.next), preview }, signal);
        return mergeKubeconfigResponse2Schema.parse({ protocol: 2, kind: 'confirmation', outcome: prepared.record.outcome, preview, proof: prepared.proof, expiresAt: prepared.expiresAt });
      }
      const record = request.kind === 'cancel' ? gate.cancel(request.grant, request.id) : gate.submit(request.grant, request.id, request.proof);
      return mergeKubeconfigResponse2Schema.parse({ protocol: 2, kind: 'outcome', outcome: record.outcome });
    },
    counts(): Record<string, number> {
      // Stop-gate aggregate over the universal G4 gate (phase counts only).
      const state = gate.state;
      return { inFlight: state.inFlight, unknown: state.unknown, records: state.records };
    },
    close() { closed = true; gate.close(); },
  };
}
