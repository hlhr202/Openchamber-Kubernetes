import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { configSelectionSchema } from './configuration.ts';

// Upstream kubernetesMergeIntoKubeconfig (extension.ts#L2371-L2378, registered at #L262) obtains
// the provider config via kubeconfigFromTreeNode (contributed node required — the CANCEL case) and
// AWAITS mergeToKubeconfig (kubeconfig.ts#L112-L240): a WSL path type refuses with the fixed
// message; a multi-path KUBECONFIG merges into the FIRST path only; a missing file reads as an
// empty config and a null parse shows 'Error fetching kubeconfig.'; collision detection compares
// the FIRST stanza of each kind by exact name and prompts
// `<duplicates> already exist in kubeconfig. What would you like to do?` with
// Overwrite/Keep Both/Cancel — Cancel or dismissal shows 'Merge cancelled.' and writes nothing;
// Keep Both suffixes the cluster/user/context names together (AKS resource-group pattern first,
// then counters over existing cluster names) and rewrites the context references; the merge then
// replaces or appends the first stanza per kind, sets 'current-context' only for a NEW file, and
// persists via delete-old-backup → rename → write (NOT transactional) reporting
// `New configuration merged to <file>`. DELIVERY NOTE: this increment ships the bounded protocol
// and the upstream-verbatim pure projections under static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the provider config fetch and the local kubeconfig write run in the
// HUMAN package environment (NORMAL case: the provider config is fetched and merged into the
// chosen Server target — the original multi-path uses only the FIRST path and the FIRST stanza of
// each kind, the existing current-context is preserved, and a new file gets the new context;
// COLLISION case: Overwrite/Keep Both/Cancel stay explicit — Keep Both rewrites the
// cluster/user/context names and their references, never silently overwriting shared entries or
// an existing backup; CANCEL case: the original command requires a contributed node — a missing
// source or a cancelled fetch/collision writes nothing, and excluding Clouds never removes the
// palette reachability; PARTIAL_UNKNOWN case: the old backup deletion, file rename and write are
// NOT transactional — failures are accounted step by step with no automatic rollback, and the
// existing namespace writer never impersonates an implemented import). No automated execution
// exists anywhere.
export const mergeKubeconfigRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('merge') }).strict(),
]);
export type MergeKubeconfigRequest = z.infer<typeof mergeKubeconfigRequestSchema>;
export const mergeKubeconfigResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('wsl-unsupported') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('merge-cancelled') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('merge-confirmed'), renameWithSuffix: z.boolean() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('merge-completed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('merge-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type MergeKubeconfigResponse = z.infer<typeof mergeKubeconfigResponseSchema>;
// Upstream messages and buttons verbatim.
export function wslUnsupportedMessage(): string {
  return "You are on Windows, but are using WSL-based tools. We can't merge into your WSL kubeconfig. Consider running VS Code in WSL using the Remote Extensions.";
}
export function errorFetchingKubeconfigMessage(): string {
  return 'Error fetching kubeconfig.';
}
export function duplicatePromptMessage(duplicateNames: string): string {
  return `${duplicateNames} already exist in kubeconfig. What would you like to do?`;
}
export function mergeCancelledMessage(): string {
  return 'Merge cancelled.';
}
export function mergedMessage(kcfile: string): string {
  return `New configuration merged to ${kcfile}`;
}
export const OVERWRITE_BUTTON = 'Overwrite';
export const KEEP_BOTH_BUTTON = 'Keep Both';
export const CANCEL_BUTTON = 'Cancel';
// Upstream multi-path rule verbatim: only the FIRST path of the delimited KUBECONFIG merges.
export function firstMergePath(hostPath: string, delimiter: string): string {
  return hostPath.split(delimiter)[0] ?? '';
}
export interface NamedEntry {
  name: string;
  context?: { cluster?: string; user?: string };
}
export interface KubeconfigLike {
  clusters?: NamedEntry[];
  users?: NamedEntry[];
  contexts?: NamedEntry[];
  'current-context'?: string;
}
// Upstream collision detection verbatim: the FIRST stanza of each kind compared by exact name.
export function collisionState(existing: KubeconfigLike, incoming: KubeconfigLike): { clusterExists: boolean; userExists: boolean; contextExists: boolean } {
  const newCluster = incoming.clusters?.[0];
  const newUser = incoming.users?.[0];
  const newContext = incoming.contexts?.[0];
  return {
    clusterExists: !!(newCluster && existing.clusters?.some((c) => c.name === newCluster.name)),
    userExists: !!(newUser && existing.users?.some((u) => u.name === newUser.name)),
    contextExists: !!(newContext && existing.contexts?.some((c) => c.name === newContext.name)),
  };
}
// Upstream duplicate list verbatim: cluster/user/context quoted items joined with ', '.
export function duplicateNamesDescription(clusterExists: boolean, userExists: boolean, contextExists: boolean, clusterName: string, userName: string, contextName: string): string {
  return [
    clusterExists ? `cluster '${clusterName}'` : null,
    userExists ? `user '${userName}'` : null,
    contextExists ? `context '${contextName}'` : null,
  ].filter(Boolean).join(', ');
}
// Upstream counter verbatim: 2, 3, 4, ... while `<base> (<counter>)` exists among cluster names.
export function findNextCounter(existingClusterNames: readonly string[], baseName: string): number {
  let counter = 2;
  while (existingClusterNames.some((name) => name === `${baseName} (${counter})`)) {
    counter++;
  }
  return counter;
}
// Upstream Keep Both suffix verbatim: AKS `clusterUser_<resourceGroup>_` suffix first (with a
// counter when the resource-group name already exists), otherwise a plain counter.
export function keepBothSuffix(newUserName: string, newClusterName: string, existingClusterNames: readonly string[]): string {
  const match = newUserName.match(/^clusterUser_([^_]+)_/);
  if (match) {
    const baseSuffix = match[1] ?? '';
    const candidateName = `${newClusterName} (${baseSuffix})`;
    return existingClusterNames.some((name) => name === candidateName)
      ? ` (${baseSuffix}) (${findNextCounter(existingClusterNames, candidateName)})`
      : ` (${baseSuffix})`;
  }
  return ` (${findNextCounter(existingClusterNames, newClusterName)})`;
}
// Upstream Keep Both rewrite verbatim: one shared suffix on all three names plus the context
// references (pure copies; semantics identical to the upstream in-place mutations).
export function applyKeepBothSuffix(newCluster: NamedEntry, newUser: NamedEntry, newContext: NamedEntry, suffix: string): { cluster: NamedEntry; user: NamedEntry; context: NamedEntry } {
  const cluster: NamedEntry = { ...newCluster, name: newCluster.name + suffix };
  const user: NamedEntry = { ...newUser, name: newUser.name + suffix };
  const context: NamedEntry = { ...newContext, name: newContext.name + suffix };
  const ctx = newContext.context;
  if (ctx) {
    return { cluster, user, context: { ...context, context: { ...ctx, cluster: cluster.name, user: user.name } } };
  }
  return { cluster, user, context };
}
// Upstream merge loop verbatim: per kind the FIRST stanza replaces an exact-name match in place or
// is appended (pure array copies; semantics identical to the upstream in-place loop).
export function mergeFirstStanzas(existing: KubeconfigLike, incoming: KubeconfigLike): KubeconfigLike {
  const merged: KubeconfigLike = { ...existing };
  for (const field of ['clusters', 'users', 'contexts'] as const) {
    const newEntry = incoming[field]?.[0];
    if (!newEntry) {
      continue;
    }
    const arr = [...(merged[field] ?? [])];
    const existingIndex = arr.findIndex((entry) => entry.name === newEntry.name);
    if (existingIndex >= 0) {
      arr[existingIndex] = newEntry;
    } else {
      arr.push(newEntry);
    }
    merged[field] = arr;
  }
  return merged;
}
// Upstream current-context rule verbatim: only a NEW file adopts the merged context's name.
export function shouldSetCurrentContext(kcfileExists: boolean, newContext: NamedEntry | undefined): boolean {
  return !kcfileExists && !!newContext;
}

// ---- Approved batch-2 G4 chain (real server-side execution) ----
// The incoming kubeconfig TEXT arrives from the client (provider fetch in M7 or explicit paste);
// the server merges into the FIRST EXISTING path of the bound selection (upstream
// GetDefaultFilename) with the audited collision strategies. One 60s confirmation pins the
// exact preview (duplicates, keep-both suffix, counts); the dispatch is ONE staged replace.
export const mergeKubeconfigGateParametersSchema = z.object({
  strategy: z.enum(['overwrite', 'keep-both']),
  incoming: z.string().min(1).max(48_000),
}).strict();
export type MergeKubeconfigGateParameters = z.infer<typeof mergeKubeconfigGateParametersSchema>;
export const mergeKubeconfigViewGrantSchema = z.object({ id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), serviceGeneration: z.string().uuid(), expiresAt: z.number().int().nonnegative() }).strict();
export type MergeKubeconfigViewGrant = z.infer<typeof mergeKubeconfigViewGrantSchema>;
export const mergeKubeconfigPreviewSchema = z.object({
  targetPath: z.string().min(1).max(4096), creates: z.boolean(),
  duplicates: z.string().max(1024), keepBothSuffix: z.string().max(256).nullable(),
  clusters: z.number().int().min(0).max(5000), users: z.number().int().min(0).max(5000), contexts: z.number().int().min(0).max(5000),
  setsCurrentContext: z.boolean(),
}).strict();
export type MergeKubeconfigPreview = z.infer<typeof mergeKubeconfigPreviewSchema>;
export const mergeKubeconfigOutcomeSchema = z.object({ id: z.string().uuid(), owner: z.string().uuid(), step: z.literal('merge-kubeconfig'), dependencies: z.tuple([]),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'queued', 'checking', 'dispatching', 'accepted', 'failed', 'unknown', 'cancelled']), code: z.enum(errorCodes).optional(),
  strategy: z.enum(['overwrite', 'keep-both']) }).strict()
  .refine(value => value.phase !== 'accepted' || value.code === undefined);
export type MergeKubeconfigOutcome = z.infer<typeof mergeKubeconfigOutcomeSchema>;
export const mergeKubeconfigRequest2Schema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('open'), selection: configSelectionSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), grant: mergeKubeconfigViewGrantSchema, parameters: mergeKubeconfigGateParametersSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: mergeKubeconfigViewGrantSchema, id: z.string().uuid(), proof: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal('merge-kubeconfig-exact-first-path') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: mergeKubeconfigViewGrantSchema, id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('close'), grant: mergeKubeconfigViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type MergeKubeconfigGateRequest = z.infer<typeof mergeKubeconfigRequest2Schema>;
export const mergeKubeconfigResponse2Schema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('view'), grant: mergeKubeconfigViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), outcome: mergeKubeconfigOutcomeSchema, preview: mergeKubeconfigPreviewSchema, proof: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: mergeKubeconfigOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('closed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(mergeKubeconfigOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
export type MergeKubeconfigGateResponse = z.infer<typeof mergeKubeconfigResponse2Schema>;
