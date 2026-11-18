import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { discoverDefaultConfig } from '../queries/config-discovery.ts';
import { createConfigReader } from '../queries/config-source.ts';
import { createServiceHandler } from './http.ts';
import { createKubectlReadAdapter } from '../adapters/kubectl-read.ts';
import { createResourceGateway } from '../queries/resource-gateway.ts';
import { runReadWorker } from '../adapters/read-worker.ts';
import { readWorkerFlag } from '../queries/read-worker-protocol.ts';
import { createDeleteOperations } from '../operations/delete.ts';
import { createKubectlDeleteAdapter } from '../adapters/kubectl-delete.ts';
import { runDeleteWorker } from '../adapters/delete-worker.ts';
import { deleteWorkerFlag } from '../operations/delete-worker-protocol.ts';
import { ConfigurationWriteLock } from '../operations/configuration-lock.ts';
import { createNamespaceOperations } from '../operations/namespace.ts';
import { createNamespaceFileAdapter } from '../adapters/namespace-file.ts';
import { createNamespaceDeleteOperations } from '../operations/namespace-delete.ts';
import { createContextOperations } from '../operations/context.ts';
import { createPreferenceStore } from '../adapters/preference-store.ts';
import { createContextDeleteOperations } from '../operations/context-delete.ts';
import { createSourcePicker } from '../queries/source-picker.ts';
import { readSourceDirectory } from '../adapters/source-directory.ts';
import { createKubectlWatchAdapter } from '../adapters/kubectl-watch.ts';
import { createHelmRepositoryReader } from '../queries/helm-repositories.ts';
import { createHelmVersionReader } from '../queries/helm-version-reader.ts';
import { createHelmVersionCliRunner } from '../adapters/helm-version-cli.ts';
import { createHelmRefreshOperations } from '../operations/helm-refresh.ts';
import { createHelmRepoRefreshRunner } from '../adapters/helm-repo-refresh-cli.ts';
import { createHelmInspectOperations } from '../operations/helm-inspect.ts';
import { createHelmInspectRunner } from '../adapters/helm-inspect-cli.ts';
import { createHelmValuesOperations } from '../operations/helm-values.ts';
import { createHelmValuesRunner } from '../adapters/helm-values-cli.ts';
import { createHelmDependenciesOperations } from '../operations/helm-dependencies.ts';
import { createHelmDependenciesRunner } from '../adapters/helm-dependencies-cli.ts';
import { createHelmLintOperations } from '../operations/helm-lint.ts';
import { createHelmLintRunner } from '../adapters/helm-lint-cli.ts';
import { createHelmTemplateOperations } from '../operations/helm-template.ts';
import { createHelmTemplateRunner } from '../adapters/helm-template-cli.ts';
import { createHelmDryRunOperations } from '../operations/helm-dryrun.ts';
import { createHelmDryRunRunner } from '../adapters/helm-dryrun-cli.ts';
import { createHelmPackageOperations } from '../operations/helm-package.ts';
import { createHelmPackageRunner } from '../adapters/helm-package-cli.ts';
import { createHelmDepUpOperations } from '../operations/helm-depup.ts';
import { createHelmDepUpRunner } from '../adapters/helm-depup-cli.ts';
import { createHelmCreateOperations } from '../operations/helm-create.ts';
import { createHelmCreateRunner } from '../adapters/helm-create-cli.ts';
import { createHelmFetchOperations } from '../operations/helm-fetch.ts';
import { createHelmFetchRunner } from '../adapters/helm-fetch-cli.ts';
import { createHelmRequirementReader } from '../queries/helm-requirement-reader.ts';
import { createHelmConvertOperations } from '../operations/helm-convert.ts';
import { createHelmTemplateWriteRunner } from '../adapters/helm-template-write.ts';
import { createHelmParameteriseReader } from '../queries/helm-parameterise-reader.ts';
import { readHelmRepositoryFile } from '../adapters/helm-repository-file.ts';
import { discoverHelmRepositories } from '../queries/helm-repository-discovery.ts';
import type { HelmRepositoryEnvironment } from '../queries/helm-repository-discovery.ts';
import { createWorkspaceReader } from '../queries/workspace-reader.ts';
import { createWorkspaceFileReadBackend } from '../adapters/workspace-file-read.ts';
import { createWorkspaceFileWriter } from '../adapters/workspace-file-write.ts';
import { createFileSaveOperations } from '../operations/file-save.ts';
import { createManifestCreateOperations } from '../operations/manifest-create.ts';
import { createKubectlManifestCreateAdapter } from '../adapters/kubectl-manifest-create.ts';
import { runManifestCreateWorker } from '../adapters/manifest-create-worker.ts';
import { manifestCreateWorkerFlag } from '../operations/manifest-create-worker-protocol.ts';
import { createManifestApplyOperations } from '../operations/manifest-apply.ts';
import { createManifestApplyHttpsAdapter } from '../adapters/manifest-apply-https.ts';
import { createScaleOperations } from '../operations/scale.ts';
import { createScaleHttpsAdapter } from '../adapters/scale-https.ts';
import { createCronJobRunOperations } from '../operations/cronjob-run.ts';
import { createCronJobRunHttpsAdapter } from '../adapters/cronjob-run-https.ts';
import { createExposeOperations } from '../operations/expose.ts';
import { createExposeHttpsAdapter } from '../adapters/expose-https.ts';
import { createConfigFileDeleteOperations } from '../operations/config-file-delete.ts';
import { createConfigFileDeleteHttpsAdapter } from '../adapters/config-file-delete-https.ts';
import { createConfigFileAddOperations } from '../operations/config-file-add.ts';
import { createConfigFileAddHttpsAdapter } from '../adapters/config-file-add-https.ts';
import { createFileDeleteOperations } from '../operations/file-delete.ts';
import { createApplyFileOperations } from '../operations/apply-file.ts';
import { createApplyFileHttpsAdapter } from '../adapters/apply-file-https.ts';
import { createImageRunOperations } from '../operations/image-run.ts';
import { createImageRunAdapter } from '../adapters/image-run-cli.ts';
import { createGitSyncOperations } from '../operations/sync-checkout.ts';
import { createGitCliRunner } from '../adapters/git-cli.ts';
import { createSessionService } from '../sessions/session-service.ts';
import { createHelmClusterWriteOperations } from '../operations/helm-cluster-write.ts';
import { createHelmClusterCliRunner } from '../adapters/helm-cluster-cli.ts';
import { createMergeKubeconfigOperations } from '../operations/merge-kubeconfig.ts';
import { createMergeKubeconfigFileAdapter } from '../adapters/merge-kubeconfig-file.ts';
import { createClusterOperations } from '../operations/cluster-operations.ts';
import { createMinikubeCliRunner } from '../adapters/minikube-cli.ts';
import { createTelepresenceCliRunner } from '../adapters/telepresence-cli.ts';
import { createProviderFlowOperations } from '../operations/provider-flows.ts';
import { createHelmTemplatePreviewRunner } from '../adapters/helm-template-cli.ts';
import { createFileDeleteHttpsAdapter } from '../adapters/file-delete-https.ts';
import { createAutomaticCredentials, authenticationEnvironment } from '../adapters/automatic-credentials.ts';
import { createProjectWorkspaces } from '../queries/project-workspaces.ts';
import { createResidentProjectRuntime } from './project-runtime.ts';
import { sessionProxyResponseBytes } from '../../shared/session-wire.ts';

export async function startService(environment: { port: string; token: string; home: string; path: string; cwd: string; kubeconfig?: string; authentication?: Record<string, string>; helm?: Omit<HelmRepositoryEnvironment, 'home' | 'cwd' | 'platform'> }): Promise<void> {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('RUNTIME_INCOMPATIBLE');
  if (!/^\d{1,5}$/.test(environment.port) || Number(environment.port) < 1 || Number(environment.port) > 65535 || !/^[a-f0-9]{48}$/.test(environment.token)) throw new Error('SERVICE_ENV_INVALID');
  const credentials = createAutomaticCredentials({ ...environment.authentication, HOME: environment.home, PATH: environment.path });
  const defaultPaths = discoverDefaultConfig(environment).paths, config = createConfigReader(defaultPaths, undefined, credentials.resolve, credentials.reject);
  const serviceGeneration = randomUUID();
  const resources = createResourceGateway({ config, serviceGeneration, read: createKubectlReadAdapter(config, environment.path, new URL(import.meta.url)), watch: createKubectlWatchAdapter(config, environment.path, new URL(import.meta.url)) });
  const lock = new ConfigurationWriteLock();
  const files = createNamespaceFileAdapter(defaultPaths), executeDelete = createKubectlDeleteAdapter(config, environment.path, new URL(import.meta.url));
  const operations = createDeleteOperations({ serviceGeneration, config, resources, execute: createKubectlDeleteAdapter(config, environment.path, new URL(import.meta.url)), lock });
  const namespaces = createNamespaceOperations({ serviceGeneration, config, files, lock });
  const namespaceDeletes = createNamespaceDeleteOperations({ serviceGeneration, config, resources, files, lock, execute: executeDelete });
  const contexts = createContextOperations({ serviceGeneration, config, files, lock });
  const contextDeletes = createContextDeleteOperations({ serviceGeneration, config, files, lock });
  const preferences = createPreferenceStore(environment.home);
  const sourcePicker = createSourcePicker(serviceGeneration, readSourceDirectory);
  const helmEnvironment = Object.freeze({ ...environment.helm, home: environment.home, cwd: environment.cwd, platform: process.platform });
  const helmRepositories = createHelmRepositoryReader(serviceGeneration, readHelmRepositoryFile, () => discoverHelmRepositories(helmEnvironment));
  const helmVersions = createHelmVersionReader(createHelmVersionCliRunner(environment.path));
  const helmRefreshes = createHelmRefreshOperations({ run: createHelmRepoRefreshRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) });
  const helmInspects = createHelmInspectOperations({ run: createHelmInspectRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment), syntax: async probeSignal => (await helmVersions.read({ protocol: 2, kind: 'read' }, probeSignal)).syntax });
  const helmValues = createHelmValuesOperations({ run: createHelmValuesRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) });
  const helmDependencies = createHelmDependenciesOperations({ run: createHelmDependenciesRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) });
  const helmLints = createHelmLintOperations({ run: createHelmLintRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) });
  const helmTemplates = createHelmTemplateOperations({ run: createHelmTemplateRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) });
  const helmDryRuns = createHelmDryRunOperations({ run: createHelmDryRunRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment), syntax: async probeSignal => (await helmVersions.read({ protocol: 2, kind: 'read' }, probeSignal)).syntax });
  const helmPackages = createHelmPackageOperations({ run: createHelmPackageRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) });
  const helmDepUps = createHelmDepUpOperations({ run: createHelmDepUpRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) });
  const helmCreates = createHelmCreateOperations({ run: createHelmCreateRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) });
  const helmFetches = createHelmFetchOperations({ run: createHelmFetchRunner(environment.path, environment.home), defaults: () => discoverHelmRepositories(helmEnvironment) });
  const helmRequirements = createHelmRequirementReader(readHelmRepositoryFile, () => discoverHelmRepositories(helmEnvironment));
  const helmConverts = createHelmConvertOperations({ run: createHelmTemplateWriteRunner() });
  const helmParameterises = createHelmParameteriseReader();
  const workspace = createWorkspaceReader(serviceGeneration, createWorkspaceFileReadBackend());
  const fileSaves = createFileSaveOperations({ generation: serviceGeneration, files: createWorkspaceFileWriter(), workspace, lock });
  const manifestCreates = createManifestCreateOperations({ generation: serviceGeneration, config, resources, lock, workspace, fileSaves, execute: createKubectlManifestCreateAdapter(config, environment.path, new URL(import.meta.url)) });
  const manifestApplies = createManifestApplyOperations({ generation: serviceGeneration, config, resources, lock, adapter: createManifestApplyHttpsAdapter(config) });
  const scales = createScaleOperations({ serviceGeneration, config, resources, lock, execute: createScaleHttpsAdapter(config) });
  const cronJobRuns = createCronJobRunOperations({ serviceGeneration, config, resources, lock, execute: createCronJobRunHttpsAdapter(config) });
  const exposes = createExposeOperations({ serviceGeneration, config, resources, lock, execute: createExposeHttpsAdapter(config) });
  const configFileDeletes = createConfigFileDeleteOperations({ serviceGeneration, config, resources, lock, execute: createConfigFileDeleteHttpsAdapter(config) });
  const configFileAdds = createConfigFileAddOperations({ serviceGeneration, config, resources, lock, workspace, fileSaves, execute: createConfigFileAddHttpsAdapter(config) });
  const fileDeletes = createFileDeleteOperations({ serviceGeneration, config, resources, lock, workspace, fileSaves, execute: createFileDeleteHttpsAdapter(config) });
  const applyFiles = createApplyFileOperations({ serviceGeneration, config, resources, workspace, lock, execute: createApplyFileHttpsAdapter(config) });
  const imageRuns = createImageRunOperations({ serviceGeneration, config, lock, execute: createImageRunAdapter(config) });
  const gitCli = createGitCliRunner(environment.path);
  const gitSyncs = createGitSyncOperations({ serviceGeneration, config, lock, probe: gitCli.whenCreated, checkout: gitCli.checkout });
  const sessionService = createSessionService({ serviceGeneration, config, resources });
  const helmClusterWrites = createHelmClusterWriteOperations({ serviceGeneration, config, resources, lock, execute: createHelmClusterCliRunner(environment.path, config) });
  const mergeKubeconfigs = createMergeKubeconfigOperations({ serviceGeneration, defaultPaths, lock, files: createMergeKubeconfigFileAdapter() });
  const clusterOperations = createClusterOperations({ serviceGeneration, lock, minikube: createMinikubeCliRunner(environment.path), telepresence: createTelepresenceCliRunner(environment.path), sessions: sessionService });
  const providerFlows = createProviderFlowOperations({ workspace, previewRun: createHelmTemplatePreviewRunner(environment.path, environment.home), syntax: async probeSignal => (await helmVersions.read({ protocol: 2, kind: 'read' }, probeSignal)).syntax === 'v2' ? 2 : 3, minikube: createMinikubeCliRunner(environment.path) });
  const projectWorkspaces = createProjectWorkspaces({
    generation: serviceGeneration,
    create: input => createResidentProjectRuntime({
      ...input,
      // In-process project controllers reuse exactly the authenticated, bounded
      // existing API. No new cluster transport, credentials, or budget per project.
      request: async request => {
        const sessionKind = request.path === '/v2/sessions/handle' && request.body !== undefined ? (JSON.parse(request.body) as { kind?: string }).kind : undefined;
        const proxy = sessionKind === 'proxy';
        const maximum = proxy ? sessionProxyResponseBytes : 512_000;
        const response = await fetch(`http://127.0.0.1:${environment.port}${request.path}`, {
          method: request.method, headers: { Authorization: `Bearer ${environment.token}`, 'Content-Type': 'application/json' },
          // Private service-owned opening job only; browser workspace admission
          // and the SDK's short host contract remain unchanged.
          ...(request.body === undefined ? {} : { body: request.body }), signal: AbortSignal.timeout(sessionKind === 'open' ? 120_000 : 20_000), redirect: 'error',
        });
        const chunks: Uint8Array[] = []; let bytes = 0;
        if (response.body) for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > maximum) { await response.body.cancel().catch(() => {}); throw new Error('BUDGET_EXCEEDED'); }
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        return { status: response.status, body };
      },
    }),
  });
  const handler = createServiceHandler(Object.assign({ token: environment.token, serviceGeneration, config, resources, operations, namespaces, namespaceDeletes, contexts, contextDeletes, preferences, lock, sourcePicker, helmRepositories, helmVersions, helmRefreshes, helmInspects, helmValues, helmDependencies, helmLints, helmTemplates, helmDryRuns, helmPackages, helmDepUps, helmCreates, helmFetches, helmRequirements, helmConverts, helmParameterises, workspace, fileSaves, manifestCreates, manifestApplies, scales, cronJobRuns, exposes, configFileDeletes, configFileAdds, fileDeletes, applyFiles, imageRuns, gitSyncs, sessionService, helmClusterWrites, mergeKubeconfigs, clusterOperations, providerFlows }, { projectWorkspaces }));
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 5_000, maxHeaderSize: 8192 }, (request, response) => { void handler.handle(request, response); });
  server.maxConnections = 64;
  server.maxHeadersCount = 64;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(environment.port), '127.0.0.1', resolve);
  });
  const shutdown = () => {
    // Cancel only unsubmitted work. Dispatched results stay owned; no rollback or business cleanup.
    projectWorkspaces.close();
    handler.close();
    credentials.close();
    server.close();
    server.closeIdleConnections();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

  if (import.meta.main) {
  if (process.argv.length === 3 && process.argv[2] === readWorkerFlag) {
    await runReadWorker();
  } else if (process.argv.length === 3 && process.argv[2] === deleteWorkerFlag) {
    await runDeleteWorker();
  } else if (process.argv.length === 3 && process.argv[2] === manifestCreateWorkerFlag) {
    await runManifestCreateWorker();
  } else {
    if (process.argv.length !== 2) throw new Error('SERVICE_ENV_INVALID');
    const port = process.env.OPENCHAMBER_SERVICE_PORT;
    const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
    const home = process.env.HOME;
    if (!port || !token || !home) throw new Error('SERVICE_ENV_MISSING');
    const kubeconfig = process.env.KUBECONFIG; // Only this service's actual input; no shell/parent environment discovery.
    await startService({ port, token, home, path: process.env.PATH ?? '', cwd: process.cwd(), ...(kubeconfig === undefined ? {} : { kubeconfig }),
      authentication: authenticationEnvironment(process.env),
      // Read only these non-secret path inputs actually supplied to THIS service. The official host need not forward HELM_*.
      helm: { repositoryConfig: process.env.HELM_REPOSITORY_CONFIG, repositoryCache: process.env.HELM_REPOSITORY_CACHE,
        configHome: process.env.HELM_CONFIG_HOME, cacheHome: process.env.HELM_CACHE_HOME, xdgConfigHome: process.env.XDG_CONFIG_HOME, xdgCacheHome: process.env.XDG_CACHE_HOME } });
  }
}
