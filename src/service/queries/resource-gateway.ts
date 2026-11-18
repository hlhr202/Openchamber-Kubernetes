import { createHash } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import { readConfigSelection } from '../../shared/configuration.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import { protocolVersion } from '../../shared/protocol.ts';
import { resourceReadRequestSchema, resourceReadResponseSchema } from '../../shared/resource-protocol.ts';
import { helmReleaseRequestSchema, helmReleaseResponseSchema, groupHelmReleases } from '../../shared/helm-release-protocol.ts';
import { forwardOriginalSchema } from './forward-target.ts';
import type { ResourceReadResponse } from '../../shared/resource-protocol.ts';
import { resourceDescriptors } from '../../shared/tree.ts';
import type { createConfigReader } from './config-source.ts';
import { createResourceReader } from './resource-reader.ts';
import type { ResourceReadRequest } from './resource-reader.ts';
import type { ReadResponse } from './bounded-response.ts';
import { createResourcePager } from './resource-pagination.ts';
import { bindResourceTarget } from './resource-target.ts';
import { ReadScheduler } from './read-scheduler.ts';
import { createOutboundReadGate } from './outbound-read-gate.ts';
import type { OutboundReadGateLimits } from './outbound-read-gate.ts';
import { branchReadRequestSchema } from '../../shared/branch-protocol.ts';
import type { BranchReadResponse } from '../../shared/branch-protocol.ts';
import { createBranchReader } from './branch-reader.ts';
import { keyContentRequestSchema } from '../../shared/key-content-protocol.ts';
import type { KeyContentResponse } from '../../shared/key-content-protocol.ts';
import { createKeyContentReader } from './key-content.ts';
import { podLogRequestSchema } from '../../shared/pod-log-protocol.ts';
import type { PodLogResponse } from '../../shared/pod-log-protocol.ts';
import { createPodLogReader } from './pod-logs.ts';
import { eventReadRequestSchema } from '../../shared/event-protocol.ts';
import type { EventReadResponse } from '../../shared/event-protocol.ts';
import { createEventReader } from './events.ts';
import { documentReferenceSchema, documentRequestSchema } from '../../shared/document-protocol.ts';
import type { DocumentPage } from '../../shared/document-protocol.ts';
import { createDocumentReader } from './documents.ts';
import { namespaceDeleteReferenceSchema } from '../../shared/namespace-inventory.ts';
import type { NamespaceInventory } from '../../shared/namespace-inventory.ts';
import { configSelectionSchema } from '../../shared/configuration.ts';
import { targetSchema } from '../../shared/identity.ts';
import { z } from 'zod';
import { inspectionRequestSchema } from '../../shared/inspection-protocol.ts';
import type { InspectionPage } from '../../shared/inspection-protocol.ts';
import { createInspectionReader } from './inspection-output.ts';
import { explainRequestSchema } from '../../shared/explain-protocol.ts';
import type { ExplainResponse } from '../../shared/explain-protocol.ts';
import { watchOpenSchema } from '../../shared/watch-protocol.ts';
import { createWatchTasks } from './watch-tasks.ts';
import { runResourceWatch } from './watch-runner.ts';
import type { WatchTransport } from './watch-runner.ts';
import { createReadTasks, createReadTaskBudget } from './read-tasks.ts';
import { logFollowSourceSchema, logFollowOpenSchema, logFollowEventSchema, logFollowPageSchema } from '../../shared/log-follow-protocol.ts';
import { runLogFollow } from './log-follow-runner.ts';
import { eventFollowSourceSchema, eventFollowOpenSchema, eventFollowDeltaSchema, eventFollowPageSchema } from '../../shared/event-follow-protocol.ts';
import { runEventFollow } from './event-follow-runner.ts';
import { jobLogSelectionSourceSchema, jobLogSelectionOpenSchema, jobLogSelectedSchema, jobLogSelectionPageSchema } from '../../shared/job-log-selection-protocol.ts';
import { runJobLogSelection } from './job-log-selection-runner.ts';
import { manifestDiffRequestSchema, manifestDiffPageSchema } from '../../shared/manifest-diff-protocol.ts';
import type { ManifestDiffPage } from '../../shared/manifest-diff-protocol.ts';
import { createManifestDiffReader } from './manifest-diff-reader.ts';
import type { ManifestLocator } from '../../shared/manifest-diff-protocol.ts';
import type { TargetIdentity } from '../../shared/identity.ts';

const inventoryRequest = z.object({ selection: configSelectionSchema, target: targetSchema, reference: namespaceDeleteReferenceSchema }).strict();

export function createResourceGateway(options: { config: ReturnType<typeof createConfigReader>; serviceGeneration: string;
  read: (selection: ConfigSelection, request: ResourceReadRequest, signal: AbortSignal) => Promise<ReadResponse>; watch?: WatchTransport; outbound?: Partial<OutboundReadGateLimits> }) {
  const selections = new Map<string, { selection: ConfigSelection; expiresAt: number }>();
  let closed = false;
  const requests = new ReadScheduler<ResourceReadResponse | BranchReadResponse | KeyContentResponse | PodLogResponse | EventReadResponse | DocumentPage | InspectionPage | ExplainResponse | ManifestDiffPage>({ concurrency: 2, queued: 16, consumers: 64, timeoutMs: 12_000 });
  const outbound = createOutboundReadGate(options.read, options.outbound);
  const gatedWatch: WatchTransport | undefined = options.watch ? async (selection, request, signal, emit) => {
    await outbound.admitStreamStart(selection, request, signal);
    return options.watch!(selection, request, signal, emit);
  } : undefined;
  function selection(identity: string): ConfigSelection {
    const entry = selections.get(identity);
    if (!entry || entry.expiresAt <= Date.now()) throw new BoundaryError('STALE_TARGET');
    return entry.selection;
  }
  const reader = createResourceReader({ serviceGeneration: options.serviceGeneration,
    currentTarget: async (target, signal) => bindResourceTarget(target, await options.config.read(selection(target.configIdentity), signal), options.serviceGeneration),
    read: (request, signal) => outbound.admit(selection(request.target.configIdentity), request, signal),
  });
  const pager = createResourcePager(reader);
  const branches = createBranchReader(reader, pager);
  const keyContents = createKeyContentReader(reader);
  const podLogs = createPodLogReader(reader);
  const events = createEventReader(reader);
  const documents = createDocumentReader(reader);
  const comparisons = createManifestDiffReader(reader);
  const inspections = createInspectionReader(reader);
  const streamBudget = createReadTaskBudget();
  const jobSelections = createReadTasks({ generation: options.serviceGeneration, budget: streamBudget, kind: 'job-log-selection', sourceSchema: jobLogSelectionSourceSchema, eventSchema: jobLogSelectedSchema, pageSchema: jobLogSelectionPageSchema,
    run: async (source, signal, emit) => {
      const budget = { bytes: 0, reads: 0 };
      let origin = source.origin;
      await runJobLogSelection(source, signal, emit, {
        list: async previous => { await bind(source, signal); return reader.jobLogCandidates(source, signal, budget, previous); },
        verify: async (selector, reference, raw) => { await bind(source, signal); const value = await reader.verifyJobLogSelection(source, signal, budget, selector, reference, raw); origin = value.origin; return value.reference; }, origin: () => origin,
        ...(gatedWatch ? { transport: gatedWatch } : {}), charge: bytes => { if ((budget.bytes += bytes) > 8_000_000) throw new BoundaryError('BUDGET_EXCEEDED'); } });
    } });
  const eventFollows = createReadTasks({ generation: options.serviceGeneration, budget: streamBudget, kind: 'event-follow', sourceSchema: eventFollowSourceSchema, eventSchema: eventFollowDeltaSchema, pageSchema: eventFollowPageSchema,
    run: async (source, signal, emit) => {
      if (!gatedWatch) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE'); const budget = { bytes: 0, reads: 0 };
      await runEventFollow(source, signal, emit, { transport: gatedWatch,
        verify: async initial => { await bind(source, signal); await reader.verifyEventFollowNamespace(source.target, source.namespace, signal, initial, budget); },
        list: previous => reader.eventFollowPage(source.target, source.namespace, signal, budget, source.apiVersion, previous),
        charge: bytes => { if ((budget.bytes += bytes) > 8_000_000) throw new BoundaryError('BUDGET_EXCEEDED'); } });
    } });
  const follows = createReadTasks({ generation: options.serviceGeneration, budget: streamBudget, kind: 'pod-log-follow', sourceSchema: logFollowSourceSchema, eventSchema: logFollowEventSchema, pageSchema: logFollowPageSchema,
    run: async (source, signal, emit) => {
      if (!gatedWatch) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
      const budget = { bytes: 0, reads: 0 };
      await runLogFollow(source, signal, emit, { transport: gatedWatch, verify: async (initial, proofSignal) => { await bind(source, proofSignal); return reader.followRuntime(source, proofSignal, initial, budget); } });
    } });
  const watches = createWatchTasks({ generation: options.serviceGeneration, budget: streamBudget, run: async (source, signal, emit) => {
    if (!gatedWatch) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
    await bind(source, signal);
    if (source.custom) {
      const proofBudget = { bytes: 0, reads: 0 }; let initial = true, original: string | undefined;
      await runResourceWatch(source, signal, emit, { transport: gatedWatch,
        verify: async (source, signal) => {
          await bind(source, signal); const proof = await reader.verifyCustomWatch(source, signal, proofBudget, initial);
          if (original !== undefined && original !== proof) throw new BoundaryError('STALE_TARGET'); original = proof; initial = false;
        }, relist: (source, signal, budget) => reader.watchRelist(source, signal, budget) });
      return;
    }
    const descriptor = Object.entries(resourceDescriptors).find(([key]) => key === source.resource)?.[1];
    if (!descriptor) throw new BoundaryError('INVALID_INPUT');
    const { group, version, resource, kind, scope } = descriptor;
    if (source.object) await reader.verifyReference(source.target, { type: { group, version, resource, kind, scope }, ...source.object, resourceVersion: source.resourceVersion,
      ...(descriptor.scope === 'namespace' ? { namespace: source.target.namespace } : {}) }, signal);
    await runResourceWatch(source, signal, emit, { transport: gatedWatch, verify: async (source, signal) => { await bind(source, signal); },
      relist: (source, signal, budget) => reader.watchRelist(source, signal, budget) });
  } });
  async function bind(value: { selection: ConfigSelection; target: ResourceReadResponse['target'] }, signal: AbortSignal) {
    const target = bindResourceTarget(value.target, await options.config.read(value.selection, signal), options.serviceGeneration);
    if (signal.aborted || closed) throw new BoundaryError(closed ? 'SERVICE_CLOSED' : 'QUERY_CANCELLED');
    const now = Date.now();
    for (const [key, entry] of selections) if (entry.expiresAt <= now) selections.delete(key);
    if (!selections.has(target.configIdentity) && selections.size >= 32) throw new BoundaryError('QUERY_LIMIT');
    selections.set(target.configIdentity, { selection: readConfigSelection(value.selection), expiresAt: now + 60_000 });
    return target;
  }
  function freeze(value: unknown): void {
    if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  }
  return {
    async captureManifestApply(value: { target: TargetIdentity; selection: ConfigSelection; reference: unknown; expect: 'live' | 'missing' }, signal: AbortSignal) {
      const target = await bind(value, signal); return reader.captureManifestApply(target, value.reference, signal, value.expect);
    },
    async proveManifestCreate(value: { target: TargetIdentity; selection: ConfigSelection; locator: ManifestLocator }, signal: AbortSignal) {
      const target = await bind(value, signal); return reader.proveManifestCreate(target, value.locator, signal);
    },
    async readHelmReleases(input: unknown, signal: AbortSignal) {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = helmReleaseRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const target = await bind(parsed.data, signal);
      if (parsed.data.kind === 'detail') {
        const detail = await reader.helmReleases(target, signal, parsed.data.release);
        const newest = [...detail.revisions].sort((a, b) => b.revision - a.revision)[0];
        if (!newest || newest.name !== parsed.data.release) throw new BoundaryError('NOT_FOUND');
        return helmReleaseResponseSchema.parse({ protocol: 2, kind: 'release-detail', target, namespace: parsed.data.namespace, release: newest.name,
          revision: { revision: newest.revision, status: newest.status, chartName: newest.chartName, chartVersion: newest.chartVersion,
            ...(newest.appVersion !== undefined ? { appVersion: newest.appVersion } : {}), ...(newest.lastDeployed !== undefined ? { lastDeployed: newest.lastDeployed } : {}),
            uid: newest.uid, resourceVersion: newest.resourceVersion },
          ...(newest.detail?.manifest !== undefined ? { manifest: newest.detail.manifest } : {}),
          ...(newest.detail?.config !== undefined ? { config: newest.detail.config } : {}),
          ...(newest.detail?.hooks !== undefined ? { hooks: newest.detail.hooks } : {}),
          ...(newest.detail?.description !== undefined ? { description: newest.detail.description } : {}) });
      }
      const result = await reader.helmReleases(target, signal);
      const grouped = groupHelmReleases(result.revisions.map(revision => ({ ...revision })));
      return helmReleaseResponseSchema.parse({ protocol: 2, kind: 'releases', target, namespace: parsed.data.namespace, releases: grouped.releases, truncated: grouped.truncated || result.truncated });
    },
    async resolveForwardTarget(value: { target: TargetIdentity; selection: ConfigSelection; original: unknown }, signal: AbortSignal) {
      const parsed = forwardOriginalSchema.safeParse(value.original); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const target = await bind(value, signal); return reader.resolveForwardTarget(target, parsed.data, signal);
    },
    async resolveLocator(value: { target: TargetIdentity; selection: ConfigSelection; locator: ManifestLocator }, signal: AbortSignal) {
      const target = await bind(value, signal); return reader.resolveLocator(target, value.locator, signal);
    },
    async probeApplyFileDocument(value: { target: TargetIdentity; selection: ConfigSelection; locator: ManifestLocator }, signal: AbortSignal) {
      const target = await bind(value, signal); return reader.probeApplyFileDocument(target, value.locator, signal);
    },
    async readManifestDiff(input: unknown, signal: AbortSignal): Promise<ManifestDiffPage> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED'); const parsed = manifestDiffRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const result = await requests.run(['manifest-diff', createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')], async sharedSignal => { await bind(parsed.data, sharedSignal); return comparisons.read(parsed.data, sharedSignal); }, { signal }); return manifestDiffPageSchema.parse(result);
    },
    async openJobLogSelection(input: unknown, signal: AbortSignal) {
      if (closed) throw new BoundaryError('SERVICE_CLOSED'); const parsed = jobLogSelectionOpenSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      await bind(parsed.data, signal); return jobSelections.open(parsed.data);
    },
    async pollJobLogSelection(input: unknown, signal: AbortSignal) {
      const source = jobSelections.source(input);
      try { await bind(source, signal); return jobSelections.poll(input); } catch (error) { try { jobSelections.release(input); } catch { /* Lease fallback. */ } throw error; }
    },
    releaseJobLogSelection(input: unknown) { jobSelections.release(input); return { protocol: 2 as const, released: true as const }; },
    async openEventFollow(input: unknown, signal: AbortSignal) {
      if (closed) throw new BoundaryError('SERVICE_CLOSED'); const parsed = eventFollowOpenSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      await bind(parsed.data, signal); return eventFollows.open(parsed.data);
    },
    async pollEventFollow(input: unknown, signal: AbortSignal) {
      const source = eventFollows.source(input);
      try { await bind(source, signal); return eventFollows.poll(input); }
      catch (error) { try { eventFollows.release(input); } catch { /* Already expired. */ } throw error; }
    },
    releaseEventFollow(input: unknown) { eventFollows.release(input); return { protocol: 2 as const, released: true as const }; },
    async openLogFollow(input: unknown, signal: AbortSignal) {
      if (closed) throw new BoundaryError('SERVICE_CLOSED'); const parsed = logFollowOpenSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      await bind(parsed.data, signal); return follows.open(parsed.data);
    },
    async pollLogFollow(input: unknown, signal: AbortSignal) {
      const source = follows.source(input);
      try { await bind(source, signal); return follows.poll(input); }
      catch (error) { try { follows.release(input); } catch { /* Already expired. */ } throw error; }
    },
    releaseLogFollow(input: unknown) { follows.release(input); return { protocol: 2 as const, released: true as const }; },
    async openWatch(input: unknown, signal: AbortSignal) {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = watchOpenSchema.safeParse(input); if (!parsed.success || parsed.data.resourceVersion === '0') throw new BoundaryError('INVALID_INPUT');
      await bind(parsed.data, signal); return watches.open(parsed.data);
    },
    async pollWatch(input: unknown, signal: AbortSignal) {
      const source = watches.source(input);
      try { await bind(source, signal); return watches.poll(input); }
      catch (error) { try { watches.release(input); } catch { /* Already expired. */ } throw error; }
    },
    releaseWatch(input: unknown) { watches.release(input); return { protocol: 2 as const, released: true as const }; },
    async explain(input: unknown, signal: AbortSignal): Promise<ExplainResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED'); const parsed = explainRequestSchema.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const value = parsed.data;
      const key = [options.serviceGeneration, 'explain', options.config.selectionKey(value.selection), createHash('sha256').update(JSON.stringify(value)).digest('hex')];
      const result = await requests.run(key, async signal => { const target = await bind(value, signal); return reader.explain({ ...value, target }, signal); }, { signal });
      if (!('kind' in result) || result.kind !== 'field-explanation') throw new BoundaryError('STATE_UNAVAILABLE'); return result;
    },
    async readInspection(input: unknown, signal: AbortSignal): Promise<InspectionPage> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = inspectionRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const value = parsed.data;
      const key = [options.serviceGeneration, 'inspection', options.config.selectionKey(value.selection), createHash('sha256').update(JSON.stringify(value)).digest('hex')];
      const result = await requests.run(key, async signal => { const target = await bind(value, signal); const result = await inspections.read({ ...value, target }, signal); freeze(result); return result; }, { signal });
      if (!('kind' in result) || result.kind !== 'inspection-output') throw new BoundaryError('STATE_UNAVAILABLE'); return result;
    },
    async namespaceInventory(input: unknown, signal: AbortSignal): Promise<NamespaceInventory> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = inventoryRequest.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const target = await bind(parsed.data, signal); return reader.namespaceInventory(target, parsed.data.reference, signal);
    },
    async verifyReference(input: unknown, signal: AbortSignal): Promise<void> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = documentRequestSchema.safeParse(typeof input === 'object' && input !== null ? { ...input, protocol: 2, format: 'json' } : input);
      if (!parsed.success || parsed.data.cursor || !documentReferenceSchema.safeParse(parsed.data.reference).success) throw new BoundaryError('INVALID_INPUT');
      const value = parsed.data, target = await bind(value, signal);
      await reader.verifyReference(target, value.reference, signal); // Fresh metadata-only GET in the original global reader pool.
    },
    async readDocument(input: unknown, signal: AbortSignal): Promise<DocumentPage> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = documentRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const value = parsed.data;
      const key = [options.serviceGeneration, 'document', options.config.selectionKey(value.selection), createHash('sha256').update(JSON.stringify(value)).digest('hex')];
      const result = await requests.run(key, async signal => {
        const target = await bind(value, signal), result = await documents.read({ ...value, target }, signal); freeze(result); return result;
      }, { signal });
      if (!('kind' in result) || result.kind !== 'resource-document') throw new BoundaryError('STATE_UNAVAILABLE'); return result;
    },
    async readEvents(input: unknown, signal: AbortSignal): Promise<EventReadResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = eventReadRequestSchema.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const value = parsed.data;
      const key = [options.serviceGeneration, 'events', options.config.selectionKey(value.selection), createHash('sha256').update(JSON.stringify(value)).digest('hex')];
      const result = await requests.run(key, async signal => {
        const target = await bind(value, signal), result = await events.read({ ...value, target }, signal); freeze(result); return result;
      }, { signal });
      if (!('kind' in result) || result.kind !== 'events') throw new BoundaryError('STATE_UNAVAILABLE');
      return result;
    },
    async readLogs(input: unknown, signal: AbortSignal): Promise<PodLogResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = podLogRequestSchema.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const value = parsed.data;
      const key = [options.serviceGeneration, 'pod-logs', options.config.selectionKey(value.selection), createHash('sha256').update(JSON.stringify(value)).digest('hex')];
      const result = await requests.run(key, async signal => {
        const target = await bind(value, signal);
        const result = await podLogs.read({ ...value, target }, signal); freeze(result); return result;
      }, { signal });
      if (!('kind' in result) || !['log-containers', 'pod-log'].includes(result.kind)) throw new BoundaryError('STATE_UNAVAILABLE');
      return result as PodLogResponse;
    },
    async readKey(input: unknown, signal: AbortSignal): Promise<KeyContentResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = keyContentRequestSchema.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const value = parsed.data;
      const key = [options.serviceGeneration, 'key-content', options.config.selectionKey(value.selection), createHash('sha256').update(JSON.stringify(value)).digest('hex')];
      const result = await requests.run(key, async signal => {
        const target = await bind(value, signal);
        const result = await keyContents.read({ ...value, target }, signal);
        freeze(result); return result;
      }, { signal });
      if (!('kind' in result) || result.kind !== 'key-content') throw new BoundaryError('STATE_UNAVAILABLE');
      return result;
    },
    async readTree(input: unknown, signal: AbortSignal): Promise<BranchReadResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = branchReadRequestSchema.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const value = parsed.data;
      outbound.recordLogicalIntent();
      const key = [options.serviceGeneration, 'tree', options.config.selectionKey(value.selection), createHash('sha256').update(JSON.stringify(value)).digest('hex')];
      const result = await outbound.withScope({ intentKind: `tree:${value.kind}` }, () => requests.run(key, async signal => {
        const target = await bind(value, signal);
        const result = await branches.read({ ...value, target }, signal);
        freeze(result);
        return result;
      }, { signal }));
      if (!('kind' in result) || !['children', 'custom-types', 'custom-resources', 'helm-releases', 'helm-release-history'].includes(result.kind)) throw new BoundaryError('STATE_UNAVAILABLE');
      return result as BranchReadResponse;
    },
    async read(input: unknown, signal: AbortSignal) {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = resourceReadRequestSchema.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const value = parsed.data;
      outbound.recordLogicalIntent();
      const key = [options.serviceGeneration, 'resources', options.config.selectionKey(value.selection), ...Object.values(value.target), value.resource,
        createHash('sha256').update(value.cursor ?? '').digest('hex')];
      const result = await outbound.withScope({ intentKind: `resources:${value.resource}` }, () => requests.run(key, async signal => {
        const target = await bind(value, signal);
        const descriptor = Object.entries(resourceDescriptors).find(([name]) => name === value.resource)?.[1];
        if (!descriptor) throw new BoundaryError('INVALID_INPUT');
        const { group, version, resource, kind, scope } = descriptor;
        const result = await pager.read({ query: { target, type: { group, version, resource, kind, scope }, limit: 100 }, ...(value.cursor ? { cursor: value.cursor } : {}) }, signal);
        if (result.kind !== 'resources') throw new BoundaryError('STATE_UNAVAILABLE');
        const projected = resourceReadResponseSchema.safeParse({ protocol: protocolVersion, target, resource: value.resource,
          nodes: result.nodes, resourceVersion: result.resourceVersion, nextCursor: result.nextCursor });
        if (!projected.success) throw new BoundaryError('RESOURCE_INVALID');
        const resultValue = projected.data;
        if (Buffer.byteLength(JSON.stringify(resultValue)) > 480_000) throw new BoundaryError('BUDGET_EXCEEDED');
        freeze(resultValue);
        return resultValue;
      }, { signal }));
      if ('kind' in result) throw new BoundaryError('STATE_UNAVAILABLE');
      return result;
    },
    withPriority<R>(priority: 'manual' | 'background', fn: () => R): R {
      return outbound.withScope({ priority }, fn);
    },
    diagnostics() {
      const diag = outbound.diagnostics();
      return Object.freeze({ ...diag, coalescedLogical: requests.stats.coalesced, scheduler: requests.stats });
    },
    close() { closed = true; outbound.close(); comparisons.close(); jobSelections.close(); eventFollows.close(); follows.close(); watches.close(); requests.close(); selections.clear(); inspections.dispose(); documents.dispose(); events.dispose(); podLogs.dispose(); keyContents.dispose(); branches.dispose(); pager.dispose(); reader.close(); },
  };
}
