import { timingSafeEqual } from 'node:crypto';
import type { createProjectWorkspaces } from '../queries/project-workspaces.ts';
import { getHeapStatistics } from 'node:v8';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BoundaryError, isBudgetError } from '../../shared/errors.ts';
import { healthSchema, protocolVersion } from '../../shared/protocol.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { parseConfigPageQuery, projectConfigPage } from '../queries/config-page.ts';
import type { ConfigRead } from '../queries/config-page.ts';
import { ReadScheduler } from '../queries/read-scheduler.ts';
import { configRequestBytes, parseConfigReadRequest } from '../queries/config-request.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import type { createResourceGateway } from '../queries/resource-gateway.ts';
import { resourceRequestBytes } from '../../shared/resource-protocol.ts';
import type { createDeleteOperations } from '../operations/delete.ts';
import type { createNamespaceOperations } from '../operations/namespace.ts';
import type { createNamespaceDeleteOperations } from '../operations/namespace-delete.ts';
import type { createContextOperations } from '../operations/context.ts';
import type { createContextDeleteOperations } from '../operations/context-delete.ts';
import type { createPreferenceStore } from '../adapters/preference-store.ts';
import type { ConfigurationWriteLock } from '../operations/configuration-lock.ts';
import { preferenceAppendRequestSchema, preferenceReadRequestSchema } from '../../shared/preference-protocol.ts';
import type { PreferenceRevision } from '../../shared/preference-protocol.ts';
import type { createSourcePicker } from '../queries/source-picker.ts';
import { contextChoiceRequestSchema } from '../../shared/context-choice-protocol.ts';
import { projectContextChoices } from '../queries/context-choices.ts';
import type { createHelmRepositoryReader } from '../queries/helm-repositories.ts';
import type { createHelmVersionReader } from '../queries/helm-version-reader.ts';
import type { createHelmRefreshOperations } from '../operations/helm-refresh.ts';
import type { createHelmInspectOperations } from '../operations/helm-inspect.ts';
import type { createHelmValuesOperations } from '../operations/helm-values.ts';
import type { createHelmDependenciesOperations } from '../operations/helm-dependencies.ts';
import type { createHelmLintOperations } from '../operations/helm-lint.ts';
import type { createHelmTemplateOperations } from '../operations/helm-template.ts';
import type { createHelmDryRunOperations } from '../operations/helm-dryrun.ts';
import type { createHelmPackageOperations } from '../operations/helm-package.ts';
import type { createHelmDepUpOperations } from '../operations/helm-depup.ts';
import type { createHelmCreateOperations } from '../operations/helm-create.ts';
import type { createHelmFetchOperations } from '../operations/helm-fetch.ts';
import type { createHelmRequirementReader } from '../queries/helm-requirement-reader.ts';
import type { createHelmConvertOperations } from '../operations/helm-convert.ts';
import type { createHelmParameteriseReader } from '../queries/helm-parameterise-reader.ts';
import type { createWorkspaceReader } from '../queries/workspace-reader.ts';
import type { createManifestApplyOperations } from '../operations/manifest-apply.ts';
import type { createScaleOperations } from '../operations/scale.ts';
import type { createCronJobRunOperations } from '../operations/cronjob-run.ts';
import type { createExposeOperations } from '../operations/expose.ts';
import type { createConfigFileDeleteOperations } from '../operations/config-file-delete.ts';
import type { createConfigFileAddOperations } from '../operations/config-file-add.ts';
import type { createFileDeleteOperations } from '../operations/file-delete.ts';
import type { createApplyFileOperations } from '../operations/apply-file.ts';
import type { createImageRunOperations } from '../operations/image-run.ts';
import type { createGitSyncOperations } from '../operations/sync-checkout.ts';
import type { createSessionService } from '../sessions/session-service.ts';
import type { createHelmClusterWriteOperations } from '../operations/helm-cluster-write.ts';
import type { createMergeKubeconfigOperations } from '../operations/merge-kubeconfig.ts';
import type { createClusterOperations } from '../operations/cluster-operations.ts';
import type { createProviderFlowOperations } from '../operations/provider-flows.ts';
function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > 512_000) {
    response.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: { code: 'BUDGET_EXCEEDED' } }));
    return;
  }
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(text);
}

// Process-level hard budgets for the whole service: in-flight admitted requests, total body
// bytes being consumed across all requests, and a v8 heap watermark. Admission above any of
// them refuses NEW work with QUERY_LIMIT (429) / BUDGET_EXCEEDED (413) without touching old work.
// Substituted from package.json by the service build.
declare const __K8S_EXTENSION_VERSION__: string;

const inFlight = { requests: 0, bodyBytes: 0 };
const inFlightRequestLimit = 64;
const inFlightBodyBudgetBytes = 8 * 1024 * 1024;
const heapWatermarkFraction = 0.9;
const heapAboveWatermark = () => { const stats = getHeapStatistics(); return stats.heap_size_limit > 0 && stats.used_heap_size > heapWatermarkFraction * stats.heap_size_limit; };

async function boundedBody(request: IncomingMessage, signal: AbortSignal, maximumBytes = configRequestBytes): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0, timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; request.destroy(); }, 5000);
  try {
    for await (const chunk of request) {
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (!Buffer.isBuffer(chunk)) throw new BoundaryError('INVALID_INPUT');
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) throw new BoundaryError('BUDGET_EXCEEDED');
      inFlight.bodyBytes += chunk.byteLength;
      if (inFlight.bodyBytes > inFlightBodyBudgetBytes) throw new BoundaryError('BUDGET_EXCEEDED');
      chunks.push(chunk);
    }
    if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    throw new BoundaryError(timedOut ? 'QUERY_TIMEOUT' : signal.aborted ? 'QUERY_CANCELLED' : 'INVALID_INPUT');
  } finally { inFlight.bodyBytes -= bytes; clearTimeout(timeout); }
}

export function createServiceHandler(options: { token: string; serviceGeneration: string; config: ReturnType<typeof createConfigReader>; resources: ReturnType<typeof createResourceGateway>; operations: ReturnType<typeof createDeleteOperations>; namespaces: ReturnType<typeof createNamespaceOperations>; namespaceDeletes: ReturnType<typeof createNamespaceDeleteOperations>; contexts: ReturnType<typeof createContextOperations>; contextDeletes: ReturnType<typeof createContextDeleteOperations>; preferences: ReturnType<typeof createPreferenceStore>; lock: ConfigurationWriteLock; sourcePicker: ReturnType<typeof createSourcePicker>; helmRepositories: ReturnType<typeof createHelmRepositoryReader>; helmVersions: ReturnType<typeof createHelmVersionReader>; helmRefreshes: ReturnType<typeof createHelmRefreshOperations>; helmInspects: ReturnType<typeof createHelmInspectOperations>; helmValues: ReturnType<typeof createHelmValuesOperations>; helmDependencies: ReturnType<typeof createHelmDependenciesOperations>; helmLints: ReturnType<typeof createHelmLintOperations>; helmTemplates: ReturnType<typeof createHelmTemplateOperations>; helmDryRuns: ReturnType<typeof createHelmDryRunOperations>; helmPackages: ReturnType<typeof createHelmPackageOperations>; helmDepUps: ReturnType<typeof createHelmDepUpOperations>; helmCreates: ReturnType<typeof createHelmCreateOperations>; helmFetches: ReturnType<typeof createHelmFetchOperations>; helmRequirements: ReturnType<typeof createHelmRequirementReader>; helmConverts: ReturnType<typeof createHelmConvertOperations>; helmParameterises: ReturnType<typeof createHelmParameteriseReader>; workspace: ReturnType<typeof createWorkspaceReader>; fileSaves: ReturnType<typeof import('../operations/file-save.ts').createFileSaveOperations>; manifestCreates: ReturnType<typeof import('../operations/manifest-create.ts').createManifestCreateOperations>; manifestApplies: ReturnType<typeof createManifestApplyOperations>; scales: ReturnType<typeof createScaleOperations>; cronJobRuns: ReturnType<typeof createCronJobRunOperations>; exposes: ReturnType<typeof createExposeOperations>; configFileDeletes: ReturnType<typeof createConfigFileDeleteOperations>; configFileAdds: ReturnType<typeof createConfigFileAddOperations>; fileDeletes: ReturnType<typeof createFileDeleteOperations>; applyFiles: ReturnType<typeof createApplyFileOperations>; imageRuns: ReturnType<typeof createImageRunOperations>; gitSyncs: ReturnType<typeof createGitSyncOperations>; sessionService: ReturnType<typeof createSessionService>; helmClusterWrites: ReturnType<typeof createHelmClusterWriteOperations>; mergeKubeconfigs: ReturnType<typeof createMergeKubeconfigOperations>; clusterOperations: ReturnType<typeof createClusterOperations>; providerFlows: ReturnType<typeof createProviderFlowOperations> }) {
  const projects = (options as typeof options & { projectWorkspaces?: ReturnType<typeof createProjectWorkspaces> }).projectWorkspaces;
  const reads = new ReadScheduler<ConfigRead>({ concurrency: 2, queued: 16, consumers: 64, timeoutMs: 5000 });
  const preferenceReads = new ReadScheduler<{ kind: 'keys'; keys: string[] } | { kind: 'get'; revision: PreferenceRevision | null }>({ concurrency: 2, queued: 16, consumers: 64, timeoutMs: 5000 });
  const preferenceShutdown = new AbortController();
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!authorized(request.headers.authorization, options.token)) {
      respond(response, 401, { error: { code: 'UNAUTHENTICATED' } });
      return;
    }
    if (request.method === 'POST') response.shouldKeepAlive = false; // Never retain an unread request on a pooled socket.
    if (inFlight.requests >= inFlightRequestLimit || heapAboveWatermark()) {
      // New work is refused while the process is saturated; dispatched results stay owned.
      respond(response, 429, { error: { code: 'QUERY_LIMIT' } });
      return;
    }
    inFlight.requests++;
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    request.once('aborted', disconnect);
    response.once('close', disconnect);
    if (request.aborted || response.destroyed) controller.abort();
    try {
      if (request.method !== 'GET' && request.method !== 'POST') {
        respond(response, 400, { error: { code: 'INVALID_INPUT' } });
        return;
      }
      const path = request.url ?? '/';
      if (path.length > 8192 || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('#')) throw new BoundaryError('INVALID_INPUT');
      const url = new URL(path, 'http://127.0.0.1');
      if (request.method === 'POST' && url.pathname === '/v2/workspaces' && !url.search) {
        if (!projects) throw new BoundaryError('STATE_UNAVAILABLE');
        const body = await boundedBody(request, controller.signal, 64_000);
        respond(response, 200, projects.handle(JSON.parse(body)));
        return;
      }
      if (request.method === 'GET' && (request.headers['transfer-encoding'] || (request.headers['content-length'] && request.headers['content-length'] !== '0'))) throw new BoundaryError('INVALID_INPUT');
      if (request.method === 'GET' && url.pathname === '/v2/status/requests' && !url.search) {
        respond(response, 200, { protocol: 2, kind: 'request-diagnostics', serviceGeneration: options.serviceGeneration, ...options.resources.diagnostics() });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v2/status/stop-gate' && !url.search) {
        // Read-only stop-gate aggregate (M5/M7 spec): live sessions + in-flight/unknown ledger
        // counts + manual-check cleanups. Counts only — never record content, targets or
        // credentials; an empty list is distinguishable from 'no data' via the per-source keys.
        const summary = (counts: Record<string, number> | undefined) => counts ?? { unavailable: 1 };
        respond(response, 200, {
          protocol: 2, kind: 'stop-gate', serviceGeneration: options.serviceGeneration, at: Date.now(),
          sessions: options.sessionService.gateStatus(),
          writes: {
            applyFile: summary(options.applyFiles.counts?.()), imageRun: summary(options.imageRuns.counts?.()), gitSync: summary(options.gitSyncs.counts?.()),
            helmCluster: summary(options.helmClusterWrites.counts?.()), mergeKubeconfig: summary(options.mergeKubeconfigs.counts?.()),
            cluster: summary(options.clusterOperations.counts?.()),
            delete: summary(options.operations.counts()), namespace: summary(options.namespaces.counts()), namespaceDelete: summary(options.namespaceDeletes.counts()),
            useContext: summary(options.contexts.counts()), contextDelete: summary(options.contextDeletes.counts()),
            manifestCreate: summary(options.manifestCreates.counts()), manifestApply: summary(options.manifestApplies.counts()),
            scale: summary(options.scales.counts()), cronJobRun: summary(options.cronJobRuns.counts()), expose: summary(options.exposes.counts()),
            configFileDelete: summary(options.configFileDeletes.counts()), configFileAdd: summary(options.configFileAdds.counts()),
            fileDelete: summary(options.fileDeletes.counts()), fileSave: summary(options.fileSaves.counts()),
          },
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/health' && !url.search) {
        respond(response, 200, healthSchema.parse({ protocol: protocolVersion, status: 'ready', serviceGeneration: options.serviceGeneration, version: __K8S_EXTENSION_VERSION__, compatibility: '2.5.1' }));
        return;
      }
      if (request.method === 'POST' && ['/v2/workspace-files/open', '/v2/workspace-files/read', '/v2/workspace-files/release', '/v2/workspace-files/rebind', '/v2/workspace-files/list'].includes(url.pathname) && !url.search) {
        const text = await boundedBody(request, controller.signal, 48_000); let input: unknown;
        try { input = JSON.parse(text); } catch { throw new BoundaryError('INVALID_INPUT'); }
        const result = url.pathname === '/v2/workspace-files/open' ? await options.workspace.open(input, controller.signal)
          : url.pathname === '/v2/workspace-files/read' ? await options.workspace.read(input, controller.signal)
          : url.pathname === '/v2/workspace-files/rebind' ? await options.workspace.rebind(input, controller.signal)
          : url.pathname === '/v2/workspace-files/list' ? await options.workspace.list(input, controller.signal) : options.workspace.release(input);
        respond(response, 200, result); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/file-save' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 48_000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.fileSaves.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/manifest-create' && !url.search) {
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.manifestCreates.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/manifest-apply' && !url.search) {
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.manifestApplies.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/scale' && !url.search) {
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.scales.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/cronjob-run' && !url.search) {
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.cronJobRuns.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/expose' && !url.search) {
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.exposes.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/config-file-delete' && !url.search) {
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.configFileDeletes.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/config-file-add' && !url.search) {
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.configFileAdds.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/provider-flows' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 17_000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 17_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.providerFlows.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/cluster' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 48_000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.clusterOperations.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/merge-kubeconfig' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 52_000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 52_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.mergeKubeconfigs.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/helm-cluster-write' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 48_000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmClusterWrites.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/sessions/handle' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 48_000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.sessionService.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/image-run' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 12_000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 12_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.imageRuns.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/git-sync' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 12_000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 12_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.gitSyncs.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/apply-file' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 48_000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.applyFiles.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/file-delete' && !url.search) {
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.fileDeletes.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/manifest-diff/read' && !url.search) {
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.resources.readManifestDiff(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/version' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 2000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 2000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmVersions.read(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/repo-refresh' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 2000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 2000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmRefreshes.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/inspect-chart' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 2000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 2000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmInspects.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/fetch-values' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 2000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 2000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmValues.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/dependencies' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 2000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 2000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmDependencies.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/lint' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 2000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 2000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmLints.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/template' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 2000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 2000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmTemplates.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/dry-run' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 2000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 2000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmDryRuns.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/package' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 2000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 2000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmPackages.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/dep-up' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 2000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 2000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmDepUps.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/create' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 2000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 2000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmCreates.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/fetch' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 2000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 2000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmFetches.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/requirement' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 2000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 2000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmRequirements.read(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/convert-template' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 48_000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmConverts.handle(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/parameterise' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 48_000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown; try { input = JSON.parse(await boundedBody(request, controller.signal, 48_000)); }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmParameterises.read(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/releases/read' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 12_000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 12_000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.resources.readHelmReleases(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/helm/repositories/read' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 12_000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, 12_000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.helmRepositories.read(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/configuration/files' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > 12_000)) throw new BoundaryError('BUDGET_EXCEEDED');
        let body: unknown;
        try { body = JSON.parse(await boundedBody(request, controller.signal, 12_000)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.sourcePicker.read(body, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/inspection/read' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > resourceRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, resourceRequestBytes)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.resources.readInspection(input, controller.signal)); return;
      }
      if (request.method === 'POST' && ['/v2/watch/open', '/v2/watch/poll', '/v2/watch/release'].includes(url.pathname) && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > resourceRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, resourceRequestBytes)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        const result = url.pathname === '/v2/watch/open' ? await options.resources.openWatch(input, controller.signal)
          : url.pathname === '/v2/watch/poll' ? await options.resources.pollWatch(input, controller.signal) : options.resources.releaseWatch(input);
        respond(response, 200, result); return;
      }
      if (request.method === 'POST' && ['/v2/logs/follow/open', '/v2/logs/follow/poll', '/v2/logs/follow/release'].includes(url.pathname) && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > resourceRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, resourceRequestBytes)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        const result = url.pathname === '/v2/logs/follow/open' ? await options.resources.openLogFollow(input, controller.signal)
          : url.pathname === '/v2/logs/follow/poll' ? await options.resources.pollLogFollow(input, controller.signal) : options.resources.releaseLogFollow(input);
        respond(response, 200, result); return;
      }
      if (request.method === 'POST' && ['/v2/logs/job/open', '/v2/logs/job/poll', '/v2/logs/job/release'].includes(url.pathname) && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > resourceRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, resourceRequestBytes)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        const result = url.pathname === '/v2/logs/job/open' ? await options.resources.openJobLogSelection(input, controller.signal)
          : url.pathname === '/v2/logs/job/poll' ? await options.resources.pollJobLogSelection(input, controller.signal) : options.resources.releaseJobLogSelection(input);
        respond(response, 200, result); return;
      }
      if (request.method === 'POST' && ['/v2/events/follow/open', '/v2/events/follow/poll', '/v2/events/follow/release'].includes(url.pathname) && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > resourceRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, resourceRequestBytes)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        const result = url.pathname === '/v2/events/follow/open' ? await options.resources.openEventFollow(input, controller.signal)
          : url.pathname === '/v2/events/follow/poll' ? await options.resources.pollEventFollow(input, controller.signal) : options.resources.releaseEventFollow(input);
        respond(response, 200, result); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/explain/read' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > resourceRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal, resourceRequestBytes)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.resources.explain(input, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/configuration/contexts' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > configRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
        let input: unknown;
        try { input = JSON.parse(await boundedBody(request, controller.signal)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        const parsed = contextChoiceRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const body = parsed.data;
        const key = options.config.selectionKey(body.selection);
        const result = await reads.run([options.serviceGeneration, key], signal => options.config.read(body.selection, signal), { signal: controller.signal });
        respond(response, 200, projectContextChoices(result, options.serviceGeneration, body)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/delete' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > resourceRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
        let body: unknown;
        try { body = JSON.parse(await boundedBody(request, controller.signal, resourceRequestBytes)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.operations.handle(body, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/namespace' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > resourceRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
        let body: unknown;
        try { body = JSON.parse(await boundedBody(request, controller.signal, resourceRequestBytes)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.namespaces.handle(body, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/context' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > resourceRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
        let body: unknown;
        try { body = JSON.parse(await boundedBody(request, controller.signal, resourceRequestBytes)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.contexts.handle(body, controller.signal)); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/context-delete' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > resourceRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
        let body: unknown;
        try { body = JSON.parse(await boundedBody(request, controller.signal, resourceRequestBytes)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.contextDeletes.handle(body, controller.signal)); return;
      }
      if (request.method === 'POST' && ['/v2/preferences/read', '/v2/preferences/append'].includes(url.pathname) && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > resourceRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
        let body: unknown;
        try { body = JSON.parse(await boundedBody(request, controller.signal, resourceRequestBytes)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        if (url.pathname === '/v2/preferences/read') {
          const parsed = preferenceReadRequestSchema.safeParse(body); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
          if (parsed.data.serviceGeneration !== options.serviceGeneration) throw new BoundaryError('STALE_TARGET');
          const read = parsed.data;
          const value = await preferenceReads.run([read.serviceGeneration, read.kind, read.kind === 'get' ? read.id : 'all'], async signal => read.kind === 'keys'
            ? { kind: 'keys', keys: await options.preferences.keys(signal) }
            : { kind: 'get', revision: await options.preferences.get(read.id, signal) ?? null }, { signal: controller.signal });
          respond(response, 200, { protocol: 2, serviceGeneration: options.serviceGeneration, ...value }); return;
        }
        const parsed = preferenceAppendRequestSchema.safeParse(body); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const value = parsed.data;
        if (value.serviceGeneration !== options.serviceGeneration) throw new BoundaryError('STALE_TARGET');
        const appendSignal = AbortSignal.any([controller.signal, preferenceShutdown.signal]);
        const verify = async () => {
          if (appendSignal.aborted) throw new BoundaryError('QUERY_CANCELLED');
          if (Date.now() >= value.notAfter || value.notAfter > Date.now() + 60_000) throw new BoundaryError('CONFIRMATION_EXPIRED');
          if (value.step === 'active') {
            if (JSON.stringify(value.selection) !== JSON.stringify(value.revision.preferences.active)) throw new BoundaryError('INVALID_INPUT');
            const configuration = await options.config.privateRead(value.selection, value.configIdentity, appendSignal);
            if (configuration.publicRead.status !== 'ready' || configuration.publicRead.sources.missingCount) throw new BoundaryError('CONFIG_NOT_FOUND');
          }
          if (appendSignal.aborted) throw new BoundaryError('QUERY_CANCELLED');
          if (Date.now() >= value.notAfter) throw new BoundaryError('CONFIRMATION_EXPIRED');
        };
        await options.lock.run(appendSignal, async () => { await verify(); await options.preferences.append(value.revision, value.step, verify, appendSignal); });
        respond(response, 200, { protocol: 2, serviceGeneration: options.serviceGeneration, kind: 'stored', id: value.revision.id }); return;
      }
      if (request.method === 'POST' && url.pathname === '/v2/operations/namespace-delete' && !url.search) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > resourceRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
        let body: unknown;
        try { body = JSON.parse(await boundedBody(request, controller.signal, resourceRequestBytes)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        respond(response, 200, await options.namespaceDeletes.handle(body, controller.signal)); return;
      }
      const readPriorityAllowed = (url.pathname === '/v2/resources/read' || url.pathname === '/v2/tree/read')
        && (!url.search || url.search === '?priority=background' || url.search === '?priority=manual');
      if (request.method === 'POST' && ['/v2/resources/read', '/v2/tree/read', '/v2/keys/read', '/v2/logs/read', '/v2/events/read', '/v2/documents/read'].includes(url.pathname) && (readPriorityAllowed || !url.search)) {
        const length = request.headers['content-length'];
        if (length && (!/^\d{1,6}$/.test(length) || Number(length) > resourceRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
        let body: unknown;
        try { body = JSON.parse(await boundedBody(request, controller.signal, resourceRequestBytes)) as unknown; }
        catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('INVALID_INPUT'); }
        const priority = url.searchParams.get('priority') === 'background' ? 'background' : 'manual';
        respond(response, 200, await options.resources.withPriority(priority, () => (url.pathname === '/v2/documents/read' ? options.resources.readDocument(body, controller.signal)
          : url.pathname === '/v2/events/read' ? options.resources.readEvents(body, controller.signal)
          : url.pathname === '/v2/logs/read' ? options.resources.readLogs(body, controller.signal)
          : url.pathname === '/v2/keys/read' ? options.resources.readKey(body, controller.signal)
          : url.pathname === '/v2/tree/read' ? options.resources.readTree(body, controller.signal) : options.resources.read(body, controller.signal))));
        return;
      }
      if ((request.method === 'GET' && url.pathname === '/v2/configuration')
        || (request.method === 'POST' && url.pathname === '/v2/configuration/read' && !url.search)) {
        let selection: ConfigSelection = { mode: 'default' };
        let query: ReturnType<typeof parseConfigPageQuery>;
        if (request.method === 'POST') {
          const length = request.headers['content-length'];
          if (length && (!/^\d{1,6}$/.test(length) || Number(length) > configRequestBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
          const body = parseConfigReadRequest(await boundedBody(request, controller.signal));
          selection = body.selection;
          query = { offset: body.page.offset, limit: body.page.limit, ...(body.page.configIdentity !== undefined ? { configIdentity: body.page.configIdentity } : {}) };
        } else query = parseConfigPageQuery(url.searchParams);
        // Selection is per request, never a persisted/global current kubeconfig or authenticated owner.
        const key = options.config.selectionKey(selection);
        const result = await reads.run([options.serviceGeneration, key], signal => options.config.read(selection, signal), { signal: controller.signal });
        respond(response, 200, projectConfigPage(result, options.serviceGeneration, query));
        return;
      }
      respond(response, 404, { error: { code: 'NOT_FOUND' } });
    } catch (error) {
      const code = error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE';
      const status = code === 'QUERY_LIMIT' ? 429 : code === 'QUERY_TIMEOUT' ? 504 : ['SERVICE_CLOSED', 'CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'READ_TRANSPORT_UNAVAILABLE'].includes(code) ? 503 : isBudgetError(code) ? 413
        : code === 'UNAUTHENTICATED' ? 401 : code === 'FORBIDDEN' ? 403 : code === 'NOT_FOUND' ? 404 : code === 'CONTINUATION_EXPIRED' ? 410
        : ['AUTHENTICATION_UNAVAILABLE', 'AUTH_PLUGIN_NOT_FOUND'].includes(code) ? 412 : ['STALE_TARGET', 'CONFIG_CHANGED'].includes(code) ? 409 : error instanceof BoundaryError ? 400 : 500;
      respond(response, status, { error: { code } });
    } finally {
      inFlight.requests--;
      request.removeListener('aborted', disconnect);
      response.removeListener('close', disconnect);
    }
  };
  return { handle, close: () => { preferenceShutdown.abort(); options.helmParameterises.close(); options.helmConverts.close(); options.helmRequirements.close(); options.helmFetches.close(); options.helmCreates.close(); options.helmDepUps.close(); options.helmPackages.close(); options.helmDryRuns.close(); options.helmTemplates.close(); options.helmLints.close(); options.helmDependencies.close(); options.helmValues.close(); options.helmInspects.close(); options.helmRefreshes.close(); options.fileDeletes.close(); options.applyFiles.close(); options.imageRuns.close(); options.gitSyncs.close(); options.sessionService.close(); options.helmClusterWrites.close(); options.mergeKubeconfigs.close(); options.clusterOperations.close(); options.providerFlows.close(); options.configFileAdds.close(); options.configFileDeletes.close(); options.exposes.close(); options.cronJobRuns.close(); options.scales.close(); options.manifestApplies.close(); options.manifestCreates.close(); options.fileSaves.close(); options.workspace.close(); options.helmVersions.close(); options.helmRepositories.close(); options.sourcePicker.close(); options.contextDeletes.close(); options.contexts.close(); options.namespaceDeletes.close(); options.namespaces.close(); options.operations.close(); preferenceReads.close(); reads.close(); options.resources.close(); } };
}
