import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import { apiGroup, apiVersion, boundedName, readTarget, sameTarget } from '../../shared/identity.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { readResponseJson, readResponseText } from './bounded-response.ts';
import type { ReadResponse } from './bounded-response.ts';
import { projectApiGroup, projectCustomResourceDefinition, projectDefinitionFolderPage } from './custom-resources.ts';
import { definitionReferenceSchema, referenceKey } from '../../shared/branch-protocol.ts';
import { crdType, planParentResource, projectParentResource, resourceObjectPath, verifyResourceObject } from './parent-resource.ts';
import { ReadScheduler } from './read-scheduler.ts';
import { apiDiscoveryPath, planResourceList, projectDiscovery, projectResourcePage } from './resource-query.ts';
import { planConfigurationValue, projectConfigurationValue } from './configuration-value.ts';
import type { ConfigurationValue } from './configuration-value.ts';
import type { KeyContentResponse } from '../../shared/key-content-protocol.ts';
import { logBytes, logOptionsSchema } from '../../shared/pod-log-protocol.ts';
import type { JobLogOrigin, PodLogReference } from '../../shared/pod-log-protocol.ts';
import { logRuntimeIdentity, planPodLogReference, projectLogContainers } from './pod-log-source.ts';
import { jobLogMembership } from './job-log-source.ts';
import { projectEventNamespace, projectEventPage } from './event-source.ts';
import type { EventSourcePage } from './event-source.ts';
import { eventCollectionPath, eventPageLimit } from '../../shared/event-protocol.ts';
import type { EventApiVersion, EventScope, NamespaceReference } from '../../shared/event-protocol.ts';
import type { DocumentPage, DocumentReference, LoadDocumentReference } from '../../shared/document-protocol.ts';
import { planResourceDocument, projectResourceDocument } from './resource-document.ts';
import { planLoadDocument, customDocumentProof } from './custom-document.ts';
import { collectNamespaceInventory, inventoryDigest } from './namespace-inventory.ts';
import type { NamespaceDeleteReference, NamespaceInventory } from '../../shared/namespace-inventory.ts';
import { inspectionBytes } from '../../shared/inspection-protocol.ts';
import type { InspectionPage, InspectionReference } from '../../shared/inspection-protocol.ts';
import { readCustomInspection } from './custom-inspection.ts';
import { captureInspectionReference } from './inspection-reference.ts';
import { explainResponseSchema, openApiSchemaBytes } from '../../shared/explain-protocol.ts';
import type { ExplainRequest, ExplainResponse } from '../../shared/explain-protocol.ts';
import { openApiLocation, projectExplanation } from './openapi-explanation.ts';
import { readCustomExplanation } from './custom-explanation.ts';
import { logFollowProof } from './log-follow-source.ts';
import type { LogFollowSource } from '../../shared/log-follow-protocol.ts';
import type { JobLogSelectionSource } from '../../shared/job-log-selection-protocol.ts';
import { jobLogSelector, projectJobLogCandidate, projectJobLogCandidatePage } from './job-log-selection-source.ts';
import type { CustomWatchReference, WatchSource } from '../../shared/watch-protocol.ts';
import { planWatchRelist, projectWatchRelist } from './watch-relist.ts';
import { readCustomWatchProof } from './custom-watch.ts';
import { readManifestComparison, resolveManifestComparison } from './manifest-comparison.ts';
import { readManifestCreateProof } from './manifest-create-proof.ts';
import { readApplyFileDocumentProbe } from './apply-file-proof.ts';
import { readForwardTarget } from './forward-target.ts';
import type { ForwardOriginal, ResolvedForwardPod } from './forward-target.ts';
import { readHelmReleaseRevisions, readHelmReleaseSecretPage } from './helm-release-secret.ts';
import type { HelmReleaseRevisions, HelmReleaseSecretPage } from './helm-release-secret.ts';
import type { ApplyFileDocumentProbe } from './apply-file-proof.ts';
import { readManifestApplySnapshot } from './manifest-apply-snapshot.ts';
import type { ManifestApplySnapshot } from './manifest-apply-snapshot.ts';
import type { ManifestComparison } from './manifest-comparison.ts';
import type { ManifestLocator, ManifestComparisonReference, ManifestDiffPage } from '../../shared/manifest-diff-protocol.ts';

export type ResourceReadRequest = {
  readonly method: 'GET'; readonly purpose: 'resource-list' | 'api-version' | 'api-group' | 'api-root' | 'namespace-inventory' | 'custom-resource-definitions' | 'resource-object' | 'custom-document' | 'custom-wide' | 'custom-describe' | 'custom-resource-watch' | 'custom-resource-relist' | 'pod-logs' | 'namespace-events' | 'resource-wide' | 'resource-describe' | 'cluster-info' | 'openapi-index' | 'openapi-schema' | 'resource-watch' | 'pod-log-follow' | 'namespace-event-watch' | 'job-pod-watch' | 'manifest-diff' | 'manifest-create-proof' | 'helm-releases';
  readonly target: TargetIdentity; readonly path: string; readonly query: Readonly<Record<string, string>>; readonly maximumBytes: 2_000_000 | 8_000_000;
  readonly representation?: 'metadata-preferred';
  readonly customList?: { readonly type: ResourcePage['type']; readonly definition: z.infer<typeof definitionReferenceSchema> };
  readonly customDocument?: LoadDocumentReference | undefined;
  readonly customInspection?: InspectionReference | undefined;
  readonly customWatch?: CustomWatchReference | undefined;
  readonly comparison?: ManifestComparisonReference | undefined;
  readonly createReference?: ManifestComparisonReference | undefined;
};
// The adapter must be reviewed separately for auth/cache/config side effects. No adapter is
// created, authenticated or called on construction; no generic URL/command API is exposed.
export type ResourceReadTransport = (request: ResourceReadRequest, signal: AbortSignal) => Promise<ReadResponse>;
type ResourcePage = ReturnType<typeof projectResourcePage>;
type Result = { readonly kind: 'resources'; readonly page: ResourcePage }
  | { readonly kind: 'empty-selector'; readonly target: TargetIdentity; readonly type: ResourcePage['type']; readonly nodes: readonly [] }
  | { readonly kind: 'version'; readonly types: ReturnType<typeof projectDiscovery> }
  | { readonly kind: 'group'; readonly group: ReturnType<typeof projectApiGroup> }
  | { readonly kind: 'definitions'; readonly page: ReturnType<typeof projectDefinitionFolderPage> }
  | { readonly kind: 'parent'; readonly parent: ReturnType<typeof projectParentResource> }
  | { readonly kind: 'definition'; readonly definition: ReturnType<typeof projectCustomResourceDefinition> }
  | { readonly kind: 'key-content'; readonly page: KeyContentResponse }
  | { readonly kind: 'log-containers'; readonly containers: ReturnType<typeof projectLogContainers> }
  | { readonly kind: 'pod-log-text'; readonly text: string; readonly runtime: string }
  | { readonly kind: 'pod-log-runtime'; readonly runtime: string }
  | { readonly kind: 'event-page'; readonly page: EventSourcePage }
  | { readonly kind: 'document'; readonly page: DocumentPage }
  | { readonly kind: 'reference-verified' }
  | { readonly kind: 'watch-relist'; readonly resourceVersion: string }
  | { readonly kind: 'custom-watch-proof'; readonly proof: string }
  | { readonly kind: 'inspection'; readonly page: InspectionPage }
  | { readonly kind: 'explanation'; readonly page: ExplainResponse }
  | { readonly kind: 'job-candidates'; readonly page: ReturnType<typeof projectJobLogCandidatePage>; readonly selector: string }
  | { readonly kind: 'job-selected'; readonly reference: PodLogReference | undefined; readonly origin: JobLogOrigin }
  | { readonly kind: 'namespace-inventory'; readonly inventory: NamespaceInventory }
  | { readonly kind: 'manifest-diff'; readonly page: ManifestDiffPage }
  | { readonly kind: 'create-proof'; readonly reference: ManifestComparisonReference }
  | { readonly kind: 'apply-snapshot'; readonly value: ManifestApplySnapshot }
  | { readonly kind: 'apply-file-probe'; readonly probe: ApplyFileDocumentProbe }
  | { readonly kind: 'locator-resolution'; readonly reference: ManifestComparisonReference }
  | { readonly kind: 'forward-target'; readonly pod: ResolvedForwardPod }
  | { readonly kind: 'helm-releases'; readonly value: HelmReleaseRevisions }
  | { readonly kind: 'helm-releases-page'; readonly value: HelmReleaseSecretPage };

function freezeResult(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeResult(child);
    Object.freeze(value);
  }
}
const versionRequest = z.object({ target: z.unknown(), group: apiGroup, version: apiVersion }).strict();
const groupRequest = z.object({ target: z.unknown(), group: apiGroup.refine(value => !!value) }).strict();
const definitionsRequest = z.object({ target: z.unknown(), limit: z.number().int().min(1).max(100).default(100), continue: z.string().default(''), resourceVersion: boundedName.optional() }).strict();
const parentRequest = z.object({ target: z.unknown(), parent: z.unknown(), offset: z.number().int().min(0).max(2000).default(0) }).strict();
const definitionRequest = z.object({ target: z.unknown(), definition: definitionReferenceSchema }).strict();

export function createResourceReader(options: {
  serviceGeneration: string; read: ResourceReadTransport;
  // Resolves the current server snapshot; never trust panel-supplied target as authenticated owner.
  currentTarget: (target: TargetIdentity, signal: AbortSignal) => Promise<TargetIdentity>;
}) {
  if (!boundedName.safeParse(options.serviceGeneration).success) throw new BoundaryError('INVALID_INPUT');
  const { serviceGeneration, read, currentTarget } = options;
  const inventoryKey = randomBytes(32);
  const scheduler = new ReadScheduler<Result>({ concurrency: 2, queued: 16, consumers: 64, timeoutMs: 12_000 });
  async function verify(target: TargetIdentity, signal: AbortSignal) {
    if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
    if (target.serviceGeneration !== serviceGeneration || !sameTarget(readTarget(await currentTarget(target, signal)), target)) throw new BoundaryError('STALE_TARGET');
    if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
  }
  async function run(target: TargetIdentity, key: readonly string[], request: ResourceReadRequest | null,
    project: (value: unknown) => Result, signal?: AbortSignal): Promise<Result> {
    return scheduler.run(key, async sharedSignal => {
      await verify(target, sharedSignal);
      const value = request ? await readResponseJson(await read(request, sharedSignal), sharedSignal) : null;
      await verify(target, sharedSignal); // Configuration/context changes invalidate even an otherwise valid page.
      const result = project(value);
      if (Buffer.byteLength(JSON.stringify(result)) > 480_000) throw new BoundaryError('BUDGET_EXCEEDED');
      freezeResult(result); // In-flight consumers share immutable DTOs, never raw resource objects.
      return result;
    }, signal ? { signal } : {});
  }
  function request(target: TargetIdentity, purpose: ResourceReadRequest['purpose'], path: string, query: Readonly<Record<string, string>> = {}): ResourceReadRequest {
    return Object.freeze({ method: 'GET', target, purpose, path, query: Object.freeze({ ...query }), maximumBytes: purpose === 'openapi-schema' ? openApiSchemaBytes : 2_000_000 });
  }
  function key(target: TargetIdentity, ...parts: string[]): readonly string[] {
    return [target.serviceGeneration, target.projectId, target.configIdentity, target.context, target.namespace, ...parts];
  }
  async function logMetadata(target: TargetIdentity, reference: PodLogReference, signal: AbortSignal, origin: JobLogOrigin | undefined,
    project: (pod: unknown, proof: string) => Result): Promise<Result> {
    const plan = planPodLogReference(reference, readTarget(target)), job = origin ? planParentResource(origin, target) : undefined;
    if (origin && origin.namespace !== reference.namespace) throw new BoundaryError('STALE_TARGET');
    return scheduler.run(key(target, 'pod-log-metadata', randomUUID()), async sharedSignal => {
      await verify(target, sharedSignal);
      const get = async (path: string) => readResponseJson(await read(request(target, 'resource-object', path), sharedSignal), sharedSignal);
      const before = job ? await get(job.path) : undefined;
      const pod = await get(plan.path);
      const proof = origin ? jobLogMembership(before, pod, target, origin, reference) : '';
      const result = project(pod, proof);
      if (job && origin && jobLogMembership(await get(job.path), pod, target, origin, reference) !== proof) throw new BoundaryError('STALE_TARGET');
      await verify(target, sharedSignal); freezeResult(result); return result;
    }, { signal });
  }
  async function eventFollowJson(input: ResourceReadRequest, signal: AbortSignal, budget: { bytes: number; reads: number }) {
    if (++budget.reads > 256 || budget.bytes >= 8_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
    const text = await readResponseText(await read(input, signal), signal, Math.min(2_000_000, 8_000_000 - budget.bytes)); budget.bytes += Buffer.byteLength(text);
    try { return JSON.parse(text) as unknown; } catch { throw new BoundaryError('RESOURCE_INVALID'); }
  }
  function selectionJob(job: unknown, source: JobLogSelectionSource, budget: { jobVerified?: boolean }): JobLogSelectionSource {
    const parsed = z.object({ metadata: z.object({ resourceVersion: boundedName }) }).safeParse(job); if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID');
    const value = budget.jobVerified ? { ...source, origin: { ...source.origin, resourceVersion: parsed.data.metadata.resourceVersion } } : source;
    jobLogSelector(job, value); budget.jobVerified = true; return value; // First exact RV, later same UID/selector is checked by caller.
  }
  return {
    async captureManifestApply(target: TargetIdentity, reference: unknown, signal: AbortSignal, expect: 'live' | 'missing') {
      const result = await scheduler.run(key(target, 'apply-snapshot', randomUUID()), async sharedSignal => {
        const value = await readManifestApplySnapshot(target, reference, sharedSignal, read, () => verify(target, sharedSignal), expect); freezeResult(value); return { kind: 'apply-snapshot' as const, value };
      }, { signal }); if (result.kind !== 'apply-snapshot') throw new BoundaryError('STATE_UNAVAILABLE'); return result.value;
    },
    async helmReleases(target: TargetIdentity, signal: AbortSignal, releaseName?: string): Promise<HelmReleaseRevisions> {
      const result = await scheduler.run(key(target, 'helm-releases', randomUUID()), async sharedSignal => {
        const value = await readHelmReleaseRevisions(target, sharedSignal, read, () => verify(target, sharedSignal), releaseName); freezeResult(value); return { kind: 'helm-releases' as const, value };
      }, { signal }); if (result.kind !== 'helm-releases') throw new BoundaryError('STATE_UNAVAILABLE'); return result.value;
    },
    async helmReleasesPage(target: TargetIdentity, signal: AbortSignal, options: { readonly continueToken?: string; readonly releaseName?: string } = {}): Promise<HelmReleaseSecretPage> {
      const result = await scheduler.run(key(target, 'helm-releases-page', randomUUID()), async sharedSignal => {
        const value = await readHelmReleaseSecretPage(target, sharedSignal, read, () => verify(target, sharedSignal), options); freezeResult(value); return { kind: 'helm-releases-page' as const, value };
      }, { signal }); if (result.kind !== 'helm-releases-page') throw new BoundaryError('STATE_UNAVAILABLE'); return result.value;
    },
    async resolveForwardTarget(target: TargetIdentity, original: ForwardOriginal, signal: AbortSignal): Promise<ResolvedForwardPod> {
      const result = await scheduler.run(key(target, 'forward-target', randomUUID()), async sharedSignal => {
        const pod = await readForwardTarget(target, original, sharedSignal, read, () => verify(target, sharedSignal)); freezeResult(pod); return { kind: 'forward-target' as const, pod };
      }, { signal }); if (result.kind !== 'forward-target') throw new BoundaryError('STATE_UNAVAILABLE'); return result.pod;
    },
    async resolveLocator(target: TargetIdentity, locator: ManifestLocator, signal: AbortSignal): Promise<ManifestComparisonReference> {
      const result = await scheduler.run(key(target, 'locator-resolution', randomUUID()), async sharedSignal => {
        const value = await readResponseJson(await read({ method: 'GET', purpose: 'api-version', path: apiDiscoveryPath(locator.group, locator.version), query: {}, maximumBytes: 2_000_000, target }, sharedSignal), sharedSignal);
        const reference = resolveManifestComparison(value, locator, target);
        const candidates = projectDiscovery(value, ['get']);
        if (!reference || !candidates.some(type => JSON.stringify(type) === JSON.stringify(reference.type))) throw new BoundaryError('RESOURCE_INVALID');
        freezeResult(reference); return { kind: 'locator-resolution' as const, reference };
      }, { signal }); if (result.kind !== 'locator-resolution') throw new BoundaryError('STATE_UNAVAILABLE'); return result.reference;
    },
    async probeApplyFileDocument(target: TargetIdentity, locator: ManifestLocator, signal: AbortSignal): Promise<ApplyFileDocumentProbe> {
      const result = await scheduler.run(key(target, 'apply-file-probe', randomUUID()), async sharedSignal => {
        const probe = await readApplyFileDocumentProbe(target, locator, sharedSignal, read, () => verify(target, sharedSignal)); freezeResult(probe); return { kind: 'apply-file-probe' as const, probe };
      }, { signal }); if (result.kind !== 'apply-file-probe') throw new BoundaryError('STATE_UNAVAILABLE'); return result.probe;
    },
    async proveManifestCreate(target: TargetIdentity, locator: ManifestLocator, signal: AbortSignal): Promise<ManifestComparisonReference> {
      const result = await scheduler.run(key(target, 'create-proof', randomUUID()), async sharedSignal => {
        const reference = await readManifestCreateProof(target, locator, sharedSignal, read, () => verify(target, sharedSignal)); freezeResult(reference); return { kind: 'create-proof' as const, reference };
      }, { signal }); if (result.kind !== 'create-proof') throw new BoundaryError('STATE_UNAVAILABLE'); return result.reference;
    },
    async compareManifest(target: TargetIdentity, locator: ManifestLocator, format: 'yaml' | 'json', expectedUid: string | undefined, project: (value: ManifestComparison) => ManifestDiffPage, signal: AbortSignal): Promise<ManifestDiffPage> {
      const result = await scheduler.run(key(target, 'manifest-diff', randomUUID()), async sharedSignal => {
        const value = await readManifestComparison(target, locator, format, expectedUid, sharedSignal, read, () => verify(target, sharedSignal));
        const page = project(value); if (Buffer.byteLength(JSON.stringify(page)) > 480_000) throw new BoundaryError('BUDGET_EXCEEDED'); freezeResult(page); return { kind: 'manifest-diff' as const, page };
      }, { signal }); if (result.kind !== 'manifest-diff') throw new BoundaryError('STATE_UNAVAILABLE'); return result.page;
    },
    async comparisonSnapshot(target: TargetIdentity, project: () => ManifestDiffPage, signal: AbortSignal): Promise<ManifestDiffPage> {
      const result = await scheduler.run(key(target, 'manifest-diff-snapshot', randomUUID()), async sharedSignal => {
        await verify(target, sharedSignal); const page = project(); await verify(target, sharedSignal); freezeResult(page); return { kind: 'manifest-diff' as const, page };
      }, { signal }); if (result.kind !== 'manifest-diff') throw new BoundaryError('STATE_UNAVAILABLE'); return result.page;
    },
    async verifyCustomWatch(source: WatchSource, signal: AbortSignal, budget: { bytes: number; reads: number }, initial: boolean): Promise<string> {
      const result = await scheduler.run(key(source.target, 'custom-watch-proof', randomUUID()), async sharedSignal => ({ kind: 'custom-watch-proof' as const,
        proof: await readCustomWatchProof(source, sharedSignal, read, verify, budget, initial) }), { signal });
      if (result.kind !== 'custom-watch-proof') throw new BoundaryError('STATE_UNAVAILABLE'); return result.proof;
    },
    async watchRelist(source: WatchSource, signal: AbortSignal, budget: { bytes: number; reads: number }): Promise<string> {
      const result = await scheduler.run(key(source.target, 'watch-relist', randomUUID()), async sharedSignal => {
        let continuation = '', resourceVersion: string | undefined; const tokens = new Set<string>(), names = new Set<string>(), uids = new Set<string>();
        for (let page = 0; page < 20; page++) {
          await verify(source.target, sharedSignal);
          if (budget.reads >= 30) throw new BoundaryError('BUDGET_EXCEEDED');
          const input = planWatchRelist(source, continuation), value = projectWatchRelist(await eventFollowJson(input, sharedSignal, budget), source);
          await verify(source.target, sharedSignal);
          if (resourceVersion !== undefined && resourceVersion !== value.resourceVersion) throw new BoundaryError('STALE_TARGET'); resourceVersion = value.resourceVersion;
          for (const identity of value.identities) {
            if (names.has(identity.name) || uids.has(identity.uid)) throw new BoundaryError('RESOURCE_INVALID'); names.add(identity.name); uids.add(identity.uid);
          }
          if (!value.continuation) {
            if (source.object && names.size !== 1) throw new BoundaryError('NOT_FOUND');
            return { kind: 'watch-relist' as const, resourceVersion };
          }
          if (tokens.has(value.continuation)) throw new BoundaryError('RESOURCE_INVALID'); tokens.add(value.continuation); continuation = value.continuation;
        }
        throw new BoundaryError('BUDGET_EXCEEDED');
      }, { signal });
      if (result.kind !== 'watch-relist') throw new BoundaryError('STATE_UNAVAILABLE'); return result.resourceVersion;
    },
    async jobLogCandidates(source: JobLogSelectionSource, signal: AbortSignal, budget: { bytes: number; reads: number; jobVerified?: boolean }, previous?: { resourceVersion: string; continuation: string; selector: string }) {
      const result = await scheduler.run(key(source.target, 'job-log-candidates', randomUUID()), async sharedSignal => {
        const { target, origin } = source; await verify(target, sharedSignal);
        const get = (input: ResourceReadRequest) => eventFollowJson(input, sharedSignal, budget), path = planParentResource(origin, target).path;
        const job = await get(request(target, 'resource-object', path)), current = selectionJob(job, source, budget), selector = jobLogSelector(job, current);
        if (previous && selector !== previous.selector) throw new BoundaryError('STALE_TARGET');
        const page = projectJobLogCandidatePage(await get(request(target, 'resource-list', `/api/v1/namespaces/${origin.namespace}/pods`, { limit: '100', labelSelector: selector, ...(previous ? { continue: previous.continuation } : {}) })), job, current);
        const after = await get(request(target, 'resource-object', path));
        if (previous && page.resourceVersion !== previous.resourceVersion || jobLogSelector(after, selectionJob(after, source, budget)) !== selector) throw new BoundaryError('STALE_TARGET');
        await verify(target, sharedSignal); freezeResult(page); return { kind: 'job-candidates' as const, page, selector };
      }, { signal });
      if (result.kind !== 'job-candidates') throw new BoundaryError('STATE_UNAVAILABLE'); return { ...result.page, selector: result.selector };
    },
    async verifyJobLogSelection(source: JobLogSelectionSource, signal: AbortSignal, budget: { bytes: number; reads: number; jobVerified?: boolean }, selector: string, reference?: PodLogReference, raw?: unknown) {
      const result = await scheduler.run(key(source.target, 'job-log-selection-proof', randomUUID()), async sharedSignal => {
        const { target, origin } = source; await verify(target, sharedSignal);
        const get = (input: ResourceReadRequest) => eventFollowJson(input, sharedSignal, budget), path = planParentResource(origin, target).path;
        const job = await get(request(target, 'resource-object', path)), current = selectionJob(job, source, budget); if (jobLogSelector(job, current) !== selector) throw new BoundaryError('STALE_TARGET');
        const selected = raw === undefined ? reference : projectJobLogCandidate(raw, job, current).reference;
        if (selected) { const pod = await get(request(target, 'resource-object', planPodLogReference(selected, target).path)); jobLogMembership(job, pod, target, current.origin, selected); }
        const after = await get(request(target, 'resource-object', path)), latest = selectionJob(after, source, budget);
        if (jobLogSelector(after, latest) !== selector) throw new BoundaryError('STALE_TARGET');
        await verify(target, sharedSignal); return { kind: 'job-selected' as const, reference: selected, origin: latest.origin };
      }, { signal });
      if (result.kind !== 'job-selected') throw new BoundaryError('STATE_UNAVAILABLE'); return { reference: result.reference, origin: result.origin };
    },
    async verifyEventFollowNamespace(target: TargetIdentity, namespace: NamespaceReference, signal: AbortSignal, initial: boolean, budget: { bytes: number; reads: number }) {
      const result = await scheduler.run(key(target, 'event-follow-namespace', randomUUID()), async sharedSignal => {
        await verify(target, sharedSignal);
        const current = projectEventNamespace(await eventFollowJson(request(target, 'resource-object', `/api/v1/namespaces/${namespace.name}`), sharedSignal, budget), namespace.name, initial ? namespace : undefined);
        if (current.uid !== namespace.uid) throw new BoundaryError('STALE_TARGET');
        await verify(target, sharedSignal); return { kind: 'reference-verified' as const };
      }, { signal });
      if (result.kind !== 'reference-verified') throw new BoundaryError('STATE_UNAVAILABLE');
    },
    async eventFollowPage(target: TargetIdentity, namespace: NamespaceReference, signal: AbortSignal, budget: { bytes: number; reads: number }, apiVersion: EventApiVersion, previous?: { resourceVersion: string; continuation: string }) {
      const result = await scheduler.run(key(target, 'event-follow-list', randomUUID()), async sharedSignal => {
        await verify(target, sharedSignal);
        const input = request(target, 'namespace-events', eventCollectionPath(apiVersion, namespace.name), { limit: String(eventPageLimit), ...(previous ? { continue: previous.continuation } : {}) });
        const page = projectEventPage(await eventFollowJson(input, sharedSignal, budget), namespace, previous, apiVersion);
        await verify(target, sharedSignal); freezeResult(page); return { kind: 'event-page' as const, page };
      }, { signal });
      if (result.kind !== 'event-page') throw new BoundaryError('STATE_UNAVAILABLE'); return result.page;
    },
    async followRuntime(source: LogFollowSource, signal: AbortSignal, initial: boolean, budget: { bytes: number; reads: number }): Promise<string> {
      const { target } = source, pod = planPodLogReference(source.reference, target), job = source.origin ? planParentResource(source.origin, target) : undefined;
      const result = await scheduler.run(key(target, 'follow-runtime', randomUUID()), async sharedSignal => {
        await verify(target, sharedSignal);
        const get = async (path: string) => {
          if (++budget.reads > 512) throw new BoundaryError('BUDGET_EXCEEDED');
          const text = await readResponseText(await read(request(target, 'resource-object', path), sharedSignal), sharedSignal);
          if ((budget.bytes += Buffer.byteLength(text)) > 16_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
          try { return JSON.parse(text) as unknown; } catch { throw new BoundaryError('RESOURCE_INVALID'); }
        };
        const beforeJob = job ? await get(job.path) : undefined, currentPod = await get(pod.path), runtime = logFollowProof(currentPod, beforeJob, source, initial);
        if (job && logFollowProof(currentPod, await get(job.path), source, initial) !== runtime) throw new BoundaryError('STALE_TARGET');
        await verify(target, sharedSignal); return { kind: 'pod-log-runtime' as const, runtime };
      }, { signal });
      if (result.kind !== 'pod-log-runtime') throw new BoundaryError('STATE_UNAVAILABLE'); return result.runtime;
    },
    async explain(input: ExplainRequest, signal: AbortSignal): Promise<ExplainResponse> {
      const { target } = input;
      const result = await scheduler.run(key(target, 'explain', randomUUID()), async sharedSignal => {
        if (input.definition) {
          const value = await readCustomExplanation(input, sharedSignal, read, verify);
          const page = explainResponseSchema.parse({ protocol: 2, kind: 'field-explanation', target, type: input.type, definition: input.definition, fieldPath: input.fieldPath,
            documentIdentity: input.documentIdentity, revision: input.revision, ...value });
          if (Buffer.byteLength(JSON.stringify(page)) > 64_000) throw new BoundaryError('BUDGET_EXCEEDED');
          freezeResult(page); return { kind: 'explanation' as const, page };
        }
        await verify(target, sharedSignal);
        const index = async () => openApiLocation(await readResponseJson(await read(request(target, 'openapi-index', '/openapi/v3'), sharedSignal), sharedSignal), input.type);
        const before = await index();
        const schema = await readResponseJson(await read(request(target, 'openapi-schema', before.path, before.query), sharedSignal), sharedSignal, openApiSchemaBytes);
        const explanation = projectExplanation(schema, input);
        if ((await index()).identity !== before.identity) throw new BoundaryError('STALE_TARGET');
        await verify(target, sharedSignal);
        const page = explainResponseSchema.parse({ protocol: 2, kind: 'field-explanation', target, type: input.type, fieldPath: input.fieldPath,
          documentIdentity: input.documentIdentity, revision: input.revision, schemaIdentity: before.identity, explanation });
        if (Buffer.byteLength(JSON.stringify(page)) > 64_000) throw new BoundaryError('BUDGET_EXCEEDED');
        freezeResult(page); return { kind: 'explanation' as const, page };
      }, { signal });
      if (result.kind !== 'explanation') throw new BoundaryError('STATE_UNAVAILABLE'); return result.page;
    },
    async verifyTarget(target: TargetIdentity, signal: AbortSignal): Promise<void> {
      const result = await run(target, key(target, 'verify-inspection-target', randomUUID()), null, () => ({ kind: 'reference-verified' }), signal);
      if (result.kind !== 'reference-verified') throw new BoundaryError('STATE_UNAVAILABLE');
    },
    async clusterInfo(target: TargetIdentity, project: (text: string) => InspectionPage, signal: AbortSignal): Promise<InspectionPage> {
      const result = await scheduler.run(key(target, 'cluster-info', randomUUID()), async sharedSignal => {
        await verify(target, sharedSignal);
        // Fixed CLI semantics: list cluster-service Services in kube-system, never the browsing namespace or a dump/proxy.
        const text = await readResponseText(await read(request(target, 'cluster-info', '/api/v1/namespaces/kube-system/services'), sharedSignal), sharedSignal, inspectionBytes);
        await verify(target, sharedSignal);
        const page = project(text); if (Buffer.byteLength(JSON.stringify(page)) > 480_000) throw new BoundaryError('BUDGET_EXCEEDED');
        freezeResult(page); return { kind: 'inspection' as const, page };
      }, { signal });
      if (result.kind !== 'inspection') throw new BoundaryError('STATE_UNAVAILABLE'); return result.page;
    },
    async inspect(target: TargetIdentity, reference: InspectionReference, mode: 'wide' | 'describe', project: (text: string, reference?: InspectionReference) => InspectionPage, signal: AbortSignal, refresh = false): Promise<InspectionPage> {
      if ((mode !== 'wide' && mode !== 'describe') || typeof refresh !== 'boolean') throw new BoundaryError('INVALID_INPUT');
      if ('definition' in reference) {
        const result = await scheduler.run(key(target, 'custom-inspection', randomUUID()), async sharedSignal => {
          const value = await readCustomInspection(readTarget(target), reference, sharedSignal, read, verify, mode, refresh);
          const page = project(value.text, value.reference); if (Buffer.byteLength(JSON.stringify(page)) > 480_000) throw new BoundaryError('BUDGET_EXCEEDED');
          freezeResult(page); return { kind: 'inspection' as const, page };
        }, { signal });
        if (result.kind !== 'inspection') throw new BoundaryError('STATE_UNAVAILABLE'); return result.page;
      }
      const plan = planResourceDocument(reference, readTarget(target));
      const result = await scheduler.run(key(target, 'inspection', randomUUID()), async sharedSignal => {
        await verify(target, sharedSignal);
        const current = captureInspectionReference(await readResponseJson(await read(request(target, 'resource-object', plan.path), sharedSignal), sharedSignal), plan.reference, refresh);
        const text = await readResponseText(await read(request(target, mode === 'wide' ? 'resource-wide' : 'resource-describe', plan.path), sharedSignal), sharedSignal, inspectionBytes);
        verifyResourceObject(await readResponseJson(await read(request(target, 'resource-object', plan.path), sharedSignal), sharedSignal), current.type, current);
        await verify(target, sharedSignal);
        const page = project(text, current); if (Buffer.byteLength(JSON.stringify(page)) > 480_000) throw new BoundaryError('BUDGET_EXCEEDED');
        freezeResult(page); return { kind: 'inspection' as const, page };
      }, { signal });
      if (result.kind !== 'inspection') throw new BoundaryError('STATE_UNAVAILABLE'); return result.page;
    },
    async namespaceInventory(target: TargetIdentity, reference: NamespaceDeleteReference, signal: AbortSignal): Promise<NamespaceInventory> {
      const plan = planResourceDocument(reference, readTarget(target));
      const result = await scheduler.run(key(target, 'namespace-inventory', randomUUID()), async sharedSignal => {
        await verify(target, sharedSignal);
        const check = async () => verifyResourceObject(await readResponseJson(await read(request(target, 'resource-object', plan.path), sharedSignal), sharedSignal), reference.type, reference);
        await check();
        const budget = AbortSignal.timeout(6000), contentSignal = AbortSignal.any([sharedSignal, budget]); let inventory: NamespaceInventory;
        let reads = 0, bytes = 0;
        try {
          const summary = await collectNamespaceInventory(reference, inventoryKey, async (path, query = {}) => {
            if (++reads > 162) throw new BoundaryError('BUDGET_EXCEEDED');
            const purpose = path === '/apis' ? 'api-root' : Object.keys(query).length ? 'namespace-inventory' : 'api-version';
            const text = await readResponseText(await read(request(target, purpose, path, query), contentSignal), contentSignal);
            bytes += Buffer.byteLength(text); if (bytes > 8_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
            try { return JSON.parse(text) as unknown; } catch { throw new BoundaryError('RESOURCE_INVALID'); }
          });
          inventory = { reference, status: 'complete', ...summary };
        } catch (error) {
          if (sharedSignal.aborted) throw new BoundaryError('QUERY_CANCELLED');
          const code = budget.aborted ? 'QUERY_TIMEOUT' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE';
          inventory = { reference, status: 'unknown', count: null, types: 0, digest: inventoryDigest(inventoryKey, [reference, 'unknown', code]), code };
        }
        await check(); await verify(target, sharedSignal); freezeResult(inventory); return { kind: 'namespace-inventory' as const, inventory };
      }, { signal });
      if (result.kind !== 'namespace-inventory') throw new BoundaryError('STATE_UNAVAILABLE'); return result.inventory;
    },
    async verifyReference(target: TargetIdentity, reference: DocumentReference, signal: AbortSignal): Promise<void> {
      const plan = planResourceDocument(reference, readTarget(target));
      const result = await run(target, key(target, 'verify-reference', randomUUID()), request(target, 'resource-object', plan.path), value => {
        verifyResourceObject(value, plan.reference.type, plan.reference); return { kind: 'reference-verified' };
      }, signal);
      if (result.kind !== 'reference-verified') throw new BoundaryError('STATE_UNAVAILABLE');
    },
    async verifyCustomInspection(target: TargetIdentity, reference: InspectionReference, signal: AbortSignal): Promise<void> {
      const result = await scheduler.run(key(target, 'verify-custom-inspection', randomUUID()), async sharedSignal => {
        await readCustomInspection(readTarget(target), reference, sharedSignal, read, verify); return { kind: 'reference-verified' as const };
      }, { signal });
      if (result.kind !== 'reference-verified') throw new BoundaryError('STATE_UNAVAILABLE');
    },
    async document(target: TargetIdentity, reference: LoadDocumentReference, format: 'yaml' | 'json', project: (value: { text: string; bytes: number }) => DocumentPage, signal: AbortSignal) {
      const plan = planLoadDocument(reference, readTarget(target));
      const result = await scheduler.run(key(target, 'document', randomUUID()), async sharedSignal => {
        await verify(target, sharedSignal);
        let bytes = 0, reads = 0;
        const get = async (purpose: ResourceReadRequest['purpose'], path: string) => {
          await verify(target, sharedSignal); if (++reads > 5 || bytes >= 8_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
          const input = request(target, purpose, path);
          const text = await readResponseText(await read(purpose === 'custom-document' ? { ...input, customDocument: plan.reference } : input, sharedSignal), sharedSignal, Math.min(2_000_000, 8_000_000 - bytes)); bytes += Buffer.byteLength(text);
          await verify(target, sharedSignal); return text;
        };
        const proof = async () => {
          if (!plan.custom) return '';
          const definition = await get('resource-object', plan.custom.definitionPath), discovery = await get('api-version', plan.custom.discoveryPath);
          let first: unknown, second: unknown; try { first = JSON.parse(definition) as unknown; second = JSON.parse(discovery) as unknown; } catch { throw new BoundaryError('RESOURCE_INVALID'); }
          return customDocumentProof(first, second, plan.reference);
        };
        const before = await proof(), text = await get(plan.custom ? 'custom-document' : 'resource-object', plan.path);
        const document = projectResourceDocument(text, plan.reference, format);
        if (await proof() !== before) throw new BoundaryError('STALE_TARGET');
        await verify(target, sharedSignal);
        const page = project(document);
        if (Buffer.byteLength(JSON.stringify(page)) > 480_000) throw new BoundaryError('BUDGET_EXCEEDED');
        freezeResult(page); return { kind: 'document' as const, page };
      }, { signal });
      if (result.kind !== 'document') throw new BoundaryError('STATE_UNAVAILABLE');
      return result.page;
    },
    async events(target: TargetIdentity, scope: EventScope, signal: AbortSignal,
      previous?: { namespace: NamespaceReference; resourceVersion: string; continuation: string; apiVersion: EventApiVersion }) {
      const name = scope.kind === 'namespace' ? scope.name : target.namespace;
      const result = await scheduler.run(key(target, 'namespace-events', randomUUID()), async sharedSignal => {
        await verify(target, sharedSignal);
        const get = async (path: string) => readResponseJson(await read(request(target, 'resource-object', path), sharedSignal), sharedSignal);
        const namespace = projectEventNamespace(await get(`/api/v1/namespaces/${name}`), name, previous?.namespace ?? (scope.kind === 'namespace' ? scope : undefined));
        const query = { limit: String(eventPageLimit), ...(previous ? { continue: previous.continuation } : {}) };
        let apiVersion: EventApiVersion = previous?.apiVersion ?? 'v1', value: unknown;
        const list = async (version: EventApiVersion) => readResponseJson(await read(request(target, 'namespace-events', eventCollectionPath(version, name), query), sharedSignal), sharedSignal);
        try { value = await list(apiVersion); }
        catch (error) {
          // Only an initial collection HTTP 404 can select the other reviewed API. Never auth/throttle/410/JSON errors, cursors or Follow.
          if (previous || !(error instanceof BoundaryError) || error.code !== 'NOT_FOUND') throw error;
          await verify(target, sharedSignal);
          apiVersion = 'events.k8s.io/v1'; value = await list(apiVersion);
        }
        const page = projectEventPage(value, namespace, previous, apiVersion);
        projectEventNamespace(await get(`/api/v1/namespaces/${name}`), name, namespace);
        await verify(target, sharedSignal); freezeResult(page);
        return { kind: 'event-page' as const, page };
      }, { signal });
      if (result.kind !== 'event-page') throw new BoundaryError('STATE_UNAVAILABLE');
      return result.page;
    },
    async logContainers(target: TargetIdentity, reference: PodLogReference, signal: AbortSignal, origin?: JobLogOrigin) {
      const result = await logMetadata(target, reference, signal, origin, value => ({ kind: 'log-containers', containers: projectLogContainers(value, reference) }));
      if (result.kind !== 'log-containers') throw new BoundaryError('STATE_UNAVAILABLE');
      return result.containers;
    },
    async logRuntime(target: TargetIdentity, reference: PodLogReference, container: string, signal: AbortSignal, origin?: JobLogOrigin) {
      const result = await logMetadata(target, reference, signal, origin,
        (value, proof) => ({ kind: 'pod-log-runtime', runtime: JSON.stringify([logRuntimeIdentity(value, reference, container), proof]) }));
      if (result.kind !== 'pod-log-runtime') throw new BoundaryError('STATE_UNAVAILABLE');
      return result.runtime;
    },
    async podLogs(target: TargetIdentity, reference: PodLogReference, container: string, options: z.infer<typeof logOptionsSchema>, signal: AbortSignal, origin?: JobLogOrigin) {
      const plan = planPodLogReference(reference, readTarget(target)), parsed = logOptionsSchema.safeParse(options);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const job = origin ? planParentResource(origin, target) : undefined;
      if (origin && origin.namespace !== reference.namespace) throw new BoundaryError('STALE_TARGET');
      const result = await scheduler.run(key(target, 'pod-log-text', randomUUID()), async sharedSignal => {
        await verify(target, sharedSignal);
        const object = async () => readResponseJson(await read(request(target, 'resource-object', plan.path), sharedSignal), sharedSignal);
        const jobObject = async () => job ? readResponseJson(await read(request(target, 'resource-object', job.path), sharedSignal), sharedSignal) : undefined;
        const beforeJob = await jobObject(), beforePod = await object();
        const proof = origin ? jobLogMembership(beforeJob, beforePod, target, origin, reference) : '';
        const before = JSON.stringify([logRuntimeIdentity(beforePod, reference, container), proof]);
        const query: Record<string, string> = { container, timestamps: String(parsed.data.timestamps) };
        if (parsed.data.sinceSeconds !== null) query.sinceSeconds = String(parsed.data.sinceSeconds);
        if (parsed.data.tailLines !== null) query.tailLines = String(parsed.data.tailLines);
        const text = await readResponseText(await read(request(target, 'pod-logs', `${plan.path}/log`, query), sharedSignal), sharedSignal, logBytes);
        const afterPod = await object(), afterJob = await jobObject();
        const afterProof = origin ? jobLogMembership(afterJob, afterPod, target, origin, reference) : '';
        const after = JSON.stringify([logRuntimeIdentity(afterPod, reference, container), afterProof]);
        if (before !== after) throw new BoundaryError('STALE_TARGET');
        await verify(target, sharedSignal);
        return { kind: 'pod-log-text' as const, text, runtime: before }; // Private bounded snapshot handoff, not a tree/public DTO.
      }, { signal });
      if (result.kind !== 'pod-log-text') throw new BoundaryError('STATE_UNAVAILABLE');
      return { text: result.text, runtime: result.runtime };
    },
    async keyContent(input: { target: TargetIdentity; reference: unknown }, project: (value: ConfigurationValue) => KeyContentResponse, signal?: AbortSignal) {
      const target = readTarget(input.target), plan = planConfigurationValue(input.reference, target);
      const result = await run(target, key(target, 'configuration-value', randomUUID()), request(target, 'resource-object', plan.path),
        value => ({ kind: 'key-content', page: project(projectConfigurationValue(value, plan.reference, target)) }), signal);
      if (result.kind !== 'key-content') throw new BoundaryError('STATE_UNAVAILABLE');
      return result.page; // Raw objects/all data keys never escape this explicit bounded projection.
    },
    async parent(input: unknown, signal?: AbortSignal) {
      const parsed = parentRequest.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const target = readTarget(parsed.data.target), plan = planParentResource(parsed.data.parent, target);
      // A post-check must be a NEW server GET, not attach to a read that began before its child list.
      const result = await run(target, key(target, 'parent', randomUUID()), request(target, 'resource-object', plan.path),
        value => ({ kind: 'parent', parent: projectParentResource(value, plan.parent, target, parsed.data.offset) }), signal);
      if (result.kind !== 'parent') throw new BoundaryError('STATE_UNAVAILABLE');
      return result.parent;
    },
    async definition(input: unknown, signal?: AbortSignal) {
      const parsed = definitionRequest.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const target = readTarget(parsed.data.target), definition = parsed.data.definition;
      const result = await run(target, key(target, 'definition', createHash('sha256').update(referenceKey(definition)).digest('hex'), randomUUID()),
        request(target, 'resource-object', resourceObjectPath(crdType, definition.name)), value => {
          verifyResourceObject(value, crdType, definition);
          return { kind: 'definition', definition: projectCustomResourceDefinition(value) };
        }, signal);
      if (result.kind !== 'definition') throw new BoundaryError('STATE_UNAVAILABLE');
      return result.definition;
    },
    async list(input: unknown, signal?: AbortSignal, fresh = false) {
      const plan = planResourceList(input), target = plan.request.target;
      const result = plan.kind === 'empty'
        ? await run(target, key(target, 'empty-pod-selector'), null, () => ({ kind: 'empty-selector', target, type: plan.request.type, nodes: [] }), signal)
        : await run(target, fresh ? [...plan.key, randomUUID()] : plan.key,
          { ...request(target, 'resource-list', plan.path, plan.query), ...(plan.metadata ? { representation: 'metadata-preferred' as const } : {}),
            ...(plan.request.customDefinition ? { customList: { type: plan.request.type, definition: plan.request.customDefinition } } : {}) },
          value => ({ kind: 'resources', page: projectResourcePage(200, JSON.stringify(value), plan) }), signal);
      if (result.kind !== 'resources' && result.kind !== 'empty-selector') throw new BoundaryError('STATE_UNAVAILABLE');
      return result;
    },
    async discoverVersion(input: unknown, signal?: AbortSignal) {
      const parsed = versionRequest.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const target = readTarget(parsed.data.target), { group, version } = parsed.data;
      const result = await run(target, key(target, 'api-version', group ? 'group' : 'core', group || '-', version), request(target, 'api-version', apiDiscoveryPath(group, version)), value => {
        const types = projectDiscovery(value);
        // Empty discovery must also match the requested version, not just individual returned rows.
        const actual = z.object({ groupVersion: z.literal(group ? `${group}/${version}` : version) }).safeParse(value);
        if (!actual.success) throw new BoundaryError('STALE_TARGET');
        return { kind: 'version', types };
      }, signal);
      if (result.kind !== 'version') throw new BoundaryError('STATE_UNAVAILABLE');
      return result.types;
    },
    async discoverGroup(input: unknown, signal?: AbortSignal) {
      const parsed = groupRequest.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const target = readTarget(parsed.data.target), { group } = parsed.data;
      const result = await run(target, key(target, 'api-group', group), request(target, 'api-group', `/apis/${group}`), value => {
        const projected = projectApiGroup(value);
        if (projected.group !== group) throw new BoundaryError('STALE_TARGET');
        return { kind: 'group', group: projected };
      }, signal);
      if (result.kind !== 'group') throw new BoundaryError('STATE_UNAVAILABLE');
      return result.group;
    },
    async customDefinitions(input: unknown, signal?: AbortSignal) {
      const parsed = definitionsRequest.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const target = readTarget(parsed.data.target);
      const plan = planResourceList({ ...parsed.data, target, type: crdType });
      if (plan.kind !== 'list') throw new BoundaryError('INVALID_INPUT');
      const result = await run(target, [...plan.key, 'definitions'], { ...request(target, 'custom-resource-definitions', plan.path, plan.query), representation: 'metadata-preferred' },
        value => ({ kind: 'definitions', page: projectDefinitionFolderPage(value, { limit: plan.request.limit, continue: plan.request.continue,
          ...(plan.request.resourceVersion !== undefined ? { resourceVersion: plan.request.resourceVersion } : {}) }) }), signal);
      if (result.kind !== 'definitions') throw new BoundaryError('STATE_UNAVAILABLE');
      return result.page;
    },
    close: () => scheduler.close(),
    get state() { return scheduler.state; },
  };
}
