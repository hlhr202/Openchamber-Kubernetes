import { GUEST_CLIPBOARD_TEXT_MAX } from '@openchamber/sdk';
import type { ProjectRuntimeHost } from '../shared/project-runtime-host.ts';
import { SessionTargetClient } from './session-target-client.ts';
import { forwardSelectionKey, sessionOpenTarget, sessionReferenceSchema } from '../shared/session-target.ts';
import type { SessionTargetState } from '../shared/session-target.ts';
type SessionOverview = { sessions: { id: string; kind: string; target: { namespace: string; podName?: string; podUid?: string; container?: string; original?: { resource: string; namespace: string; name: string } }; detached: boolean; closed: boolean; leaseExpiresAt: number; forwarded?: { local: number; remote: number }[] }[];
  events: { id: string; kind: string; reason: string; at: number }[]; error?: ErrorCode };
import { HostSnapshotLifecycle } from './host-snapshot-lifecycle.ts';
import { ConfigurationClient } from './configuration-client.ts';
import type { ConfigurationState } from './configuration-client.ts';
import { ResourceClient } from './resource-client.ts';
import type { ResourceState } from './resource-client.ts';
import { BranchClient } from './branch-client.ts';
import type { BranchState } from './branch-client.ts';
import type { DefinitionReference, ParentReference } from '../shared/branch-protocol.ts';
import { TreeController } from './tree-controller.ts';
import type { TreeSnapshot } from './tree-controller.ts';
import { configurationReadTarget, protocolVersion } from '../shared/protocol.ts';
import { resourceDescriptors } from '../shared/tree.ts';
import { KeyContentClient } from './key-content-client.ts';
import type { KeyContentState } from './key-content-client.ts';
import type { KeyReference } from '../shared/key-content-protocol.ts';
import { PodLogClient } from './pod-log-client.ts';
import type { PodLogState } from './pod-log-client.ts';
import type { JobLogOrigin, PodLogReference } from '../shared/pod-log-protocol.ts';
import { EventClient } from './event-client.ts';
import type { EventState } from './event-client.ts';
import type { EventScope } from '../shared/event-protocol.ts';
import { DocumentClient } from './document-client.ts';
import { documentReferenceFromNode, documentReferenceId } from '../shared/document-protocol.ts';
import type { DocumentState } from './document-client.ts';
import type { LoadDocumentReference } from '../shared/document-protocol.ts';
import { DeleteClient } from './delete-client.ts';
import type { DeleteState } from './delete-client.ts';
import type { DeleteParameters } from '../shared/delete-protocol.ts';
import { NamespaceClient } from './namespace-client.ts';
import type { NamespaceState, NamespaceSwitchState } from './namespace-client.ts';
import { NamespaceDeleteClient } from './namespace-delete-client.ts';
import type { NamespaceDeleteState } from './namespace-delete-client.ts';
import type { NamespaceDeleteReference } from '../shared/namespace-inventory.ts';
import { ContextClient } from './context-client.ts';
import type { ContextState } from './context-client.ts';
import { PreferenceClient } from './preference-client.ts';
import type { PreferenceOutcome, PreferenceState } from './preference-client.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { createPreferenceTransport } from './preference-transport.ts';
import { ContextDeleteClient } from './context-delete-client.ts';
import type { ContextDeleteState } from './context-delete-client.ts';
import { SourcePickerClient } from './source-picker-client.ts';
import type { SourcePickerState } from './source-picker-client.ts';
import { ContextChoiceClient } from './context-choice-client.ts';
import type { ContextChoiceState } from './context-choice-client.ts';
import { InspectionClient } from './inspection-client.ts';
import type { InspectionState } from './inspection-client.ts';
import { ExplainClient } from './explain-client.ts';
import type { ExplainState } from './explain-client.ts';
import { explanationRequest } from './document-fields.ts';
import { BoundaryError } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { namespaceName, sameTarget } from '../shared/identity.ts';
import type { TargetIdentity } from '../shared/identity.ts';
import { compareDocumentText } from '../shared/text-comparison.ts';
import { WatchClient } from './watch-client.ts';
import type { WatchState } from './watch-client.ts';
import { LogFollowClient } from './log-follow-client.ts';
import type { LogFollowState } from './log-follow-client.ts';
import { EventFollowClient } from './event-follow-client.ts';
import type { EventFollowState } from './event-follow-client.ts';
import { JobLogSelectionClient } from './job-log-selection-client.ts';
import type { JobLogSelectionState } from './job-log-selection-client.ts';
import { LogPreferenceReader } from './log-preference-reader.ts';
import type { LogPreferenceState } from './log-preference-reader.ts';
import { createLogPreferenceWriter } from './log-preference-writer.ts';
import { HelmRepositoryClient } from './helm-repository-client.ts';
import type { HelmRepositoryState } from './helm-repository-client.ts';
import { copyNameText, copyTreeNameText } from './copy-name.ts';
import { marketplaceSearchUrl, marketplaceSearchTerm } from '../shared/find-local-tunnel-providers-protocol.ts';
import { WorkspaceClient } from './workspace-client.ts';
import type { WorkspaceState } from './workspace-client.ts';
import { FileSaveClient } from './file-save-client.ts';
import type { FileSaveState, SaveSnapshot } from './file-save-client.ts';
import { ManifestDiffClient } from './manifest-diff-client.ts';
import type { ManifestDiffState, DiffSource } from './manifest-diff-client.ts';
import { ManifestCreateClient } from './manifest-create-client.ts';
import type { ManifestCreateState } from './manifest-create-client.ts';
import { manifestFileInput } from './manifest-file-source.ts';
import { ScaleClient } from './scale-client.ts';
import type { ScaleState } from './scale-client.ts';
import { CronJobRunClient } from './cronjob-run-client.ts';
import type { CronJobRunState } from './cronjob-run-client.ts';
import { ExposeClient } from './expose-client.ts';
import type { ExposeState } from './expose-client.ts';
import { ConfigFileDeleteClient } from './config-file-delete-client.ts';
import type { ConfigFileDeleteState } from './config-file-delete-client.ts';
import { ConfigFileAddClient } from './config-file-add-client.ts';
import type { ConfigFileAddState } from './config-file-add-client.ts';
import { FileDeleteClient } from './file-delete-client.ts';
import type { FileDeleteState } from './file-delete-client.ts';
import { HelmVersionClient } from './helm-version-client.ts';
import type { HelmVersionState } from './helm-version-client.ts';
import { HelmRefreshClient } from './helm-refresh-client.ts';
import type { HelmRefreshState } from './helm-refresh-client.ts';
import { HelmInspectClient } from './helm-inspect-client.ts';
import type { HelmInspectState } from './helm-inspect-client.ts';
import { HelmValuesClient } from './helm-values-client.ts';
import type { HelmValuesState } from './helm-values-client.ts';
import { HelmDependenciesClient } from './helm-dependencies-client.ts';
import type { HelmDependenciesState } from './helm-dependencies-client.ts';
import { HelmLintClient } from './helm-lint-client.ts';
import type { HelmLintState } from './helm-lint-client.ts';
import { HelmTemplateClient } from './helm-template-client.ts';
import type { HelmTemplateState } from './helm-template-client.ts';
import { HelmDryRunClient } from './helm-dryrun-client.ts';
import type { HelmDryRunState } from './helm-dryrun-client.ts';
import { HelmPackageClient } from './helm-package-client.ts';
import type { HelmPackageState } from './helm-package-client.ts';
import { HelmDepUpClient } from './helm-depup-client.ts';
import type { HelmDepUpState } from './helm-depup-client.ts';
import { HelmCreateClient } from './helm-create-client.ts';
import type { HelmCreateState } from './helm-create-client.ts';
import { HelmFetchClient } from './helm-fetch-client.ts';
import type { HelmFetchState } from './helm-fetch-client.ts';
import { HelmRequirementClient } from './helm-requirement-client.ts';
import type { HelmRequirementState } from './helm-requirement-client.ts';
import { HelmConvertClient } from './helm-convert-client.ts';
import type { HelmConvertState } from './helm-convert-client.ts';
import { HelmParameteriseClient } from './helm-parameterise-client.ts';
import type { HelmParameteriseState } from './helm-parameterise-client.ts';import type { DocumentReference } from '../shared/document-protocol.ts';
import { ManifestApplyClient } from './manifest-apply-client.ts';
import type { ManifestApplyState, ApplySnapshot } from './manifest-apply-client.ts';
import { ApplyFileClient } from './apply-file-client.ts';
import type { ApplyFileState } from './apply-file-client.ts';
import { HelmReleaseClient } from './helm-release-client.ts';
import type { HelmReleaseState } from './helm-release-client.ts';
import { ImageRunClient } from './image-run-client.ts';
import type { ImageRunState } from './image-run-client.ts';
import { GitSyncClient } from './git-sync-client.ts';
import type { GitSyncState } from './git-sync-client.ts';
import { SessionClient } from './session-client.ts';
import type { SessionClientState } from './session-client.ts';
import { HelmWriteClient } from './helm-write-client.ts';
import type { HelmWriteState } from './helm-write-client.ts';
import { MergeKubeconfigClient } from './merge-kubeconfig-client.ts';
import type { MergeKubeconfigState } from './merge-kubeconfig-client.ts';
import { ClusterClient } from './cluster-client.ts';
import type { ClusterState } from './cluster-client.ts';

// Headless project runtime. Its owner is the plugin service, never an iframe.
// The compatibility export below is type-only at presentation call sites.
export function createProjectRuntime(host: ProjectRuntimeHost, show: (state: ConfigurationState & { locale: string }) => void, projectChanged: () => void = () => {}, showResources: (state: ResourceState) => void = () => {}, showBranches: (state: BranchState) => void = () => {}, showKeyContent: (state: KeyContentState) => void = () => {}, showPodLogs: (state: PodLogState) => void = () => {}, showEvents: (state: EventState) => void = () => {}, showDocument: (state: DocumentState) => void = () => {}, showDelete: (state: DeleteState) => void = () => {}, showNamespace: (state: NamespaceState) => void = () => {}, showNamespaceDelete: (state: NamespaceDeleteState) => void = () => {}, showContext: (state: ContextState) => void = () => {}, showPreference: (state: PreferenceState) => void = () => {}, sourceSelected: (selection: ConfigSelection) => void = () => {}, showContextDelete: (state: ContextDeleteState) => void = () => {}, showSourcePicker: (state: SourcePickerState) => void = () => {}, sourceFileChosen: (path: string, append: boolean) => void = () => {}, showContextChoices: (state: ContextChoiceState) => void = () => {}, showInspection: (state: InspectionState) => void = () => {}, showExplanation: (state: ExplainState) => void = () => {}, showWatch: (state: WatchState) => void = () => {}, showLogFollow: (state: LogFollowState) => void = () => {}, showEventFollow: (state: EventFollowState) => void = () => {}, showJobLogSelection: (state: JobLogSelectionState) => void = () => {}, showLogPreferences: (state: LogPreferenceState) => void = () => {}) {
  let workspaceDirectory: string | null = null, showWorkspace: (state: WorkspaceState) => void = () => {};
  let workspaceState: WorkspaceState = { phase: 'idle', stale: false }, fileSaves: FileSaveClient | undefined, manifestDiff: ManifestDiffClient | undefined, showFileSave: (state: FileSaveState) => void = () => {}, showManifestDiff: (state: ManifestDiffState) => void = () => {};
  let manifestCreates: ManifestCreateClient | undefined, showManifestCreate: (state: ManifestCreateState) => void = () => {};
  let manifestApplies: ManifestApplyClient | undefined, showManifestApply: (state: ManifestApplyState) => void = () => {};
  let scales: ScaleClient | undefined, showScale: (state: ScaleState) => void = () => {};
  let cronJobRuns: CronJobRunClient | undefined, showCronJobRun: (state: CronJobRunState) => void = () => {};
  let exposes: ExposeClient | undefined, showExpose: (state: ExposeState) => void = () => {};
  let configFileDeletes: ConfigFileDeleteClient | undefined, showConfigFileDelete: (state: ConfigFileDeleteState) => void = () => {};
  let configFileAdds: ConfigFileAddClient | undefined, showConfigFileAdd: (state: ConfigFileAddState) => void = () => {};
  let fileDeletes: FileDeleteClient | undefined, showFileDelete: (state: FileDeleteState) => void = () => {};
  let applyFiles: ApplyFileClient | undefined, showApplyFile: (state: ApplyFileState) => void = () => {};
  let helmReleases: HelmReleaseClient | undefined, showHelmRelease: (state: HelmReleaseState) => void = () => {};
  let imageRuns: ImageRunClient | undefined, showImageRun: (state: ImageRunState) => void = () => {};
  let gitSyncs: GitSyncClient | undefined, showGitSync: (state: GitSyncState) => void = () => {};
  let sessionView: ((state: SessionClientState) => void) | undefined;
  let helmWrites: HelmWriteClient | undefined, showHelmWrite: (state: HelmWriteState) => void = () => {};
  let mergeKubeconfigs: MergeKubeconfigClient | undefined, showMergeKubeconfig: (state: MergeKubeconfigState) => void = () => {};
  let clusterOps: ClusterClient | undefined, showCluster: (state: ClusterState) => void = () => {};
  clusterOps = new ClusterClient(request => host.serviceRequest(request), state => showCluster(state));
  mergeKubeconfigs = new MergeKubeconfigClient(request => host.serviceRequest(request), state => showMergeKubeconfig(state));
  helmWrites = new HelmWriteClient(request => host.serviceRequest(request), state => {
    // A determinate accepted write invalidates the release view for the next read.
    if (state.phase === 'result' && state.outcome?.phase !== 'prepared') helmRepositories.reset();
    showHelmWrite(state);
  });
  const podSession = new SessionClient(request => host.serviceRequest(request), state => sessionView?.(state));
  let showSessionTarget: (state: SessionTargetState) => void = () => {};
  let showNamespaceSwitch: (state: NamespaceSwitchState) => void = () => {};
  const sessionTargets = new SessionTargetClient(request => host.serviceRequest(request), state => showSessionTarget(state));
  let lastSessionOverview: SessionOverview = { sessions: [], events: [] };
  const readSessionOverview = async (): Promise<SessionOverview> => {
    try {
      const response = await host.serviceRequest({ method: 'POST', path: '/v2/sessions/handle', body: JSON.stringify({ protocol: 1, kind: 'list' }) });
      if (response.status !== 200) throw new BoundaryError('STATE_UNAVAILABLE');
      const value = JSON.parse(response.body) as SessionOverview & { kind?: string };
      if (value.kind !== 'sessions' || !Array.isArray(value.sessions) || !Array.isArray(value.events)) throw new BoundaryError('STATE_UNAVAILABLE');
      lastSessionOverview = { sessions: value.sessions, events: value.events }; return lastSessionOverview;
    } catch (error) { return { ...lastSessionOverview, error: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' }; }
  };
  let helmVersions: HelmVersionClient | undefined, showHelmVersion: (state: HelmVersionState) => void = () => {};
  const workspace = new WorkspaceClient(request => host.serviceRequest(request), state => {
    const scopeChanged = JSON.stringify(workspaceState.scope?.scope) !== JSON.stringify(state.scope?.scope);
    workspaceState = state; fileSaves?.changed(); manifestDiff?.changed(); showWorkspace(state);
    if (scopeChanged) manifestCreates?.changed(); else manifestCreates?.sourceChanged();
  });
  let showHelmRepositories: (state: HelmRepositoryState) => void = () => {};
  const helmRepositories = new HelmRepositoryClient(request => host.serviceRequest(request), state => showHelmRepositories(state), () => host.serviceRequest({ method: 'GET', path: '/health' }));
  const logPreferences = new LogPreferenceReader(key => host.storage.get(key, { scope: 'instance' }), showLogPreferences);
  const logPreferenceWriter = createLogPreferenceWriter((key, value) => host.storage.set(key, value, { scope: 'instance' }));
  let locale = 'en';
  let resourceState: ResourceState = { phase: 'idle', stale: false }, branchState: BranchState = { phase: 'idle', stale: false }, copyCalls = 0, bridgeDisposed = false;
  const resources = new ResourceClient(request => host.serviceRequest(request), state => { resourceState = state; showResources(state); });
  const watches = new WatchClient(request => host.serviceRequest(request), state => {
    if (state.changed && state.page) {
      if (state.page.source.custom) branches.invalidateCustomWatch(state.page.source.target, state.page.source.custom.definition);
      else resources.invalidate(state.page.source.resource, state.page.source.target);
      tree.observeWatch(state.page);
    }
    if (state.phase === 'idle') tree.stopWatchUpdates();
    showWatch(state);
  }, Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''));
  const branches = new BranchClient(request => host.serviceRequest(request), state => { branchState = state; showBranches(state); });
  let showTree: ((snapshot: TreeSnapshot) => void) | undefined;
  const tree = new TreeController(request => host.serviceRequest(request), snapshot => showTree?.(snapshot));
  tree.enableHelmTree();
  const keyContent = new KeyContentClient(request => host.serviceRequest(request), showKeyContent);
  const logFollows = new LogFollowClient(request => host.serviceRequest(request), showLogFollow, Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''));
  let podLogState: PodLogState = { phase: 'idle', stale: false, text: '', complete: false, containers: [] };
  const podLogs = new PodLogClient(request => host.serviceRequest(request), state => { podLogState = state; if (state.phase === 'idle' || state.phase === 'loading') logFollows.reset(); showPodLogs(state); });
  const jobSelections = new JobLogSelectionClient(request => host.serviceRequest(request), showJobLogSelection, (selected, source) => {
    void podLogs.open({ protocol: 2, target: source.target, selection: source.selection, origin: selected.origin, reference: selected.reference, kind: 'containers' });
  }, Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''));
  const eventFollows = new EventFollowClient(request => host.serviceRequest(request), showEventFollow, Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''));
  let eventState: EventState = { phase: 'idle', stale: false };
  const events = new EventClient(request => host.serviceRequest(request), state => { eventState = state; if (state.phase === 'idle' || state.phase === 'loading') eventFollows.reset(); showEvents(state); });
  const explanations = new ExplainClient(request => host.serviceRequest(request), showExplanation);
  let documentState: DocumentState = { phase: 'idle', stale: false, text: '', complete: false };
  const documents = new DocumentClient(request => host.serviceRequest(request), state => { documentState = state; fileSaves?.changed(); manifestDiff?.changed(); explanations.reset(); showDocument(state); manifestCreates?.sourceChanged(); manifestApplies?.changed(); });
  const inspections = new InspectionClient(request => host.serviceRequest(request), showInspection);
  const deletes = new DeleteClient(request => host.serviceRequest(request), state => {
    // A determinate accepted Delete marks the affected tree queries stale (CRD definitions take
    // their Custom Resources branch with them); no automatic GET or session work.
    if (state.outcome?.phase === 'accepted') tree.observeDelete(state.outcome);
    showDelete(state);
  });
  const namespaces = new NamespaceClient(request => host.serviceRequest(request), showNamespace);
  const namespaceDeletes = new NamespaceDeleteClient(request => host.serviceRequest(request), showNamespaceDelete);
  const contexts = new ContextClient(request => host.serviceRequest(request), showContext);
  const contextDeletes = new ContextDeleteClient(request => host.serviceRequest(request), showContextDelete);
  const sourcePicker = new SourcePickerClient(request => host.serviceRequest(request), showSourcePicker);
  const contextChoices = new ContextChoiceClient(request => host.serviceRequest(request), showContextChoices);
  let current: ConfigurationState | undefined, projectRevision = 0;
  let namespaceSwitchBusy = false, namespaceReload = false;
  const viewId = host.workspaceId;
  const client = new ConfigurationClient(request => host.serviceRequest(request), state => {
    if (state.phase === 'ready' && state.config) helmRepositories.observeGeneration(state.config.serviceGeneration);
    if (current?.config && state.config && current.config.serviceGeneration !== state.config.serviceGeneration) sourcePicker.reset();
    current = state;
    manifestDiff?.changed();
    manifestApplies?.changed();
    manifestCreates?.changed();
    if (state.phase !== 'ready') contextChoices.reset();
    if (state.phase !== 'ready') sessionTargets.reset();
    podSession.availability(state.phase === 'ready');
    if (state.phase !== 'ready') { contextDeletes.reset(); contexts.reset(); }
    if (state.phase !== 'ready') namespaceDeletes.reset();
    if (state.phase !== 'ready' && !namespaceReload) {
      namespaces.reset();
      if (namespaceSwitchBusy) showNamespaceSwitch({ phase: 'idle' });
    }
    if (state.phase !== 'ready') { inspections.reset(); watches.reset(); }
    if (state.phase !== 'ready') { jobSelections.reset(); resources.reset(); branches.reset(); keyContent.reset(); podLogs.reset(); events.reset(); deletes.reset(); documents.suspend(); }
    if (state.phase === 'ready' && state.config) tree.configure(state.config, client.selection, `${viewId}:${projectRevision}`, state.offset ?? 0);
    else tree.suspend(state.error);
    if (state.phase === 'ready') podSession.observeScope(configurationReadTarget(state.config, `${viewId}:${projectRevision}`));
    show({ ...state, locale });
  });
  const preferences = new PreferenceClient(createPreferenceTransport(request => host.serviceRequest(request)), request => host.serviceRequest(request), showPreference, (selection: ConfigSelection) => { sourceSelected(selection); return client.select(selection); });
  function saveSnapshot(kind: 'live' | 'file'): SaveSnapshot | undefined {
    if (kind === 'file') {
      const file = workspaceState.file;
      if (workspaceState.phase !== 'ready' || workspaceState.stale || !file) return undefined;
      return { owner: file.origin, text: file.text, source: { kind, identity: file.origin.identity, revision: file.revision,
        file: { root: file.origin.root, path: file.origin.path, version: file.origin.version, scope: file.readScope ?? file.origin.scope, ...(file.detached ? { detached: true } : {}) }, ...(file.savedFile ? { previousFile: file.savedFile } : {}) } };
    }
    const editor = documentState.editor, activeTarget = target();
    if (documentState.phase !== 'ready' || documentState.stale || !documentState.complete || !editor || !activeTarget || !sameTarget(activeTarget, editor.origin.target)) return undefined;
    return { owner: editor.origin, text: editor.text, source: { kind, identity: editor.origin.contentIdentity, revision: editor.revision, ...(editor.savedFile ? { previousFile: editor.savedFile } : {}) } };
  }
  fileSaves = new FileSaveClient(request => host.serviceRequest(request), saveSnapshot,
    (kind, outcome, text, revision) => kind === 'file' ? workspace.acknowledgeSaved(outcome, text, revision) : documents.acknowledgeSaved(outcome, text, revision), state => showFileSave(state));
  manifestDiff = new ManifestDiffClient(request => host.serviceRequest(request), (kind, format): DiffSource | undefined => {
    const snapshot = saveSnapshot(kind), currentTarget = target(); if (!snapshot || !currentTarget) return undefined;
    const editor = kind === 'live' ? documentState.editor : undefined, reference = editor?.origin.reference;
    return { owner: snapshot.owner, revision: snapshot.source.revision, text: snapshot.text, format: editor?.origin.format ?? format, target: currentTarget, selection: client.selection,
      ...(reference ? { expected: { group: reference.type.group, version: reference.type.version, kind: reference.type.kind, name: reference.name, ...(reference.namespace ? { namespace: reference.namespace } : {}), uid: reference.uid } } : {}) };
  }, state => showManifestDiff(state));
  manifestApplies = new ManifestApplyClient(request => host.serviceRequest(request), (): ApplySnapshot | undefined => {
    const editor = documentState.editor, snapshot = saveSnapshot('live'), currentTarget = target();
    if (!editor || !snapshot || !currentTarget || !('definition' in editor.origin.reference)) return undefined;
    return { owner: editor.origin, text: editor.text, revision: editor.revision, format: editor.origin.format, target: currentTarget, selection: client.selection, reference: editor.origin.reference };
  }, state => {
    if (state.outcome?.phase === 'succeeded' && !state.outcome.unchanged) { branches.invalidateCustomWatch(state.outcome.target, state.outcome.reference.definition); tree.observeApply(state.outcome); }
    showManifestApply(state);
  });
  scales = new ScaleClient(request => host.serviceRequest(request), state => {
    // A determinate accepted Scale only marks the original matching headless list stale; no auto GET or session work.
    if (state.outcome?.phase === 'accepted') {
      const reference = state.outcome.parameters.reference, key = Object.entries(resourceDescriptors).find(([, type]) => type.group === reference.type.group && type.resource === reference.type.resource)?.[0];
      if (key) resources.invalidate(key, state.outcome.target);
    }
    showScale(state);
  });
  cronJobRuns = new CronJobRunClient(request => host.serviceRequest(request), state => {
    // A determinate accepted Run Now only marks the original jobs/cronjobs lists stale; no auto GET or session work.
    if (state.outcome?.phase === 'accepted') {
      const target = state.outcome.target;
      for (const key of ['jobs', 'cronjobs']) resources.invalidate(key, target);
    }
    showCronJobRun(state);
  });
  exposes = new ExposeClient(request => host.serviceRequest(request), state => {
    // A determinate accepted Expose only marks the original services list stale; no auto GET or session work.
    if (state.outcome?.phase === 'accepted') resources.invalidate('services', state.outcome.target);
    showExpose(state);
  });
  configFileDeletes = new ConfigFileDeleteClient(request => host.serviceRequest(request), state => {
    // A determinate accepted key delete only marks the original parent list stale; no auto GET or session work.
    if (state.outcome?.phase === 'accepted') {
      const reference = state.outcome.parameters.reference, key = Object.entries(resourceDescriptors).find(([, type]) => type.group === reference.type.group && type.resource === reference.type.resource)?.[0];
      if (key) resources.invalidate(key, state.outcome.target);
    }
    showConfigFileDelete(state);
  });
  configFileAdds = new ConfigFileAddClient(request => host.serviceRequest(request), state => {
    // A determinate accepted Add only marks the original parent list stale; no auto GET or session work.
    if (state.outcome?.phase === 'accepted') {
      const reference = state.outcome.parameters.reference, key = Object.entries(resourceDescriptors).find(([, type]) => type.group === reference.type.group && type.resource === reference.type.resource)?.[0];
      if (key) resources.invalidate(key, state.outcome.target);
    }
    showConfigFileAdd(state);
  });
  fileDeletes = new FileDeleteClient(request => host.serviceRequest(request), state => {
    // A determinate accepted file delete only marks the pinned object's list stale; no auto GET or session work.
    const value = state.outcome;
    if (value?.phase === 'accepted' && value.reference) {
      const key = Object.entries(resourceDescriptors).find(([, type]) => type.group === value.reference?.type.group && type.resource === value.reference?.type.resource)?.[0];
      if (key) resources.invalidate(key, value.target);
    }
    showFileDelete(state);
  });
  applyFiles = new ApplyFileClient(request => host.serviceRequest(request), state => {
    // A determinate accepted ApplyFile only marks the touched kinds' headless lists stale.
    if (state.outcome?.phase === 'accepted' && state.outcome.results) {
      for (const result of state.outcome.results) {
        const plan = state.outcome.parameters.documents[result.index];
        const key = Object.entries(resourceDescriptors).find(([, type]) => type.group === (plan?.locator.group ?? '') && type.kind === plan?.locator.kind)?.[0];
        if (key) resources.invalidate(key, state.outcome.target);
      }
    }
    showApplyFile(state);
  });
  imageRuns = new ImageRunClient(request => host.serviceRequest(request), state => {
    // A determinate accepted Run only marks the pods list stale; no automatic GET or session work.
    if (state.outcome?.phase === 'accepted') resources.invalidate('pods', state.outcome.target);
    showImageRun(state);
  });
  gitSyncs = new GitSyncClient(request => host.serviceRequest(request), state => showGitSync(state));
  helmReleases = new HelmReleaseClient(request => host.serviceRequest(request), state => showHelmRelease(state));
  helmVersions = new HelmVersionClient(request => host.serviceRequest(request), state => showHelmVersion(state));
  let helmRefreshes: HelmRefreshClient | undefined, showHelmRefresh: (state: HelmRefreshState) => void = () => {};
  helmRefreshes = new HelmRefreshClient(request => host.serviceRequest(request), state => {
    // A determinate refreshed index invalidates the repository view so the next read picks it up.
    if (state.phase === 'done') helmRepositories.reset();
    showHelmRefresh(state);
  });
  let helmInspects: HelmInspectClient | undefined, showHelmInspect: (state: HelmInspectState) => void = () => {};
  helmInspects = new HelmInspectClient(request => host.serviceRequest(request), state => showHelmInspect(state));
  let helmValues: HelmValuesClient | undefined, showHelmValues: (state: HelmValuesState) => void = () => {};
  helmValues = new HelmValuesClient(request => host.serviceRequest(request), state => showHelmValues(state));
  let helmDependencies: HelmDependenciesClient | undefined, showHelmDependencies: (state: HelmDependenciesState) => void = () => {};
  helmDependencies = new HelmDependenciesClient(request => host.serviceRequest(request), state => showHelmDependencies(state));
  let helmLints: HelmLintClient | undefined, showHelmLint: (state: HelmLintState) => void = () => {};
  helmLints = new HelmLintClient(request => host.serviceRequest(request), state => showHelmLint(state));
  let helmTemplates: HelmTemplateClient | undefined, showHelmTemplate: (state: HelmTemplateState) => void = () => {};
  helmTemplates = new HelmTemplateClient(request => host.serviceRequest(request), state => showHelmTemplate(state));
  let helmDryRuns: HelmDryRunClient | undefined, showHelmDryRun: (state: HelmDryRunState) => void = () => {};
  helmDryRuns = new HelmDryRunClient(request => host.serviceRequest(request), state => showHelmDryRun(state));
  let helmPackages: HelmPackageClient | undefined, showHelmPackage: (state: HelmPackageState) => void = () => {};
  helmPackages = new HelmPackageClient(request => host.serviceRequest(request), state => showHelmPackage(state));
  let helmDepUps: HelmDepUpClient | undefined, showHelmDepUp: (state: HelmDepUpState) => void = () => {};
  helmDepUps = new HelmDepUpClient(request => host.serviceRequest(request), state => showHelmDepUp(state));
  let helmCreates: HelmCreateClient | undefined, showHelmCreate: (state: HelmCreateState) => void = () => {};
  helmCreates = new HelmCreateClient(request => host.serviceRequest(request), state => showHelmCreate(state));
  let helmFetches: HelmFetchClient | undefined, showHelmFetch: (state: HelmFetchState) => void = () => {};
  helmFetches = new HelmFetchClient(request => host.serviceRequest(request), state => showHelmFetch(state));
  let helmRequirements: HelmRequirementClient | undefined, showHelmRequirement: (state: HelmRequirementState) => void = () => {};
  helmRequirements = new HelmRequirementClient(request => host.serviceRequest(request), state => showHelmRequirement(state));
  let helmConverts: HelmConvertClient | undefined, showHelmConvert: (state: HelmConvertState) => void = () => {};
  helmConverts = new HelmConvertClient(request => host.serviceRequest(request), state => showHelmConvert(state));
  let helmParameterises: HelmParameteriseClient | undefined, showHelmParameterise: (state: HelmParameteriseState) => void = () => {};
  helmParameterises = new HelmParameteriseClient(request => host.serviceRequest(request), state => showHelmParameterise(state));
  manifestCreates = new ManifestCreateClient(request => host.serviceRequest(request), () => {
    const currentTarget = target(); return currentTarget ? { target: currentTarget, selection: client.selection } : undefined;
  }, state => {
    if (state.outcome) {
      tree.observeCreate(state.outcome);
      for (const step of state.outcome.steps) if (step.phase === 'succeeded' && step.reference && (step.reference.type.scope === 'cluster' || step.reference.namespace === state.outcome.target.namespace)) {
        const reference = step.reference, key = Object.entries(resourceDescriptors).find(([, type]) => type.group === reference.type.group && type.resource === reference.type.resource)?.[0];
        if (key) resources.invalidate(key, state.outcome.target);
      }
    }
    showManifestCreate(state);
  });
  const lifecycle = new HostSnapshotLifecycle();
  function changeProject(directory: string | null): void {
    if (workspaceDirectory !== directory) manifestApplies?.reset();
    if (workspaceDirectory !== directory) manifestCreates?.reset();
    if (workspaceDirectory !== directory) manifestDiff?.reset();
    if (workspaceDirectory !== directory) fileSaves?.reset();
    workspaceDirectory = directory; workspace.project(directory);
    helmRepositories.reset();
    if (client.project(directory)) { jobSelections.reset(); watches.reset(); sourcePicker.reset(); contextDeletes.reset(); inspections.reset(); preferences.reset(); contexts.reset(); namespaceDeletes.reset(); namespaces.reset(); projectRevision++; tree.clear(); resources.reset(); branches.reset(); keyContent.reset(); podLogs.reset(); events.reset(); deletes.reset(); documents.reset(); projectChanged(); }
  }
  const stopReady = host.onReady(context => {
    const localeChanged = locale !== context.locale;
    locale = context.locale;
    const update = lifecycle.ready(context.directory);
    if (update.projectChanged) changeProject(context.directory);
    if (update.projectChanged) {
      void client.reload();
      void preferences.read(true);
    } else if (localeChanged && current) show({ ...current, locale });
    if (update.initialize) void logPreferences.read();
  });
  const stopDirectory = (() => {
    const unsubscribe = host.onDirectory(value => {
    if (!lifecycle.directory(value)) return;
    changeProject(value);
    void client.reload(); void preferences.read(true);
    });
    return () => { sessionTargets.dispose(); podSession.dispose(); clusterOps?.dispose(); unsubscribe(); };
  })();
  function target() {
    const config = current?.phase === 'ready' ? current.config : undefined;
    return configurationReadTarget(config, `${viewId}:${projectRevision}`);
  }
  async function runNamespaceSwitch(namespace: string | undefined, expected?: Omit<TargetIdentity, 'projectId'>) {
    if (bridgeDisposed || namespaceSwitchBusy) return;
    const config = current?.phase === 'ready' && !current.stale ? current.config : undefined;
    const before = target();
    const selection = client.selection, revision = projectRevision;
    const sameScope = () => !bridgeDisposed && projectRevision === revision && JSON.stringify(client.selection) === JSON.stringify(selection);
    const stillCurrent = () => sameScope() && current?.phase === 'ready' && !current.stale
      && current.config?.serviceGeneration === config?.serviceGeneration && current.config?.configIdentity === config?.configIdentity;
    const fail = (name: string, error: ErrorCode, written = false) => {
      if (sameScope()) showNamespaceSwitch({ phase: 'error', namespace: name, error, ...(written ? { written: true } : {}) });
    };
    if (!config || config.status !== 'ready') { if (namespace) fail(namespace, 'STALE_TARGET'); return; }
    if (namespace !== undefined) {
      if (!namespaceName.safeParse(namespace).success) return;
      if (!expected || !before || !sameTarget(before, { ...expected, projectId: before.projectId })) { fail(namespace, 'STALE_TARGET'); return; }
      if (before.namespace === namespace) { showNamespaceSwitch({ phase: 'idle' }); return; }
      showNamespaceSwitch({ phase: 'switching', namespace });
    }
    namespaceSwitchBusy = true;
    try {
      const outcome = namespace === undefined ? await namespaces.submit() : await namespaces.switchTo({
        serviceGeneration: config.serviceGeneration, projectId: `${viewId}:${revision}`, configIdentity: config.configIdentity,
      }, selection, config.currentContext, namespace, stillCurrent);
      if (!sameScope()) return;
      const name = outcome?.namespace ?? namespace;
      if (name === undefined) return;
      if (outcome?.phase !== 'succeeded') { fail(name, outcome?.code ?? namespaces.error ?? (stillCurrent() ? 'STATE_UNAVAILABLE' : 'STALE_TARGET')); return; }
      if (!stillCurrent()) { fail(name, 'STALE_TARGET', true); return; }
      if (outcome.result === 'unchanged') { showNamespaceSwitch({ phase: 'idle' }); return; }
      // Refresh configuration first. A resource refresh alone would still send
      // the original configuration identity and fail after the disk change.
      const previousTree = tree.snapshot;
      showNamespaceSwitch({ phase: 'reloading', namespace: name });
      namespaceReload = true;
      try { await client.reload(); } finally { namespaceReload = false; }
      if (!sameScope()) return;
      const fresh = current?.phase === 'ready' ? current.config : undefined;
      if (!fresh || fresh.serviceGeneration !== config.serviceGeneration || fresh.configIdentity === config.configIdentity
        || fresh.currentContext !== outcome.context || fresh.currentContextInfo?.namespace !== name) {
        fail(name, current?.error ?? 'STALE_TARGET', true); return;
      }
      const next = configurationReadTarget(fresh, `${viewId}:${revision}`);
      showNamespaceSwitch({ phase: 'idle' });
      if (next) void tree.reopenNamespaceFolders(previousTree, next).catch(() => {
        const active = target();
        if (!namespaceSwitchBusy && active && sameTarget(active, next)) fail(name, 'STATE_UNAVAILABLE', true);
      });
    } finally { namespaceSwitchBusy = false; }
  }
  return {
    onManifestCreate: (callback: (state: ManifestCreateState) => void) => { showManifestCreate = callback; return () => { showManifestCreate = () => {}; }; },
    onManifestApply: (callback: (state: ManifestApplyState) => void) => { showManifestApply = callback; return () => { showManifestApply = () => {}; }; },
    onScale: (callback: (state: ScaleState) => void) => { showScale = callback; return () => { showScale = () => {}; }; },
    onCronJobRun: (callback: (state: CronJobRunState) => void) => { showCronJobRun = callback; return () => { showCronJobRun = () => {}; }; },
    onExpose: (callback: (state: ExposeState) => void) => { showExpose = callback; return () => { showExpose = () => {}; }; },
    onConfigFileDelete: (callback: (state: ConfigFileDeleteState) => void) => { showConfigFileDelete = callback; return () => { showConfigFileDelete = () => {}; }; },
    onConfigFileAdd: (callback: (state: ConfigFileAddState) => void) => { showConfigFileAdd = callback; return () => { showConfigFileAdd = () => {}; }; },
    onFileDelete: (callback: (state: FileDeleteState) => void) => { showFileDelete = callback; return () => { showFileDelete = () => {}; }; },
    onApplyFile: (callback: (state: ApplyFileState) => void) => { showApplyFile = callback; return () => { showApplyFile = () => {}; }; },
    onHelmRelease: (callback: (state: HelmReleaseState) => void) => { showHelmRelease = callback; return () => { showHelmRelease = () => {}; }; },
    onImageRun: (callback: (state: ImageRunState) => void) => { showImageRun = callback; return () => { showImageRun = () => {}; }; },
    onGitSync: (callback: (state: GitSyncState) => void) => { showGitSync = callback; return () => { showGitSync = () => {}; }; },
    prepareImageRun: (user: string | undefined, version: string) => {
      const scope = workspaceState.scope, target0 = target();
      if (!scope || workspaceState.phase !== 'ready' || workspaceState.stale || !target0 || !version) return;
      const folder = scope.root.split('/').filter(Boolean).at(-1) ?? 'project';
      const sanitised = folder.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
      const image = user ? `${user}/${sanitised}:${version}` : `${sanitised}:${version}`;
      void imageRuns?.prepare(target0, client.selection, { root: scope.root, contextPath: '', version, ...(user ? { user } : {}), image, name: sanitised.trim() });
    },
    submitImageRun: () => imageRuns?.submit(), cancelImageRun: () => imageRuns?.cancel(), imageRunOutcomes: (older = false) => imageRuns?.outcomes(older),
    prepareGitSync: (image: string) => {
      const scope = workspaceState.scope, target0 = target();
      const pieces = image.split(':'), tag = pieces[1];
      if (!scope || workspaceState.phase !== 'ready' || workspaceState.stale || !target0 || pieces.length !== 2 || !tag) return;
      void gitSyncs?.prepare(target0, client.selection, { root: scope.root, path: '', image, commitId: tag });
    },
    submitGitSync: () => gitSyncs?.submit(), cancelGitSync: () => gitSyncs?.cancel(), gitSyncOutcomes: (older = false) => gitSyncs?.outcomes(older),
    onSession: (callback: (state: SessionClientState) => void) => { sessionView = callback; return () => { sessionView = undefined; }; },
    onTree: (callback: (snapshot: TreeSnapshot) => void) => { showTree = callback; return () => { showTree = undefined; }; },
    onHelmWrite: (callback: (state: HelmWriteState) => void) => { showHelmWrite = callback; return () => { showHelmWrite = () => {}; }; },
    onMergeKubeconfig: (callback: (state: MergeKubeconfigState) => void) => { showMergeKubeconfig = callback; return () => { showMergeKubeconfig = () => {}; }; },
    onCluster: (callback: (state: ClusterState) => void) => { showCluster = callback; return () => { showCluster = () => {}; }; },
    localTunnelStart: async (configuredProvider?: string): Promise<string> => {
      // Upstream prompt flow verbatim: the empty registry prompts; the Find button opens the
      // fixed Marketplace search (an external navigation via the host, never an install).
      try {
        const response = await host.serviceRequest({ method: 'POST', path: '/v2/operations/provider-flows', body: JSON.stringify({ protocol: 2, kind: 'local-tunnel-start', ...(configuredProvider ? { configuredProvider } : {}) }) });
        const value = JSON.parse(response.body) as { kind?: string; message?: string; providerId?: string; code?: string; error?: { code?: string } };
        return response.status === 200 ? value.message ?? value.kind ?? 'STATE_UNAVAILABLE' : value.error?.code ?? value.code ?? 'STATE_UNAVAILABLE';
      } catch { return 'STATE_UNAVAILABLE'; }
    },
    openMarketplaceProviderSearch: async (): Promise<boolean> => {
      try { await host.openUrl(marketplaceSearchUrl(marketplaceSearchTerm())); return true; } catch { return false; }
    },
    clusterProviders: async (action: 'create' | 'configure'): Promise<{ id: string; actions: string[] }[] | { error: string }> => {
      try {
        const response = await host.serviceRequest({ method: 'POST', path: '/v2/operations/provider-flows', body: JSON.stringify({ protocol: 2, kind: 'cluster-providers', action }) });
        const value = JSON.parse(response.body) as { providers?: { id: string; actions: string[] }[]; error?: { code?: string } };
        return response.status === 200 && Array.isArray(value.providers) ? value.providers : { error: value.error?.code ?? 'STATE_UNAVAILABLE' };
      } catch { return { error: 'STATE_UNAVAILABLE' }; }
    },
    minikubeConfigView: async (): Promise<{ currentContext: string; contexts: { name: string; clusterName: string; namespace: string }[]; error?: string }> => {
      // Discovery summary only. Never expose raw kubeconfig or treat a preview as a merge grant.
      try {
        const response = await host.serviceRequest({ method: 'POST', path: '/v2/operations/provider-flows', body: JSON.stringify({ protocol: 2, kind: 'minikube-config-view' }) });
        const value = JSON.parse(response.body) as { kind?: string; currentContext?: string; contexts?: { name: string; clusterName: string; namespace: string }[]; code?: string };
        return response.status === 200 && value.kind === 'minikube-config' && Array.isArray(value.contexts)
          ? { currentContext: value.currentContext ?? '', contexts: value.contexts }
          : { currentContext: '', contexts: [], error: value.code ?? 'STATE_UNAVAILABLE' };
      } catch { return { currentContext: '', contexts: [], error: 'STATE_UNAVAILABLE' }; }
    },
    templatePreview: async (root: string, path: string, fileProof: string): Promise<string | undefined> => {
      try {
        const response = await host.serviceRequest({ method: 'POST', path: '/v2/operations/provider-flows', body: JSON.stringify({ protocol: 2, kind: 'template-preview', root, path, fileProof }) });
        const value = JSON.parse(response.body) as { kind?: string; text?: string; code?: string };
        return value.kind === 'template-previewed' ? value.text : undefined;
      } catch { return undefined; }
    },
    telepresenceStatus: async (): Promise<string> => {
      try {
        const response = await host.serviceRequest({ method: 'POST', path: '/v2/operations/cluster', body: JSON.stringify({ protocol: 1, kind: 'telepresence-status' }) });
        const value = JSON.parse(response.body) as { output?: string; code?: string; error?: { code?: string } };
        return response.status === 200 && value.output !== undefined ? value.output : value.error?.code ?? value.code ?? 'STATE_UNAVAILABLE';
      } catch { return 'STATE_UNAVAILABLE'; }
    },
    minikubeStatus: () => clusterOps?.minikubeStatus(),
    minikubePrepare: (action: 'start' | 'stop', driver?: string) => { const target0 = target(); if (current?.phase !== 'ready' || !target0) return clusterOps?.reject('STALE_TARGET'); return clusterOps?.minikubePrepare(target0, client.selection, action, driver); },
    clusterSubmit: () => clusterOps?.submit(), clusterCancel: () => clusterOps?.cancel(),
    clusterStatus: () => clusterOps?.status(), invalidateClusterDraft: () => clusterOps?.invalidateDraft(),
    debugPrepare: (mode: 'attach' | 'launch', language: string, pod: { namespace: string; name: string; uid: string; resourceVersion: string; container: string } | undefined) => {
      const target0 = target(), selected = sessionOpenTarget(sessionTargets.state, true);
      const chosen = pod ?? (selected && !('original' in selected) && selected.container ? {
        namespace: selected.namespace, name: selected.pod, uid: selected.podUid, resourceVersion: selected.podResourceVersion, container: selected.container,
      } : undefined);
      if (current?.phase !== 'ready' || !target0 || !chosen || !sessionTargets.state.target || !sameTarget(target0, sessionTargets.state.target)) return clusterOps?.reject('STALE_TARGET');
      return clusterOps?.debugPrepare(target0, client.selection, mode, language, chosen);
    },
    debugRemove: (id?: string) => clusterOps?.debugRemove(id),
    selectPodEntries: async (): Promise<{ name: string; nodeName?: string }[]> => {
      // Upstream select-pod projection over the EXISTING pods read; only name/nodeName cross.
      const target0 = target(); if (current?.phase !== 'ready' || !target0) return [];
      return resourceState.phase === 'ready' && !resourceState.stale ? (resourceState.page?.nodes ?? []).map(node => ({ name: node.resource.name, ...(node.tooltip ? {} : {}) })).slice(0, 100) : [];
    },
    prepareMergeKubeconfig: (strategy: 'overwrite' | 'keep-both', incoming: string) => { void mergeKubeconfigs?.prepare(client.selection, { strategy, incoming }); },
    submitMergeKubeconfig: () => mergeKubeconfigs?.submit(), cancelMergeKubeconfig: () => mergeKubeconfigs?.cancel(), mergeKubeconfigOutcomes: (older = false) => mergeKubeconfigs?.outcomes(older),
    prepareHelmWrite: (parameters: import('../shared/helm-release-protocol.ts').HelmWriteParameters) => { const target0 = target(); if (current?.phase !== 'ready' || !target0) return; void helmWrites?.prepare(target0, client.selection, parameters); },
    submitHelmWrite: () => helmWrites?.submit(), cancelHelmWrite: () => helmWrites?.cancel(), helmWriteOutcomes: (older = false) => helmWrites?.outcomes(older),
    treeExpand: (id: string) => tree.expand(id), treeCollapse: (id: string) => tree.collapse(id), treeCollapseAll: () => tree.collapseAll(), treeRefresh: (id: string) => tree.refresh(id), treeMore: (id: string) => tree.more(id),
    treeActivate: (id: string) => tree.activate(id), treeSelect: (id: string) => tree.select(id), treeFocus: (id: string) => tree.focus(id), treeKeyboard: (key: string) => tree.keyboard(key),
    onSessionTarget: (callback: (state: SessionTargetState) => void) => { showSessionTarget = callback; return () => { showSessionTarget = () => {}; }; },
    sessionTarget: (reference: DocumentReference | undefined, containers = true) => {
      if (!reference) { sessionTargets.reset(); return Promise.resolve(); }
      return sessionTargets.select({ target: target(), selection: client.selection, reference }, containers);
    },
    sessionForwardTarget: async (rowId: string, generation: number, expected: string) => {
      const scope = target(), snapshot = tree.snapshot;
      const row = snapshot.rows.find(candidate => candidate.id === rowId);
      const reference = documentReferenceFromNode(row?.entry.node);
      if (!scope || snapshot.generation !== generation || !row || row.stale || !reference || documentReferenceId(reference) !== expected
        || !sessionReferenceSchema.safeParse(reference).success || !row.entry.query || !sameTarget(row.entry.query.target, scope)) { sessionTargets.reject('STALE_TARGET'); return false; }
      await sessionTargets.select({ target: scope, selection: client.selection, reference }, false, row.entry.node.forwardPorts);
      return true;
    },
    sessionContainer: (container: string) => sessionTargets.choose(container),
    sessionTargetState: () => sessionTargets.state,
    sessionTargetReady: () => sessionOpenTarget(sessionTargets.state, true),
    openTerminal: (container: string, command = '/bin/bash', size = { columns: 80, rows: 24 }) => {
      const target0 = target(), state = sessionTargets.state, session = sessionOpenTarget(state, true);
      if (!session || !target0 || !state.target || !sameTarget(target0, state.target)) return podSession.reject('STALE_TARGET');
      if (state.container !== container) return podSession.reject('INVALID_INPUT');
      return podSession.open(target0, client.selection, session, 'terminal', { command: [command] }).then(() => {
        if (current?.phase === 'ready') podSession.observeScope(target());
        return podSession.write('', size);
      });
    },
    openSession: (kind: 'exec' | 'port-forward', command: readonly string[], ports?: readonly { local: number; remote: number }[], expectedForward?: string) => {
      const target0 = target(), state = sessionTargets.state, session = sessionOpenTarget(state, kind === 'exec');
      if (!session || !target0 || !state.target || !sameTarget(target0, state.target)) return podSession.reject('STALE_TARGET');
      if (kind === 'port-forward' && (!expectedForward || forwardSelectionKey(state) !== expectedForward)) return podSession.reject('STALE_TARGET');
      if (kind === 'exec' && !command.length) return podSession.reject('INVALID_INPUT');
      return podSession.open(target0, client.selection, session, kind, { ...(kind === 'exec' ? { command } : {}), ...(kind === 'port-forward' && ports?.length ? { ports } : {}) }).then(() => {
        if (current?.phase === 'ready') podSession.observeScope(target());
      });
    },
    terminalWrite: (input: string, size?: { columns: number; rows: number }) => {
      if (current?.phase !== 'ready') return Promise.resolve(false);
      podSession.observeScope(target()); return podSession.write(input, size);
    },
    terminalPoll: () => podSession.poll(), terminalDetach: () => podSession.detach(), terminalClose: () => podSession.close(),
    terminalReattach: () => { if (current?.phase === 'ready') podSession.observeScope(target()); return podSession.reattach(); },
    sessionPoll: () => podSession.poll(), sessionClose: () => podSession.close(),
    sessionDashboardProxy: async (path: string) => { if (current?.phase !== 'ready') return; podSession.observeScope(target()); await podSession.dashboardProxy(path); },
    stopGateStatus: async (): Promise<{ sessions: { live: number; detached: number; closed: number }; writes: Record<string, Record<string, number>> } | { error: string }> => {
      try {
        const response = await host.serviceRequest({ method: 'GET', path: '/v2/status/stop-gate' });
        const parsed = JSON.parse(response.body) as { kind?: string; sessions?: { live: number; detached: number; closed: number }; writes?: Record<string, Record<string, number>> };
        return response.status === 200 && parsed.kind === 'stop-gate' && parsed.sessions && parsed.writes ? { sessions: parsed.sessions, writes: parsed.writes } : { error: 'STATE_UNAVAILABLE' };
      } catch { return { error: 'STATE_UNAVAILABLE' }; }
    },
    sessionsOverview: readSessionOverview,
    debugSend: (command: string, args?: { lines: number[] }) => { void clusterOps?.debugSend(command, args); },
    debugPoll: () => clusterOps?.debugPoll(),
    listSessions: readSessionOverview,
    // Approved batch-2 upgrade: on an external-modification conflict the user gets a literal
    // local-draft vs current-file comparison BEFORE deciding Save As; never an overwrite.
    async compareFileConflict(): Promise<{ equal: boolean; alignment: string; localOnly: number; liveOnly: number; localVersion: string; currentVersion: string } | undefined> {
      const file = workspaceState.file, scope = workspaceState.scope;
      if (!file || workspaceState.phase !== 'ready' || !scope) return undefined;
      try {
        const current = await workspace.captureFile(file.origin.path);
        const comparison = compareDocumentText(file.text, current.text);
        return { equal: comparison.equal, alignment: comparison.alignment,
          localOnly: comparison.ranges.filter(range => range.kind === 'local-only').length,
          liveOnly: comparison.ranges.filter(range => range.kind === 'live-only').length,
          localVersion: file.origin.version, currentVersion: current.origin.version };
      } catch { return undefined; }
    },
    readHelmReleases: (namespace: string) => { if (current?.phase !== 'ready') return; void helmReleases?.read(target(), client.selection, namespace); }, closeHelmReleases: () => helmReleases?.reset(),
    prepareApplyFile: () => {
      const file = workspaceState.file, scope = workspaceState.scope;
      const source = file && !workspaceState.stale && workspaceState.phase === 'ready' && scope
        ? { root: scope.root, path: file.origin.path, version: file.origin.version, identity: file.origin.identity,
            format: (file.origin.path.endsWith('.json') ? 'json' : 'yaml') as 'json' | 'yaml', proof: file.origin.proof } : undefined;
      return source ? applyFiles?.prepare(target(), client.selection, source, file?.text ?? '') : undefined;
    },
    submitApplyFile: () => applyFiles?.submit(), cancelApplyFile: () => applyFiles?.cancel(), applyFileOutcomes: (older = false) => applyFiles?.outcomes(older),
    onHelmVersion: (callback: (state: HelmVersionState) => void) => { showHelmVersion = callback; return () => { showHelmVersion = () => {}; }; },
    onHelmRefresh: (callback: (state: HelmRefreshState) => void) => { showHelmRefresh = callback; return () => { showHelmRefresh = () => {}; }; },
    onHelmInspect: (callback: (state: HelmInspectState) => void) => { showHelmInspect = callback; return () => { showHelmInspect = () => {}; }; },
    onHelmValues: (callback: (state: HelmValuesState) => void) => { showHelmValues = callback; return () => { showHelmValues = () => {}; }; },
    onHelmDependencies: (callback: (state: HelmDependenciesState) => void) => { showHelmDependencies = callback; return () => { showHelmDependencies = () => {}; }; },
    onHelmLint: (callback: (state: HelmLintState) => void) => { showHelmLint = callback; return () => { showHelmLint = () => {}; }; },
    onHelmTemplate: (callback: (state: HelmTemplateState) => void) => { showHelmTemplate = callback; return () => { showHelmTemplate = () => {}; }; },
    onHelmDryRun: (callback: (state: HelmDryRunState) => void) => { showHelmDryRun = callback; return () => { showHelmDryRun = () => {}; }; },
    onHelmPackage: (callback: (state: HelmPackageState) => void) => { showHelmPackage = callback; return () => { showHelmPackage = () => {}; }; },
    onHelmDepUp: (callback: (state: HelmDepUpState) => void) => { showHelmDepUp = callback; return () => { showHelmDepUp = () => {}; }; },
    onHelmCreate: (callback: (state: HelmCreateState) => void) => { showHelmCreate = callback; return () => { showHelmCreate = () => {}; }; },
    onHelmFetch: (callback: (state: HelmFetchState) => void) => { showHelmFetch = callback; return () => { showHelmFetch = () => {}; }; },
    onHelmRequirement: (callback: (state: HelmRequirementState) => void) => { showHelmRequirement = callback; return () => { showHelmRequirement = () => {}; }; },
    onHelmConvert: (callback: (state: HelmConvertState) => void) => { showHelmConvert = callback; return () => { showHelmConvert = () => {}; }; },
    onHelmParameterise: (callback: (state: HelmParameteriseState) => void) => { showHelmParameterise = callback; return () => { showHelmParameterise = () => {}; }; },
    runHelmParameterise: (template: string, field: string, value: string, document: string) => { void helmParameterises?.run(template, field, value, document); }, closeHelmParameterise: () => helmParameterises?.reset(),
    runHelmConvert: (root: string, path: string, name: string, document: string) => { void helmConverts?.run(root, path, name, document); }, closeHelmConvert: () => helmConverts?.reset(),
    lookupHelmRequirement: (repository: string, chart: string) => { void helmRequirements?.lookup(repository, chart); }, closeHelmRequirement: () => helmRequirements?.reset(),
    runHelmFetch: (chart: string, version: string | undefined, root: string, path: string) => { void helmFetches?.run(chart, version, root, path); }, closeHelmFetch: () => helmFetches?.reset(),
    runHelmCreate: (root: string, path: string, name: string) => { void helmCreates?.run(root, path, name); }, closeHelmCreate: () => helmCreates?.reset(),
    runHelmDepUp: (root: string, path: string) => { void helmDepUps?.run(root, path); }, closeHelmDepUp: () => helmDepUps?.reset(),
    runHelmPackage: (root: string, path: string, destinationRoot: string, destinationPath: string) => { void helmPackages?.run(root, path, destinationRoot, destinationPath); }, closeHelmPackage: () => helmPackages?.reset(),
    runHelmDryRun: (root: string, path: string) => { void helmDryRuns?.run(root, path); }, closeHelmDryRun: () => helmDryRuns?.reset(),
    renderHelmTemplate: (root: string, path: string) => { void helmTemplates?.render(root, path); }, closeHelmTemplate: () => helmTemplates?.reset(),
    lintHelmChart: (root: string, path: string) => { void helmLints?.lint(root, path); }, closeHelmLint: () => helmLints?.reset(),
    listHelmDependencies: (chart: string, version?: string) => { void helmDependencies?.list(chart, version); }, closeHelmDependencies: () => helmDependencies?.reset(),
    fetchHelmValues: (chart: string, version?: string) => { void helmValues?.fetch(chart, version); }, closeHelmValues: () => helmValues?.reset(),
    inspectHelmChart: (chart: string, version?: string) => { void helmInspects?.inspect(chart, version); }, closeHelmInspect: () => helmInspects?.reset(),
    runHelmRepoRefresh: () => helmRefreshes?.run(), closeHelmRefresh: () => helmRefreshes?.reset(),
    readHelmVersion: () => helmVersions?.read(), closeHelmVersion: () => helmVersions?.reset(),
    prepareFileDelete: (filePath: string) => {
      const file = workspaceState.file, scope = workspaceState.scope;
      const source = file && !workspaceState.stale && workspaceState.phase === 'ready' && scope && file.origin.path === filePath
        ? { root: scope.root, path: file.origin.path, version: file.origin.version, identity: file.origin.identity, proof: file.origin.proof } : undefined;
      return fileDeletes?.prepare(target(), client.selection, source, source ? file?.text ?? '' : '');
    },
    submitFileDelete: () => fileDeletes?.submit(), cancelFileDelete: () => fileDeletes?.cancel(), fileDeleteOutcomes: (older = false) => fileDeletes?.outcomes(older),
    prepareConfigFileAdd: (reference: DocumentReference, keyInput: string, filePath: string) => {
      const file = workspaceState.file, scope = workspaceState.scope;
      const source = file && !workspaceState.stale && workspaceState.phase === 'ready' && scope && file.origin.path === filePath
        ? { root: scope.root, path: file.origin.path, version: file.origin.version, identity: file.origin.identity,
            format: (filePath.endsWith('.json') ? 'json' : 'yaml') as 'json' | 'yaml', proof: file.origin.proof } : undefined;
      return configFileAdds?.prepare(target(), client.selection, reference, keyInput, source, source ? file?.text ?? '' : '');
    },
    submitConfigFileAdd: () => configFileAdds?.submit(), cancelConfigFileAdd: () => configFileAdds?.cancel(), configFileAddOutcomes: (older = false) => configFileAdds?.outcomes(older),
    prepareConfigFileDelete: (reference: DocumentReference, keyInput: string) => configFileDeletes?.prepare(target(), client.selection, reference, keyInput),
    submitConfigFileDelete: () => configFileDeletes?.submit(), cancelConfigFileDelete: () => configFileDeletes?.cancel(), configFileDeleteOutcomes: (older = false) => configFileDeletes?.outcomes(older),
    prepareExpose: (reference: DocumentReference, fields: { name: string; port: string; targetPort: string; type: string; protocol: string }) => exposes?.prepare(target(), client.selection, reference, fields),
    submitExpose: () => exposes?.submit(), cancelExpose: () => exposes?.cancel(), exposeOutcomes: (older = false) => exposes?.outcomes(older),
    prepareCronJobRun: (reference: DocumentReference, jobNameInput: string) => cronJobRuns?.prepare(target(), client.selection, reference.name, reference.namespace ?? '', reference.uid, reference.resourceVersion, jobNameInput),
    submitCronJobRun: () => cronJobRuns?.submit(), cancelCronJobRun: () => cronJobRuns?.cancel(), cronJobRunOutcomes: (older = false) => cronJobRuns?.outcomes(older),
    prepareScale: (reference: DocumentReference, replicasInput: string) => scales?.prepare(target(), client.selection, reference, replicasInput),
    submitScale: () => scales?.submit(), cancelScale: () => scales?.cancel(), scaleOutcomes: (older = false) => scales?.outcomes(older),
    prepareManifestApply: () => manifestApplies?.prepare(), submitManifestApply: () => manifestApplies?.submit(), cancelManifestApply: () => manifestApplies?.cancel(),
    manifestApplyStatus: (id?: string) => manifestApplies?.status(id), manifestApplyOutcomes: (older = false) => manifestApplies?.outcomes(older), canQueryManifestApply: (id: string) => manifestApplies?.canQuery(id) ?? false,
    prepareManifestCreate: (kind: 'scratch' | 'live' | 'file', text: string, format: 'yaml' | 'json', revision: number, selection?: { start: number; end: number }) => {
      if (kind === 'scratch') return manifestCreates?.prepare(text, format, { kind: selection ? 'selection' : 'scratch', revision }, selection);
      if (kind === 'file' && !selection) return manifestCreates?.prepareCaptured(async () => {
        const file = workspaceState.file; if (!file || workspaceState.phase !== 'ready' || workspaceState.stale) throw new BoundaryError('STALE_TARGET'); return manifestFileInput(file, format);
      }, format);
      const snapshot = saveSnapshot(kind); if (!snapshot) return;
      return manifestCreates?.prepare(snapshot.text, kind === 'live' ? documentState.editor?.origin.format ?? format : format, { kind: selection ? 'selection' : 'live', revision: snapshot.source.revision }, selection);
    },
    prepareManifestCreateFile: (path: string, format: 'yaml' | 'json') => manifestCreates?.prepareCaptured(async () => manifestFileInput(await workspace.captureFile(path), format, true), format, true),
    prepareFileSaveForCreate: () => {
      const file = workspaceState.file; if (!file || file.detached || workspaceState.phase !== 'ready' || workspaceState.stale) return;
      return fileSaves?.prepare('file', file.origin.root, file.origin.path); // Only prepares the separate Save confirmation; never submits or continues Create automatically.
    },
    manifestCreateFileLocation: () => ({ root: workspaceState.scope?.root, path: workspaceState.file?.origin.path }),
    invalidateManifestCreate: () => manifestCreates?.changed(), submitManifestCreate: () => manifestCreates?.submit(), cancelManifestCreate: () => manifestCreates?.cancel(),
    manifestCreateStatus: (id?: string) => manifestCreates?.status(id), manifestCreateOutcomes: (next = false) => manifestCreates?.outcomes(next),
    onManifestDiff: (callback: (state: ManifestDiffState) => void) => { showManifestDiff = callback; return () => { showManifestDiff = () => {}; }; },
    readManifestDiff: (kind: 'live' | 'file', format: 'yaml' | 'json', selection?: { start: number; end: number }) => manifestDiff?.read(kind, format, selection),
    inspectManifestJsonMerge: (index: number) => manifestDiff?.inspectJsonMerge(index),
    cancelManifestDiff: () => manifestDiff?.cancel(), closeManifestDiff: () => manifestDiff?.reset(),
    onFileSave: (callback: (state: FileSaveState) => void) => { showFileSave = callback; return () => { showFileSave = () => {}; }; },
    prepareFileSave: (kind: 'live' | 'file', root: string, path: string) => fileSaves?.prepare(kind, root, path),
    submitFileSave: () => fileSaves?.submit(), cancelFileSave: () => fileSaves?.cancel(), invalidateFileSave: () => fileSaves?.reset(),
    fileSaveStatus: (id?: string) => fileSaves?.status(id), fileSaveOutcomes: (next = false) => fileSaves?.outcomes(next),
    fileSaveDefault: (kind: 'live' | 'file') => { const source = saveSnapshot(kind); return source?.source.previousFile ?? source?.source.file; },
    onWorkspace: (callback: (state: WorkspaceState) => void) => { showWorkspace = callback; return () => { showWorkspace = () => {}; }; },
    workspaceDirectory: () => workspaceDirectory, // Trusted bridge hint only, not service attestation or a write grant.
    openWorkspace: (root: string) => workspace.open(root), readWorkspaceFile: (path: string, discard = false) => workspace.read(path, discard),
    rebindWorkspace: () => { fileSaves?.reset(); return workspace.rebind(); },
    keepWorkspaceDraft: () => { fileSaves?.reset(); workspace.keepDraft(); },
    browseWorkspace: (path = '', showHidden = false, next = false) => workspace.browse(path, showHidden, next), pickWorkspaceEntry: (name: string) => workspace.pick(name),
    workspaceDestinationDirectory: () => workspaceState.scope && workspaceState.listing ? { root: workspaceState.scope.root, path: workspaceState.listing.path } : undefined,
    editWorkspaceFile: (text: string) => workspace.edit(text), revertWorkspaceFile: () => workspace.revert(), cancelWorkspaceRead: () => workspace.cancel(), closeWorkspace: (discard = false) => workspace.close(discard),
    tree, // Headless state/query integration only; no unmeasured tree renderer is enabled.
    onHelmRepositories: (callback: (state: HelmRepositoryState) => void) => { showHelmRepositories = callback; return () => { showHelmRepositories = () => {}; }; },
    readHelmRepositories: (selection: unknown) => helmRepositories.connect(selection, `${viewId}:${projectRevision}`),
    openHelmRepositoryNode: (id: string) => helmRepositories.open(id), nextHelmRepositories: () => helmRepositories.next(), backHelmRepositories: () => helmRepositories.back(), cancelHelmRepositories: () => helmRepositories.cancel(), closeHelmRepositories: () => helmRepositories.reset(),
    readLogPreferences: () => logPreferences.read(),
    saveLogPreferences: (value: unknown) => logPreferenceWriter.save(value),
    copyName: async (input: unknown) => {
      if (bridgeDisposed) throw new BoundaryError('SERVICE_CLOSED');
      if (copyCalls) throw new BoundaryError('QUERY_LIMIT'); // A pending SDK call keeps the one real unsettled clipboard slot.
      const text = typeof input === 'object' && input !== null && (input as { kind?: unknown }).kind === 'tree'
        ? copyTreeNameText(input, current, tree.snapshot)
        : copyNameText(input, current, resourceState, branchState, target());
      if (text.length > GUEST_CLIPBOARD_TEXT_MAX) throw new BoundaryError('BUDGET_EXCEEDED');
      copyCalls++;
      try { await host.writeClipboard(text); } finally { copyCalls--; } // No retry, storage/chat fallback or automatic copy.
    },
    readHelmReleaseDetail: (namespace: string, release: string) => helmReleases?.detail(target(), client.selection, namespace, release),
    readRequestDiagnostics: async (): Promise<unknown> => {
      if (bridgeDisposed) throw new BoundaryError('SERVICE_CLOSED');
      const response = await host.serviceRequest({ method: 'GET', path: '/v2/status/requests' });
      return JSON.parse(response.body) as unknown;
    },
    copyLogPage: (text: string) => {
      if (!text || text.length > Math.min(GUEST_CLIPBOARD_TEXT_MAX, 100_000)) return Promise.reject(new Error('COPY_LIMIT'));
      return host.writeClipboard(text); // Only the log viewer's explicit Copy-page click calls this; no storage/chat fallback.
    },
    startEventFollow: () => {
      const source = eventState.source, page = eventState.page;
      if (eventState.phase !== 'ready' || eventState.stale || !source || !page) return Promise.resolve();
      return eventFollows.start({ protocol: 2, target: source.target, selection: source.selection, scope: source.scope, namespace: page.namespace, apiVersion: page.apiVersion, recoveryPolicy: 'single-410-relist' });
    },
    stopEventFollow: () => eventFollows.stop(),
    runLogFollow: (container: string, options: unknown) => {
      const source = podLogState.source;
      if (podLogState.phase !== 'ready' || podLogState.stale || !source || !podLogState.containers.some(item => item.name === container)) return Promise.resolve();
      return logFollows.start({ protocol: source.protocol, target: source.target, selection: source.selection, reference: source.reference, ...(source.origin ? { origin: source.origin } : {}), container, options });
    },
    stopLogFollow: () => logFollows.stop(),
    startWatch: (resource: string, resourceVersion: string, object?: { name: string; uid: string }) => watches.start({ protocol: 2, recoveryPolicy: 'single-410-relist', target: target(), selection: client.selection, resource, resourceVersion, ...(object ? { object } : {}) }),
    startTreeWatch: async (id: string) => {
      const row = tree.snapshot.rows.find(value => value.id === id), currentTarget = target();
      if (!row || row.stale || !currentTarget) return watches.start(undefined);
      const parent = row.entry.query?.kind === 'resources' || row.entry.query?.kind === 'custom-resources' ? row
        : tree.snapshot.rows.find(value => value.id === row.parent);
      if (!parent || !['resources', 'custom-resources'].includes(parent.entry.query?.kind ?? '')) return watches.start(undefined);
      let loaded = tree.loadedProof(parent.id);
      if (!loaded) { await tree.refresh(parent.id); loaded = tree.loadedProof(parent.id); }
      if (!loaded || !sameTarget(loaded.query.target, currentTarget) || !loaded.proof.resourceVersion) return watches.start(undefined);
      const resource = row.id === parent.id ? undefined : row.entry.node.resource;
      const common = { protocol: 2, recoveryPolicy: 'single-410-relist', target: currentTarget, selection: client.selection,
        resourceVersion: resource?.resourceVersion ?? loaded.proof.resourceVersion, ...(resource?.uid ? { object: { name: resource.name, uid: resource.uid } } : {}) };
      if (loaded.query.kind === 'resources') return watches.start({ ...common, resource: loaded.query.resource });
      if (loaded.query.kind === 'custom-resources' && loaded.proof.resourceType && loaded.proof.listKind) return watches.start({ ...common, resource: 'custom-resource',
        custom: { type: loaded.proof.resourceType, definition: loaded.query.definition, listKind: loaded.proof.listKind } });
      return watches.start(undefined);
    },
    startCustomWatch: (id?: string) => {
      const page = branchState.page, currentTarget = target();
      if (branchState.phase !== 'ready' || branchState.stale || page?.kind !== 'custom-resources' || !currentTarget || !sameTarget(page.target, currentTarget)) return Promise.resolve();
      const object = id === undefined ? undefined : page.nodes.find(node => node.id === id)?.resource;
      if (id !== undefined && (!object?.uid || !object.resourceVersion)) return Promise.resolve();
      return watches.start({ protocol: 2, recoveryPolicy: 'single-410-relist', target: currentTarget, selection: client.selection, resource: 'custom-resource',
        custom: { type: page.resourceType, definition: page.definition, listKind: page.listKind }, resourceVersion: object?.resourceVersion ?? page.resourceVersion,
        ...(object?.uid ? { object: { name: object.name, uid: object.uid } } : {}) });
    },
    stopWatch: () => watches.reset(),
    readExplanation: (fieldId: string, revision: number) => {
      try { return explanations.read(explanationRequest(documentState, fieldId, revision)); }
      catch (error) { explanations.reset(error instanceof BoundaryError ? error.code : 'CONTENT_INVALID'); return Promise.resolve(); }
    },
    clearExplanation: () => explanations.reset(),
    readInspection: (reference: LoadDocumentReference, mode: 'wide' | 'describe') => inspections.read({ protocol: 2, target: target(), selection: client.selection, reference, mode }),
    readClusterInfo: () => inspections.read({ protocol: 2, target: target(), selection: client.selection, mode: 'cluster-info' }),
    nextInspection: () => inspections.next(), refreshInspection: () => inspections.refresh(), cancelInspection: () => inspections.cancel(), closeInspection: () => inspections.reset(),
    readSourceDirectory: (directory: string, showHidden: boolean) => sourcePicker.read(directory, showHidden), nextSourceFiles: () => sourcePicker.next(), closeSourcePicker: () => sourcePicker.reset(),
    pickSourceFile: (name: string, append: boolean) => { const path = sourcePicker.pick(name); if (path) { preferences.reset(); sourceFileChosen(path, append); } },
    readContextChoices: (search: string) => { contexts.reset(); return current?.phase === 'ready' ? contextChoices.read(client.selection, search) : Promise.resolve(); },
    nextContextChoices: () => contextChoices.next(), closeContextChoices: () => contextChoices.reset(),
    chooseContext: (name: string) => {
      const choice = contextChoices.pick(name), config = current?.phase === 'ready' ? current.config : undefined;
      if (!choice || !config || choice.serviceGeneration !== config.serviceGeneration || choice.configIdentity !== config.configIdentity || JSON.stringify(choice.selection) !== JSON.stringify(client.selection)) { contextChoices.reset('STALE_TARGET'); return Promise.resolve(); }
      return contexts.prepare({ serviceGeneration: choice.serviceGeneration, projectId: `${viewId}:${projectRevision}`, configIdentity: choice.configIdentity }, choice.selection, choice.context);
    },
    readPreferences: (restore = false) => preferences.read(restore),
    preparePreference: (kind: PreferenceOutcome['kind'], selection?: unknown, headId?: string) => preferences.prepare(kind, selection, headId),
    submitPreference: () => preferences.submit(), closePreference: () => preferences.reset(),
    prepareContext: (context: string) => {
      const config = current?.phase === 'ready' ? current.config : undefined;
      return contexts.prepare(config ? { serviceGeneration: config.serviceGeneration, projectId: `${viewId}:${projectRevision}`, configIdentity: config.configIdentity } : undefined, client.selection, context);
    },
    useContext: async (context: string) => {
      const config = current?.phase === 'ready' && !current.stale ? current.config : undefined;
      if (bridgeDisposed || !config || config.status !== 'ready') return;
      const revision = projectRevision, selection = client.selection;
      const outcome = await contexts.switchTo({ serviceGeneration: config.serviceGeneration, projectId: `${viewId}:${revision}`, configIdentity: config.configIdentity }, selection, context);
      if (bridgeDisposed || revision !== projectRevision || JSON.stringify(client.selection) !== JSON.stringify(selection)
        || current?.config?.serviceGeneration !== config.serviceGeneration || current.config.configIdentity !== config.configIdentity) return;
      if (outcome?.phase === 'succeeded') await client.reload(); // Only confirmed disk success drives the new tree.
    },
    submitContext: () => contexts.submit(), closeContext: () => contexts.reset(), readContextOutcomes: (older = false) => contexts.outcomes(older),
    prepareContextDelete: (context: string) => {
      const config = current?.phase === 'ready' ? current.config : undefined;
      return contextDeletes.prepare(config ? { serviceGeneration: config.serviceGeneration, projectId: `${viewId}:${projectRevision}`, configIdentity: config.configIdentity } : undefined, client.selection, context);
    },
    submitContextDelete: () => contextDeletes.submit(), closeContextDelete: () => contextDeletes.reset(), readContextDeleteOutcomes: (older = false) => contextDeletes.outcomes(older),
    prepareDelete: (parameters: DeleteParameters) => deletes.prepare(target(), client.selection, parameters),
    submitDelete: () => deletes.submit(), closeDelete: () => deletes.reset(), readDeleteOutcomes: (older = false) => deletes.outcomes(older),
    prepareNamespace: (namespace: string) => {
      if (namespaceSwitchBusy) return;
      const config = current?.phase === 'ready' ? current.config : undefined;
      return namespaces.prepare(config ? { serviceGeneration: config.serviceGeneration, projectId: `${viewId}:${projectRevision}`, configIdentity: config.configIdentity } : undefined,
        client.selection, config?.currentContext ?? '', namespace);
    },
    onNamespaceSwitch: (callback: (state: NamespaceSwitchState) => void) => { showNamespaceSwitch = callback; return () => { showNamespaceSwitch = () => {}; }; },
    useNamespace: (namespace: string, expected: Omit<TargetIdentity, 'projectId'>) => runNamespaceSwitch(namespace, expected),
    submitNamespace: () => runNamespaceSwitch(undefined), closeNamespace: () => { if (!namespaceSwitchBusy) namespaces.reset(); }, readNamespaceOutcomes: (older = false) => namespaces.outcomes(older),
    openNamespaceDelete: (reference: NamespaceDeleteReference) => namespaceDeletes.open(target(), client.selection, reference),
    prepareNamespaceDelete: (deletion: boolean, defaultRisk: boolean) => namespaceDeletes.prepare(deletion, defaultRisk),
    submitNamespaceDelete: (contents: boolean) => namespaceDeletes.submit(contents), closeNamespaceDelete: () => namespaceDeletes.reset(), readNamespaceDeleteOutcomes: (older = false) => namespaceDeletes.outcomes(older),
    readDocument: (reference: LoadDocumentReference, format: 'yaml' | 'json') => documents.read({ protocol: protocolVersion, selection: client.selection, target: target(), reference, format }),
    refreshExplorer: () => tree.refreshAll(),
    activateTreeMessage: (id: string) => tree.activate(id),
    treeMessage: () => tree.snapshot.message,
    analyseDocument: () => documents.analyse(), selectDocument: (index: number) => documents.selectDocument(index),
    nextDocument: () => documents.next(), reloadDocument: (discard = false) => documents.reload(discard), editDocument: (text: string) => documents.edit(text), revertDocument: () => documents.revert(), cancelDocument: () => documents.cancel(), closeDocument: (discard = false) => documents.close(discard),
    select: (selection: unknown) => { preferences.reset(); return client.select(selection); }, next: () => client.next(), reload: () => client.reload(),
    cancel: () => client.cancel(),
    readResource: (resource: string) => {
      watches.reset();
      events.reset(); podLogs.reset(); keyContent.reset(); branches.reset();
      return resources.read({ protocol: protocolVersion, selection: client.selection, resource,
        target: target() });
    },
    readChildren: (parent: ParentReference) => { watches.reset(); events.reset(); podLogs.reset(); keyContent.reset(); return branches.read({ protocol: protocolVersion, selection: client.selection, target: target(), kind: 'children', parent }); },
    readCustomTypes: () => { watches.reset(); events.reset(); podLogs.reset(); keyContent.reset(); return branches.read({ protocol: protocolVersion, selection: client.selection, target: target(), kind: 'custom-types' }); },
    readCustomResources: (definition: DefinitionReference) => { watches.reset(); events.reset(); podLogs.reset(); keyContent.reset(); return branches.read({ protocol: protocolVersion, selection: client.selection, target: target(), kind: 'custom-resources', definition }); },
    readEvents: (scope: EventScope = { kind: 'current' }) => { podLogs.reset(); keyContent.reset(); return events.read({ protocol: protocolVersion, selection: client.selection, target: target(), scope }); },
    nextEvents: () => events.next(), reloadEvents: () => events.reload(), cancelEvents: () => events.cancel(), closeEvents: () => events.reset(),
    openJobLog: (origin: JobLogOrigin) => { events.reset(); keyContent.reset(); podLogs.reset(); return jobSelections.start({ protocol: 2, selection: client.selection, target: target(), origin }); },
    stopJobLogSelection: () => jobSelections.stop(),
    closeJobLogSelection: () => jobSelections.reset(),
    openPodLog: (reference: PodLogReference, origin?: JobLogOrigin) => { jobSelections.reset(); events.reset(); keyContent.reset(); return podLogs.open({ protocol: protocolVersion, selection: client.selection, target: target(), reference, ...(origin ? { origin } : {}), kind: 'containers' }); },
    runPodLog: (container: string, options: unknown) => podLogs.run(container, options), nextPodLog: () => podLogs.next(), cancelPodLog: () => podLogs.cancel(), clearPodLog: () => { logFollows.clear(); podLogs.clear(); }, closePodLog: () => podLogs.reset(),
    readKeyContent: (reference: KeyReference) => { events.reset(); podLogs.reset(); return keyContent.read({ protocol: protocolVersion, selection: client.selection, target: target(), reference }); },
    nextKeyContent: () => keyContent.next(), reloadKeyContent: () => keyContent.reload(), cancelKeyContent: () => keyContent.cancel(), clearKeyContent: () => keyContent.reset(),
    nextBranch: () => { watches.reset(); events.reset(); podLogs.reset(); keyContent.reset(); return branches.next(); }, cancelBranch: () => branches.cancel(), resetBranches: () => { watches.reset(); events.reset(); podLogs.reset(); keyContent.reset(); branches.reset(); },
    nextResource: () => { watches.reset(); events.reset(); podLogs.reset(); keyContent.reset(); branches.reset(); return resources.next(); }, cancelResource: () => resources.cancel(), resetResources: () => { watches.reset(); events.reset(); podLogs.reset(); keyContent.reset(); branches.reset(); resources.reset(); },
    dispose: () => { bridgeDisposed = true; helmParameterises?.dispose(); showHelmParameterise = () => {}; helmConverts?.dispose(); showHelmConvert = () => {}; helmRequirements?.dispose(); showHelmRequirement = () => {}; helmFetches?.dispose(); showHelmFetch = () => {}; helmCreates?.dispose(); showHelmCreate = () => {}; helmDepUps?.dispose(); showHelmDepUp = () => {}; helmPackages?.dispose(); showHelmPackage = () => {}; helmDryRuns?.dispose(); showHelmDryRun = () => {}; helmTemplates?.dispose(); showHelmTemplate = () => {}; helmLints?.dispose(); showHelmLint = () => {}; helmDependencies?.dispose(); showHelmDependencies = () => {}; helmValues?.dispose(); showHelmValues = () => {}; helmInspects?.dispose(); showHelmInspect = () => {}; helmRefreshes?.dispose(); showHelmRefresh = () => {}; helmVersions?.dispose(); showHelmVersion = () => {}; fileDeletes?.dispose(); showFileDelete = () => {}; configFileAdds?.dispose(); showConfigFileAdd = () => {}; configFileDeletes?.dispose(); showConfigFileDelete = () => {}; exposes?.dispose(); showExpose = () => {}; cronJobRuns?.dispose(); showCronJobRun = () => {}; scales?.dispose(); showScale = () => {}; manifestApplies?.dispose(); showManifestApply = () => {}; manifestCreates?.dispose(); showManifestCreate = () => {}; manifestDiff?.dispose(); showManifestDiff = () => {}; fileSaves?.dispose(); showFileSave = () => {}; workspace.dispose(); showWorkspace = () => {}; helmRepositories.dispose(); showHelmRepositories = () => {}; logPreferences.dispose(); jobSelections.dispose(); eventFollows.dispose(); logFollows.dispose(); watches.dispose(); explanations.dispose(); inspections.dispose(); contextChoices.dispose(); sourcePicker.dispose(); contextDeletes.dispose(); preferences.dispose(); contexts.dispose(); namespaceDeletes.dispose(); namespaces.dispose(); deletes.dispose(); documents.dispose(); events.dispose(); podLogs.dispose(); keyContent.dispose(); tree.dispose(); branches.dispose(); resources.dispose(); client.dispose(); stopReady(); stopDirectory(); host.dispose(); },
  };
}

export { createProjectRuntime as mountHostBridge };
