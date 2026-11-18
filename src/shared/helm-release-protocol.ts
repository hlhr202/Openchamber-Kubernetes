import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { configSelectionSchema } from './configuration.ts';
import { targetSchema, boundedName, namespaceName } from './identity.ts';

// D-01 approved read protocol for the Helm Releases view (release.v1 Secret parsing in memory).
// One explicit namespace read per request; revisions are grouped per release name with the
// newest revision first; every revision carries the Secret's uid/resourceVersion provenance.
export const helmReleaseStatuses = ['unknown', 'deployed', 'uninstalled', 'superseded', 'failed', 'uninstalling', 'pending-install', 'pending-upgrade', 'pending-rollback'] as const;
export const helmReleaseRevisionSchema = z.object({
  revision: z.number().int().min(1).max(1_000_000), status: z.enum(helmReleaseStatuses),
  chartName: boundedName.max(253), chartVersion: z.string().min(1).max(64),
  appVersion: z.string().max(256).optional(), lastDeployed: z.string().max(64).optional(),
  uid: boundedName, resourceVersion: boundedName,
}).strict();
export type HelmReleaseRevisionView = z.infer<typeof helmReleaseRevisionSchema>;
export const helmReleaseEntrySchema = z.object({
  name: boundedName.max(253), namespace: namespaceName,
  currentRevision: z.number().int().min(1).max(1_000_000), currentStatus: z.enum(helmReleaseStatuses),
  revisions: z.array(helmReleaseRevisionSchema).min(1).max(16),
}).strict();
export type HelmReleaseEntry = z.infer<typeof helmReleaseEntrySchema>;
export const helmReleaseRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('read'), selection: configSelectionSchema, target: targetSchema, namespace: namespaceName }).strict(),
  // helmGet (approved D-01 read half): full decoded detail of ONE release's newest revision.
  z.object({ protocol: z.literal(2), kind: z.literal('detail'), selection: configSelectionSchema, target: targetSchema, namespace: namespaceName, release: boundedName.max(253) }).strict(),
]);
export type HelmReleaseRequest = z.infer<typeof helmReleaseRequestSchema>;
export const helmReleaseResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('releases'), target: targetSchema, namespace: namespaceName,
    releases: z.array(helmReleaseEntrySchema).max(100), truncated: z.boolean() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('release-detail'), target: targetSchema, namespace: namespaceName, release: boundedName.max(253),
    revision: helmReleaseRevisionSchema, manifest: z.string().max(1_048_576).optional(), config: z.string().max(65_536).optional(), hooks: z.string().max(65_536).optional(), description: z.string().max(1024).optional() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('releases-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmReleaseResponse = z.infer<typeof helmReleaseResponseSchema>;
// Pure grouping rule: newest revision first, at most the 16 newest revisions per release are
// exposed (older history stays readable through `helm history` in the human package).
export function groupHelmReleases(revisions: readonly { name: string; namespace: string; revision: number; status: (typeof helmReleaseStatuses)[number]; chartName: string; chartVersion: string; appVersion?: string | undefined; lastDeployed?: string | undefined; uid: string; resourceVersion: string }[]): { readonly releases: readonly HelmReleaseEntry[]; readonly truncated: boolean } {
  const byName = new Map<string, { name: string; namespace: string; revision: number; status: (typeof helmReleaseStatuses)[number]; chartName: string; chartVersion: string; appVersion?: string | undefined; lastDeployed?: string | undefined; uid: string; resourceVersion: string }[]>();
  for (const revision of revisions) {
    const existing = byName.get(revision.name) ?? [];
    byName.set(revision.name, [...existing, revision]);
  }
  const releases: HelmReleaseEntry[] = [];
  for (const [name, grouped] of byName) {
    const sorted = [...grouped].sort((a, b) => b.revision - a.revision);
    const current = sorted[0];
    if (!current) continue;
    const capped = sorted.slice(0, 16).map(revision => ({
      revision: revision.revision, status: revision.status, chartName: revision.chartName, chartVersion: revision.chartVersion,
      ...(revision.appVersion !== undefined ? { appVersion: revision.appVersion } : {}),
      ...(revision.lastDeployed !== undefined ? { lastDeployed: revision.lastDeployed } : {}),
      uid: revision.uid, resourceVersion: revision.resourceVersion,
    }));
    releases.push({ name, namespace: current.namespace, currentRevision: current.revision, currentStatus: current.status, revisions: capped } satisfies HelmReleaseEntry);
  }
  releases.sort((a, b) => a.name.localeCompare(b.name));
  const truncated = [...byName.values()].some(grouped => grouped.length > 16) || byName.size > 100;
  return { releases: Object.freeze(releases.slice(0, 100)), truncated };
}

// Merges already-grouped Helm release entries across paginated tree reads (RX-D4).
export function mergeHelmReleaseEntries(existing: readonly HelmReleaseEntry[], incoming: readonly HelmReleaseEntry[]): { readonly releases: readonly HelmReleaseEntry[]; readonly truncated: boolean } {
  const flat: { name: string; namespace: string; revision: number; status: (typeof helmReleaseStatuses)[number]; chartName: string; chartVersion: string; appVersion?: string | undefined; lastDeployed?: string | undefined; uid: string; resourceVersion: string }[] = [];
  const seen = new Set<string>();
  for (const entry of [...existing, ...incoming]) {
    for (const rev of entry.revisions) {
      const key = `${entry.namespace}/${entry.name}/${rev.revision}/${rev.uid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      flat.push({
        name: entry.name, namespace: entry.namespace, revision: rev.revision, status: rev.status,
        chartName: rev.chartName, chartVersion: rev.chartVersion,
        ...(rev.appVersion !== undefined ? { appVersion: rev.appVersion } : {}),
        ...(rev.lastDeployed !== undefined ? { lastDeployed: rev.lastDeployed } : {}),
        uid: rev.uid, resourceVersion: rev.resourceVersion,
      });
    }
  }
  return groupHelmReleases(flat);
}

// ---- Approved D-01 write half: install / rollback / uninstall via the zero-materialisation
// CLI transport (--kube-apiserver argv + HELM_KUBETOKEN memory env + public CA temp file) ----
export const helmWriteAction = z.enum(['install', 'rollback', 'uninstall']);
export const helmWriteParametersSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('install'), release: boundedName.max(253), chart: z.string().min(1).max(512).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[0-9][^/]*)?(?:@[0-9][^/]*)?$/),
    chartVersion: z.string().min(1).max(64).optional(), values: z.string().max(32_768).optional() }).strict(),
  z.object({ action: z.literal('rollback'), release: boundedName.max(253), revision: z.number().int().min(1).max(1_000_000),
    provenanceUid: boundedName, provenanceResourceVersion: boundedName }).strict(),
  z.object({ action: z.literal('uninstall'), release: boundedName.max(253), provenanceUid: boundedName, provenanceResourceVersion: boundedName }).strict(),
]).and(z.object({ namespace: namespaceName }).strict());
export type HelmWriteParameters = z.infer<typeof helmWriteParametersSchema>;
export const helmWriteViewGrantSchema = z.object({ id: z.string().uuid(), capability: z.string().regex(/^[a-f0-9]{64}$/), serviceGeneration: z.string().uuid(), expiresAt: z.number().int().nonnegative() }).strict();
export type HelmWriteViewGrant = z.infer<typeof helmWriteViewGrantSchema>;
export const helmWriteOutcomeSchema = z.object({ id: z.string().uuid(), owner: z.string().uuid(), step: z.literal('helm-cluster-write'), dependencies: z.tuple([]), target: targetSchema, parameters: helmWriteParametersSchema,
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: z.enum(['prepared', 'queued', 'checking', 'dispatching', 'accepted', 'failed', 'unknown', 'cancelled']), code: z.enum(errorCodes).optional(),
  stdoutTail: z.string().max(2_048).optional() }).strict()
  .refine(value => value.phase !== 'accepted' || value.code === undefined);
export type HelmWriteOutcome = z.infer<typeof helmWriteOutcomeSchema>;
export const helmWriteRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('open'), selection: configSelectionSchema, target: targetSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('prepare'), grant: helmWriteViewGrantSchema, parameters: helmWriteParametersSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('submit'), grant: helmWriteViewGrantSchema, id: z.string().uuid(), proof: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal('helm-cluster-write-exact-release') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('cancel'), grant: helmWriteViewGrantSchema, id: z.string().uuid() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('close'), grant: helmWriteViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), after: z.string().uuid().optional() }).strict(),
]);
export type HelmWriteRequest = z.infer<typeof helmWriteRequestSchema>;
export const helmWriteResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('view'), grant: helmWriteViewGrantSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('confirmation'), outcome: helmWriteOutcomeSchema, proof: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcome'), outcome: helmWriteOutcomeSchema }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('closed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('outcomes'), serviceGeneration: z.string().uuid(), outcomes: z.array(helmWriteOutcomeSchema).max(16), next: z.string().uuid().nullable() }).strict(),
]);
export type HelmWriteResponse = z.infer<typeof helmWriteResponseSchema>;
