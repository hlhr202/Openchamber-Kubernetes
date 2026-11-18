import { mountHostBridge } from '../host/panel-bridge.ts';
import { bindScene, disposeScene, sceneChanged } from './workspace-scene.ts';
import { mountWorkbenchSplit } from './workbench-split.ts';
import { mountTaskTabs } from './task-tabs.ts';
import { mountButton, mountSelect, mountTextField } from './controls.ts';
import { selectionFromLines } from '../shared/configuration.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import type { ConfigurationState } from '../host/configuration-client.ts';
import type { NamespaceSwitchState } from '../host/namespace-client.ts';
import { paintNamespaceSwitchStatus } from './namespace-switch-status.ts';
import type { ResourceState } from '../host/resource-client.ts';
import { resourceDescriptors } from '../shared/tree.ts';
import { parentFromResource } from '../shared/branch-protocol.ts';
import type { TreeRow } from '../shared/tree-model.ts';
import { explorerTitleActions } from '../shared/explorer-actions.ts';
import type { ExplorerCommandId } from '../shared/explorer-actions.ts';
import { createActionMenuManager } from './action-menu.ts';
import { createActionSvgIcon } from './explorer-icons.ts';
import { mountHelmRepoTreeView } from './helm-repo-tree-view.ts';
import type { HelmRepoNodeTarget } from './helm-repo-tree-view.ts';
import { mountRequestDiagnosticsView } from './request-diagnostics-view.ts';
import { mountBranchDiagnostics } from './branch-diagnostics.ts';
import { mountKeyContentView } from './key-content-view.ts';
import { mountPodLogView } from './pod-log-view.ts';
import { mountJobLogSelectionView } from './job-log-selection-view.ts';
import { mountEventView } from './event-view.ts';
import { eventScopeFromNode } from '../shared/event-protocol.ts';
import { customDocumentReferenceFromNode, documentReferenceFromNode } from '../shared/document-protocol.ts';
import { mountDocumentView } from './document-view.ts';
import { mountDeleteView } from './delete-view.ts';
import { mountDeleteActions } from './delete-actions.ts';
import { mountNamespaceView } from './namespace-view.ts';
import { mountNamespaceDeleteView } from './namespace-delete-view.ts';
import { mountContextView } from './context-view.ts';
import { mountPreferenceView } from './preference-view.ts';
import { mountContextDeleteView } from './context-delete-view.ts';
import { mountSourcePickerView } from './source-picker-view.ts';
import { pickedSource } from '../shared/source-picker-protocol.ts';
import { mountContextChoiceView } from './context-choice-view.ts';
import { mountInspectionView } from './inspection-view.ts';
import { mountWatchView } from './watch-view.ts';
import { mountHelmRepositoryView } from './helm-repository-view.ts';
import { mountHelmVersionView } from './helm-version-view.ts';
import { mountHelmRefreshView } from './helm-refresh-view.ts';
import { mountHelmInspectView } from './helm-inspect-view.ts';
import { mountHelmValuesView } from './helm-values-view.ts';
import { mountHelmDependenciesView } from './helm-dependencies-view.ts';
import { mountHelmLintView } from './helm-lint-view.ts';
import { mountHelmTemplateView } from './helm-template-view.ts';
import { mountHelmDryRunView } from './helm-dryrun-view.ts';
import { mountHelmPackageView } from './helm-package-view.ts';
import { mountHelmDepUpView } from './helm-depup-view.ts';
import { mountHelmCreateView } from './helm-create-view.ts';
import { mountHelmFetchView } from './helm-fetch-view.ts';
import { mountHelmRequirementView } from './helm-requirement-view.ts';
import { mountHelmConvertView } from './helm-convert-view.ts';
import { mountHelmParameteriseView } from './helm-parameterise-view.ts';
import { mountCopyNameButton } from './copy-name-button.ts';
import { mountWorkspaceView } from './workspace-view.ts';
import { mountFileSaveView } from './file-save-view.ts';
import { mountManifestDiffView } from './manifest-diff-view.ts';
import { mountManifestCreateView } from './manifest-create-view.ts';
import { mountManifestApplyView } from './manifest-apply-view.ts';
import { mountScaleView } from './scale-view.ts';
import { mountCronJobRunView } from './cronjob-run-view.ts';
import { mountApplyFileView } from './apply-file-view.ts';
import { mountHelmReleaseView } from './helm-release-view.ts';
import { mountImageRunView } from './image-run-view.ts';
import { mountGitSyncView } from './git-sync-view.ts';
import { mountTerminalSessionView } from './terminal-session-view.ts';
import { mountTreeView } from './tree-view.ts';
import { mountMergeKubeconfigView } from './merge-kubeconfig-view.ts';
import { mountClusterView } from './cluster-view.ts';
import { mountSessionsView, mountDebugControlView } from './sessions-debug-view.ts';
import { mountExecForwardDashboardView } from './exec-forward-dashboard-view.ts';
import { mountExposeView } from './expose-view.ts';
import { mountConfigFileDeleteView } from './config-file-delete-view.ts';
import { mountConfigFileAddView } from './config-file-add-view.ts';
import { mountFileDeleteView } from './file-delete-view.ts';
import { isPanelMessage, panelDirection, panelText } from './i18n.ts';
import type { PanelLocale, PanelMessage } from './i18n.ts';
import { localizeExplorerActions } from './explorer-localization.ts';

type PanelRoute =
  | 'explorer'
  | 'content'
  | 'actions'
  | 'sessions'
  | 'sources'
  | 'workspace'
  | 'clusterAdmin'
  | 'helmTools'
  | 'diagnostics'
  | 'requestDiag';

export function mountPanel(document: Document): () => void {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('PANEL_ROOT_MISSING');

  // Top-level resource-tree-first workbench shell (RX-F1 / RX-F2)
  const workbench = document.createElement('div');
  workbench.className = 'oc-k8s-workbench';
  workbench.dataset.route = 'explorer';
  const explorerShell = document.createElement('div');
  explorerShell.className = 'oc-k8s-explorer-shell';
  explorerShell.id = 'oc-k8s-explorer-shell';
  const workbenchSplit = mountWorkbenchSplit(workbench, explorerShell);
  const subviewShell = document.createElement('div');
  subviewShell.className = 'oc-k8s-subview-shell';
  subviewShell.hidden = true;

  // Clusters header (view/title) + compact empty/error banner + tree mount + Helm Repos mount
  const clustersSection = document.createElement('section');
  clustersSection.className = 'oc-k8s-explorer-section oc-k8s-clusters-section';
  clustersSection.setAttribute('aria-label', 'Clusters');

  const clustersHeader = document.createElement('header');
  clustersHeader.className = 'oc-k8s-view-header';
  const clustersTitle = document.createElement('h2');
  clustersTitle.className = 'oc-k8s-view-title';
  const contextPill = document.createElement('span');
  contextPill.className = 'oc-k8s-context-pill';
  const clustersTitleActions = document.createElement('div');
  clustersTitleActions.className = 'oc-k8s-title-actions';
  clustersHeader.append(clustersTitle, contextPill, clustersTitleActions);
  const contextSwitchStatus = document.createElement('p');
  contextSwitchStatus.className = 'oc-k8s-inline-status';
  contextSwitchStatus.setAttribute('role', 'status');
  contextSwitchStatus.hidden = true;
  let directContextSwitch = false;

  const emptyBanner = document.createElement('div');
  emptyBanner.className = 'oc-k8s-empty-banner';
  emptyBanner.hidden = true;
  const emptyText = document.createElement('p');
  emptyText.className = 'oc-k8s-empty-text';
  const emptyActions = document.createElement('div');
  emptyActions.className = 'oc-k8s-empty-actions';
  emptyBanner.append(emptyText, emptyActions);

  const clustersTreeMount = document.createElement('div');
  clustersTreeMount.className = 'oc-k8s-clusters-tree-mount';
  const helmReposMount = document.createElement('div');
  helmReposMount.className = 'oc-k8s-helm-repos-mount';
  const titleOverlayHost = document.createElement('div');
  titleOverlayHost.className = 'oc-k8s-menu-overlay-host';

  clustersSection.append(clustersHeader, contextSwitchStatus, emptyBanner, clustersTreeMount);
  explorerShell.append(clustersSection, helmReposMount, titleOverlayHost);

  // Subview top navigation bar (← Back to Explorer + current subview title)
  const subviewBar = document.createElement('header');
  subviewBar.className = 'oc-k8s-subview-bar';
  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.className = 'oc-k8s-back-button';
  const subviewHeading = document.createElement('h2');
  subviewHeading.className = 'oc-k8s-subview-title';
  subviewBar.append(backButton, subviewHeading);

  // Route containers inside subviewShell (mounted on-demand visually; hidden until navigated to)
  const contentRoute = document.createElement('div');
  const actionsRoute = document.createElement('div');
  const sessionsRoute = document.createElement('div');
  const sourcesRoute = document.createElement('div');
  const workspaceRoute = document.createElement('div');
  const clusterAdminRoute = document.createElement('div');
  const helmToolsRoute = document.createElement('div');
  const diagnosticsRoute = document.createElement('div');
  const requestDiagRoute = document.createElement('div');

  const routeContainers: Readonly<Record<Exclude<PanelRoute, 'explorer'>, HTMLElement>> = {
    content: contentRoute,
    actions: actionsRoute,
    sessions: sessionsRoute,
    sources: sourcesRoute,
    workspace: workspaceRoute,
    clusterAdmin: clusterAdminRoute,
    helmTools: helmToolsRoute,
    diagnostics: diagnosticsRoute,
    requestDiag: requestDiagRoute,
  };
  for (const [route, el] of Object.entries(routeContainers)) { el.hidden = true; el.className = 'oc-k8s-route'; el.dataset.route = route; }
  subviewShell.append(
    subviewBar,
    contentRoute,
    actionsRoute,
    sessionsRoute,
    sourcesRoute,
    workspaceRoute,
    clusterAdminRoute,
    helmToolsRoute,
    diagnosticsRoute,
    requestDiagRoute,
  );

  const namespaceSwitchStatus = document.createElement('p');
  namespaceSwitchStatus.className = 'oc-k8s-inline-status oc-k8s-namespace-switch-status';
  namespaceSwitchStatus.setAttribute('role', 'status'); namespaceSwitchStatus.hidden = true;
  workbench.append(namespaceSwitchStatus, explorerShell, workbenchSplit.handle, subviewShell);
  root.replaceChildren(workbench);

  // Existing audited sourceControls + resourceSection remain intact inside sourcesRoute & diagnosticsRoute.
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const details = document.createElement('p');
  const scope = document.createElement('p');
  const sourceControls = document.createElement('section');
  sourceControls.setAttribute('aria-label', 'Configuration sources');
  const modeSlot = document.createElement('div'), pathsSlot = document.createElement('div'), actions = document.createElement('div');
  actions.className = 'configuration-actions';
  const disclosure = document.createElement('p');
  const listSlot = document.createElement('div');
  listSlot.className = 'configuration-results';
  const table = document.createElement('table'), caption = document.createElement('caption'), head = document.createElement('thead'), body = document.createElement('tbody');
  table.append(caption, head, body);
  listSlot.append(table);
  sourceControls.append(modeSlot, pathsSlot, actions, disclosure);
  sourcesRoute.append(sourceControls, status, details, listSlot);

  const resourceSection = document.createElement('section'), resourceNote = document.createElement('p'), resourceStatus = document.createElement('p');
  resourceStatus.setAttribute('role', 'status');
  const resourceTypeSlot = document.createElement('div'), resourceActions = document.createElement('div'), resourceList = document.createElement('div');
  resourceActions.className = 'configuration-actions'; resourceList.className = 'configuration-results';
  const resourceTable = document.createElement('table'), resourceCaption = document.createElement('caption'), resourceHead = document.createElement('thead'), resourceBody = document.createElement('tbody');
  resourceTable.append(resourceCaption, resourceHead, resourceBody); resourceList.append(resourceTable);
  resourceSection.append(resourceNote, resourceTypeSlot, resourceActions, resourceStatus, resourceList);
  diagnosticsRoute.append(resourceSection, scope);

  let mode: ConfigSelection['mode'] = 'default', paths = '', locale: PanelLocale = 'en', state: ConfigurationState = { phase: 'loading', stale: false };
  let bridge: ReturnType<typeof mountHostBridge> | undefined;
  let stopHelmRepositories = () => {};
  let stopWorkspace = () => {};
  let stopFileSave = () => {};
  let stopManifestDiff = () => {};
  let stopManifestCreate = () => {};
  let stopManifestApply = () => {};
  let stopScale = () => {};
  let stopCronJobRun = () => {};
  let stopApplyFile = () => {};
  let stopHelmRelease = () => {};
  let stopImageRun = () => {};
  let stopGitSync = () => {};
  let stopSession = () => {};
  let stopTree = () => {};
  let stopHelmWrite = () => {};
  let stopMergeKubeconfig = () => {};
  let stopCluster = () => {};
  let stopExpose = () => {};
  let stopConfigFileDelete = () => {};
  let stopConfigFileAdd = () => {};
  let stopFileDelete = () => {};
  let selectedResource = 'namespaces', resourceState: ResourceState = { phase: 'idle', stale: false };
  let disposed = false;
  let activeRoute: PanelRoute = 'explorer';
  // Store a message reference, not the rendered title, in the project scene.
  type RouteTitle = string | { action: PanelMessage; name: string };
  let activeRouteTitle: RouteTitle = '';
  let activePageKey = 'explorer';
  const pageScroll = new Map<string, { top: number; left: number }>();
  let savedTreeScrollTop = 0;
  let latestTreeSnapshot: Parameters<typeof treeView.show>[0] | undefined;
  let namespaceSwitch: NamespaceSwitchState = { phase: 'idle' };

  function paintNamespaceSwitch() {
    paintNamespaceSwitchStatus(namespaceSwitchStatus, namespaceSwitch, locale);
  }

  const resourceButtons: (() => void)[] = [];
  const contextButtons: (() => void)[] = [];
  const titleMenu = createActionMenuManager(document, titleOverlayHost);
  const sourceTasks = mountTaskTabs(document, sourcesRoute, [
    { id: 'source', label: 'Configuration source', zh: '配置来源' }, { id: 'browse', label: 'Browse Server files', zh: '浏览服务器文件' },
    { id: 'contexts', label: 'Find context', zh: '查找 Context' }, { id: 'preferences', label: 'Remembered sources', zh: '记住的来源' },
  ], () => locale);
  sourceTasks.slots.source!.append(sourceControls, status, details, listSlot);

  // Content & Operation sub-containers (routed cleanly)
  const contentContainers = {
    documents: document.createElement('div'),
    inspections: document.createElement('div'),
    podLogs: document.createElement('div'),
    jobSelections: document.createElement('div'),
    keyContent: document.createElement('div'),
    events: document.createElement('div'),
    watches: document.createElement('div'),
    helmRelease: document.createElement('div'),
    branches: document.createElement('div'),
  };
  for (const el of Object.values(contentContainers)) { el.hidden = true; el.className = 'oc-k8s-subroute'; contentRoute.append(el); }

  const actionContainers = {
    contexts: document.createElement('div'),
    contextDeletes: document.createElement('div'),
    namespaces: document.createElement('div'),
    namespaceDeletes: document.createElement('div'),
    deletes: document.createElement('div'),
    scale: document.createElement('div'),
    cronJobRun: document.createElement('div'),
    expose: document.createElement('div'),
    configFileDelete: document.createElement('div'),
    configFileAdd: document.createElement('div'),
    helmReleaseWrite: document.createElement('div'),
  };
  for (const el of Object.values(actionContainers)) { el.hidden = true; el.className = 'oc-k8s-subroute'; actionsRoute.append(el); }

  const contexts = mountContextView(document, actionContainers.contexts, () => bridge, () => locale);
  const contextDeletes = mountContextDeleteView(document, actionContainers.contextDeletes, () => bridge, () => locale);
  const preferences = mountPreferenceView(document, sourceTasks.slots.preferences!, () => bridge, () => selectionFromLines(mode, paths), () => locale);
  const sourcePicker = mountSourcePickerView(document, sourceTasks.slots.browse!, () => bridge, () => locale);
  const contextChoices = mountContextChoiceView(document, sourceTasks.slots.contexts!, () => bridge, () => locale);

  const branches = mountBranchDiagnostics(document, contentContainers.branches, () => bridge, () => locale);
  const keyContent = mountKeyContentView(document, contentContainers.keyContent, () => bridge, () => locale);
  const podLogs = mountPodLogView(document, contentContainers.podLogs, () => bridge, () => locale);
  const jobSelections = mountJobLogSelectionView(document, contentContainers.jobSelections, () => bridge, () => locale);
  const events = mountEventView(document, contentContainers.events, () => bridge, () => locale);
  const documents = mountDocumentView(document, contentContainers.documents, () => bridge, () => locale);
  const inspections = mountInspectionView(document, contentContainers.inspections, () => bridge, () => locale);
  const watches = mountWatchView(document, contentContainers.watches, () => bridge, () => locale);

  const helmTasks = mountTaskTabs(document, helmToolsRoute, [
    { id: 'inspect', label: 'Chart details', zh: 'Chart 详情' }, { id: 'values', label: 'Values', zh: 'Values' },
    { id: 'dependencies', label: 'Dependencies', zh: '查看依赖' }, { id: 'template', label: 'Render template', zh: '渲染模板' },
    { id: 'lint', label: 'Lint', zh: '检查 Chart' }, { id: 'dryRun', label: 'Dry run', zh: '试运行' },
    { id: 'refresh', label: 'Refresh repository indexes', zh: '刷新仓库索引' }, { id: 'fetch', label: 'Download chart', zh: '下载 Chart' },
    { id: 'create', label: 'Create chart', zh: '创建 Chart' }, { id: 'package', label: 'Package chart', zh: '打包 Chart' },
    { id: 'depUp', label: 'Update dependencies', zh: '更新依赖' }, { id: 'requirement', label: 'Dependency entry', zh: '生成依赖条目' },
    { id: 'convert', label: 'Convert manifest', zh: '转换资源清单' }, { id: 'parameterise', label: 'Parameterise', zh: '提取参数' },
    { id: 'repositories', label: 'Repository files', zh: '仓库文件' }, { id: 'version', label: 'Helm version', zh: 'Helm 版本' },
  ], () => locale);
  const helmRepositories = mountHelmRepositoryView(document, helmTasks.slots.repositories!, () => bridge, () => locale);
  const helmVersion = mountHelmVersionView(document, helmTasks.slots.version!, () => bridge, () => locale);
  const helmRefresh = mountHelmRefreshView(document, helmTasks.slots.refresh!, () => bridge, () => locale);
  const helmInspect = mountHelmInspectView(document, helmTasks.slots.inspect!, () => bridge, () => locale);
  const helmValues = mountHelmValuesView(document, helmTasks.slots.values!, () => bridge, () => locale);
  const helmDependencies = mountHelmDependenciesView(document, helmTasks.slots.dependencies!, () => bridge, () => locale);
  const helmLint = mountHelmLintView(document, helmTasks.slots.lint!, () => bridge, () => locale);
  const helmTemplate = mountHelmTemplateView(document, helmTasks.slots.template!, () => bridge, () => locale);
  const helmDryRun = mountHelmDryRunView(document, helmTasks.slots.dryRun!, () => bridge, () => locale);
  const helmPackage = mountHelmPackageView(document, helmTasks.slots.package!, () => bridge, () => locale);
  const helmDepUp = mountHelmDepUpView(document, helmTasks.slots.depUp!, () => bridge, () => locale);
  const helmCreate = mountHelmCreateView(document, helmTasks.slots.create!, () => bridge, () => locale);
  const helmFetch = mountHelmFetchView(document, helmTasks.slots.fetch!, () => bridge, () => locale);
  const helmRequirement = mountHelmRequirementView(document, helmTasks.slots.requirement!, () => bridge, () => locale);
  const helmConvert = mountHelmConvertView(document, helmTasks.slots.convert!, () => bridge, () => locale);
  const helmParameterise = mountHelmParameteriseView(document, helmTasks.slots.parameterise!, () => bridge, () => locale);

  const workspaceTasks = mountTaskTabs(document, workspaceRoute, [
    { id: 'files', message: 'task.files' }, { id: 'save', message: 'task.save' },
    { id: 'diff', message: 'task.compare' }, { id: 'create', message: 'task.createResources' },
    { id: 'apply', message: 'task.applyResource' }, { id: 'applyFile', message: 'task.applyFile' },
    { id: 'deleteFile', message: 'task.deleteResources' },
  ], () => locale);
  const workspace = mountWorkspaceView(document, workspaceTasks.slots.files!, () => bridge, () => locale);
  const fileSave = mountFileSaveView(document, workspaceTasks.slots.save!, () => bridge, () => locale);
  const manifestDiff = mountManifestDiffView(document, workspaceTasks.slots.diff!, () => bridge, () => locale);
  const manifestCreate = mountManifestCreateView(document, workspaceTasks.slots.create!, () => bridge, () => locale);
  const manifestApply = mountManifestApplyView(document, workspaceTasks.slots.apply!, () => bridge, () => locale);
  const applyFile = mountApplyFileView(document, workspaceTasks.slots.applyFile!, () => bridge, () => locale);
  const fileDelete = mountFileDeleteView(document, workspaceTasks.slots.deleteFile!, () => bridge, () => locale);

  const scale = mountScaleView(document, actionContainers.scale, () => bridge, () => locale);
  const cronJobRun = mountCronJobRunView(document, actionContainers.cronJobRun, () => bridge, () => locale);
  const expose = mountExposeView(document, actionContainers.expose, () => bridge, () => locale);
  const configFileDelete = mountConfigFileDeleteView(document, actionContainers.configFileDelete, () => bridge, () => locale);
  const configFileAdd = mountConfigFileAddView(document, actionContainers.configFileAdd, () => bridge, () => locale);
  const deletes = mountDeleteView(document, actionContainers.deletes, () => bridge, () => locale);
  const namespaces = mountNamespaceView(document, actionContainers.namespaces, () => bridge, () => locale);
  const namespaceDeletes = mountNamespaceDeleteView(document, actionContainers.namespaceDeletes, () => bridge, () => locale);
  const helmRelease = mountHelmReleaseView(document, contentContainers.helmRelease, () => bridge, () => locale);

  const clusterTasks = mountTaskTabs(document, clusterAdminRoute, [
    { id: 'cluster', message: 'task.clusterTools' }, { id: 'merge', message: 'task.mergeConfig' },
    { id: 'image', message: 'task.buildImage' }, { id: 'git', message: 'task.gitRevision' },
  ], () => locale);
  const imageRun = mountImageRunView(document, clusterTasks.slots.image!, () => bridge, () => locale);
  const gitSync = mountGitSyncView(document, clusterTasks.slots.git!, () => bridge, () => locale);
  const mergeKubeconfig = mountMergeKubeconfigView(document, clusterTasks.slots.merge!, () => bridge, () => locale);
  const clusterView = mountClusterView(document, clusterTasks.slots.cluster!, () => bridge, () => locale);

  const sessionTasks = mountTaskTabs(document, sessionsRoute, [
    { id: 'sessions', message: 'task.sessions' }, { id: 'terminal', message: 'action.terminal' },
    { id: 'forward', message: 'task.execForward' }, { id: 'debug', message: 'task.debug' },
  ], () => locale);
  const terminalSession = mountTerminalSessionView(document, sessionTasks.slots.terminal!, () => bridge, () => locale);
  const execForward = mountExecForwardDashboardView(document, sessionTasks.slots.forward!, () => bridge, () => locale);
  const sessionsView = mountSessionsView(document, sessionTasks.slots.sessions!, () => bridge, () => locale);
  const debugControl = mountDebugControlView(document, sessionTasks.slots.debug!, () => bridge, () => locale);

  const requestDiagnostics = mountRequestDiagnosticsView(document, requestDiagRoute, () => bridge, () => locale);

  function navigateTo(
    route: PanelRoute,
    heading: RouteTitle = '',
    subkey?: keyof typeof contentContainers | keyof typeof actionContainers,
  ): void {
    pageScroll.set(activePageKey, { top: subviewShell.scrollTop, left: subviewShell.scrollLeft });
    activePageKey = `${route}:${subkey ?? ''}`;
    if (activeRoute === 'explorer' && route !== 'explorer') {
      savedTreeScrollTop = treeView.treeElement.scrollTop;
    }
    activeRoute = route;
    activeRouteTitle = heading;
    const isExplorer = route === 'explorer';
    explorerShell.hidden = !isExplorer;
    subviewShell.hidden = isExplorer;
    workbench.dataset.route = route;

    for (const [key, el] of Object.entries(routeContainers)) {
      el.hidden = key !== route;
    }
    if (route === 'content') {
      for (const [key, el] of Object.entries(contentContainers)) el.hidden = subkey ? key !== subkey : false;
    }
    if (route === 'actions') {
      for (const [key, el] of Object.entries(actionContainers)) el.hidden = subkey ? key !== subkey : false;
    }

    if (isExplorer) {
      treeView.treeElement.scrollTop = savedTreeScrollTop;
      treeView.focusTree();
    } else {
      subviewBar.focus?.();
    }
    paintShellHeader();
    const position = pageScroll.get(activePageKey);
    subviewShell.scrollTop = position?.top ?? 0; subviewShell.scrollLeft = position?.left ?? 0;
    sceneChanged(workbench);
  }

  backButton.addEventListener('click', () => {
    navigateTo('explorer');
  });

  function findRowCrdDefinition(row: TreeRow) {
    if (!row.parent || !latestTreeSnapshot) return null;
    const parent = latestTreeSnapshot.rows.find(candidate => candidate.id === row.parent);
    return parent?.entry.query?.kind === 'custom-resources' ? parent.entry.query.definition : null;
  }

  function dispatchTitleCommand(command: ExplorerCommandId): void {
    const zh = locale.toLowerCase().startsWith('zh');
    switch (command) {
      case 'extension.vsKubernetesRefreshExplorer':
        bridge?.refreshExplorer();
        return;
      case 'openchamber.k8s.collapseAll':
        bridge?.treeCollapseAll();
        return;
      case 'extension.vsKubernetesRefreshHelmRepoExplorer':
        void bridge?.readHelmRepositories({ mode: 'default' });
        return;
      case 'extension.vsKubernetesUseKubeconfig':
      case 'openchamber.k8s.openSources':
        sourceTasks.show('source');
        navigateTo('sources', zh ? '配置来源与上下文管理' : 'Configuration Sources & Contexts');
        return;
      case 'extension.vsKubernetesCreateCluster':
      case 'extension.vsKubernetesConfigureFromCluster':
      case 'openchamber.k8s.openClusterAdmin':
        clusterTasks.show('cluster');
        clusterView.selectTask('providers');
        navigateTo('clusterAdmin', zh ? '集群创建 / Kubeconfig 合并 / 镜像与 Git' : 'Clusters, Merge & Workloads');
        return;
      case 'openchamber.k8s.openWorkspace':
        navigateTo('workspace', zh ? 'Manifest 文件（Apply / Diff / Create）' : 'Manifest Files (Apply / Diff / Create)');
        return;
      case 'openchamber.k8s.openSessions':
        void bridge?.sessionsOverview();
        navigateTo('sessions', zh ? '会话、转发与调试' : 'Sessions, Port Forward & Debug');
        return;
      case 'openchamber.k8s.openPreferences':
        sourceTasks.show('preferences');
        navigateTo('sources', zh ? '配置来源与偏好设置' : 'Configuration Sources & Preferences');
        return;
      case 'openchamber.k8s.openDiagnostics':
        navigateTo('diagnostics', zh ? '分支与兼容诊断' : 'Branch & Compatibility Diagnostics');
        return;
      case 'openchamber.k8s.openRequestDiagnostics':
        navigateTo('requestDiag', zh ? '出站请求预算与诊断' : 'Request Budget & Diagnostics');
        void requestDiagnostics.load();
        return;
      case 'openchamber.k8s.openHelmTools':
        navigateTo('helmTools', zh ? 'Helm 工具与版本' : 'Helm Tools & Version');
        return;
      default:
        return;
    }
  }

  function dispatchNodeCommand(command: ExplorerCommandId, row: TreeRow): void {
    const zh = locale.toLowerCase().startsWith('zh');
    const node = row.entry.node;
    const reference = documentReferenceFromNode(node);
    const customRef = reference ? null : customDocumentReferenceFromNode(node, findRowCrdDefinition(row));
    const loadRef = reference ?? customRef;

    switch (command) {
      case 'openchamber.k8s.refreshBranch':
        void bridge?.treeRefresh(row.id);
        return;
      case 'openchamber.k8s.showMessage':
        bridge?.activateTreeMessage(row.id);
        return;
      case 'extension.vsKubernetesCopy': {
        const config = state.phase === 'ready' ? state.config : undefined;
        if (!config || !latestTreeSnapshot) return;
        void bridge?.copyName({
          kind: 'tree',
          rowId: row.id,
          generation: latestTreeSnapshot.generation,
          serviceGeneration: config.serviceGeneration,
          configIdentity: config.configIdentity,
        });
        return;
      }
      case 'extension.vsKubernetesUseContext':
        if (directContextSwitch) return;
        directContextSwitch = true;
        contextSwitchStatus.dataset.context = node.label;
        contextSwitchStatus.dataset.phase = 'switching';
        contextSwitchStatus.hidden = false;
        contextSwitchStatus.textContent = zh ? `正在切换到 ${node.label}…` : `Switching to ${node.label}…`;
        void bridge?.useContext(node.label).finally(() => {
          directContextSwitch = false;
          if (contextSwitchStatus.dataset.phase === 'switching') {
            contextSwitchStatus.dataset.phase = 'error';
            contextSwitchStatus.textContent = zh ? '切换未完成，请刷新配置后重试。' : 'Switch not completed. Refresh configuration before trying again.';
          }
        });
        return;
      case 'extension.vsKubernetesDeleteContext':
        void bridge?.prepareContextDelete(node.label);
        navigateTo('actions', zh ? `删除集群配置: ${node.label}` : `Delete Context: ${node.label}`, 'contextDeletes');
        return;
      case 'extension.vsKubernetesClusterInfo':
        void bridge?.readClusterInfo();
        navigateTo('content', zh ? `集群信息: ${node.label}` : `Cluster Info: ${node.label}`, 'inspections');
        return;
      case 'extension.vsKubernetesDashboard':
        sessionTasks.show('forward');
        execForward.selectTask('preview');
        navigateTo('sessions', zh ? `Dashboard 与转发: ${node.label}` : `Dashboard & Forward: ${node.label}`);
        return;
      case 'extension.vsMinikubeStart':
      case 'extension.vsMinikubeStop':
      case 'extension.vsMinikubeStatus':
        clusterTasks.show('cluster');
        clusterView.selectTask('minikube');
        if (command === 'extension.vsMinikubeStart' || command === 'extension.vsMinikubeStop') clusterView.minikubeAction(command === 'extension.vsMinikubeStart' ? 'start' : 'stop');
        if (command === 'extension.vsMinikubeStatus') void bridge?.minikubeStatus();
        navigateTo('clusterAdmin', `Minikube (${node.label})`);
        return;
      case 'extension.vsKubernetesUseNamespace': {
        const scope = eventScopeFromNode(node);
        const parent = latestTreeSnapshot?.rows.find(candidate => candidate.id === row.parent);
        if (scope?.kind === 'namespace' && !row.stale && !parent?.stale && parent?.entry.query?.kind === 'resources'
          && parent.entry.query.resource === 'namespaces') void bridge?.useNamespace(scope.name, parent.entry.query.target);
        return;
      }
      case 'extension.vsKubernetesShowEvents':
      case 'extension.vsKubernetesFollowEvents': {
        const scope = eventScopeFromNode(node);
        if (scope) {
          void bridge?.readEvents(scope);
          navigateTo('content', zh ? `事件: ${node.label}` : `Events: ${node.label}`, 'events');
        }
        return;
      }
      case 'extension.vsKubernetesLoad':
        if (reference) {
          void bridge?.readDocument(reference, 'yaml');
          navigateTo('content', { action: 'action.load', name: node.label }, 'documents');
        } else if (customRef) {
          void bridge?.readDocument(customRef, 'yaml');
          navigateTo('content', { action: 'action.load', name: node.label }, 'documents');
        }
        return;
      case 'extension.vsKubernetesGet':
        if (node.type === 'folder') {
          const entry = Object.entries(resourceDescriptors).find(([, d]) => d.label === node.label);
          if (entry) {
            selectedResource = entry[0];
            void bridge?.readResource(entry[0]);
            navigateTo('diagnostics', { action: 'action.get', name: node.label });
          } else if (row.entry.query?.kind === 'custom-resources') {
            void bridge?.readCustomResources(row.entry.query.definition);
            navigateTo('content', { action: 'action.get', name: node.label }, 'branches');
          }
          return;
        }
        if (reference) {
          void bridge?.readInspection(reference, 'wide');
          navigateTo('content', `Get Wide: ${node.label}`, 'inspections');
        } else if (customRef) {
          void bridge?.readInspection(customRef, 'wide');
          navigateTo('content', `Get Wide: ${node.label}`, 'inspections');
        }
        return;
      case 'extension.vsKubernetesDescribe':
        if (loadRef) {
          void bridge?.readInspection(loadRef, 'describe');
          navigateTo('content', { action: 'action.describe', name: node.label }, 'inspections');
        }
        return;
      case 'extension.vsKubernetesLogs': {
        const parent = parentFromResource(node);
        if (parent?.resource === 'pods' && parent.namespace) {
          void bridge?.openPodLog({ ...parent, resource: 'pods', namespace: parent.namespace });
          navigateTo('content', { action: 'action.logs', name: node.label }, 'podLogs');
        } else if (parent?.resource === 'jobs' && parent.namespace) {
          void bridge?.openJobLog({ ...parent, resource: 'jobs', namespace: parent.namespace });
          navigateTo('content', `Job Logs: ${node.label}`, 'jobSelections');
        }
        return;
      }
      case 'extension.vsKubernetesTerminal':
        if (reference && reference.type.group === '' && reference.type.resource === 'pods') {
          terminalSession.target(reference, true);
          sessionTasks.show('terminal');
          navigateTo('sessions', { action: 'action.terminal', name: node.label });
        }
        return;
      case 'extension.vsKubernetesPortForward':
        if (reference && latestTreeSnapshot && ['pods', 'services', 'deployments'].includes(reference.type.resource)) {
          execForward.target(row.id, latestTreeSnapshot.generation, reference);
          sessionTasks.show('forward'); execForward.selectTask('forward');
          navigateTo('sessions', `Port Forward: ${node.label}`);
        }
        return;
      case 'extension.vsKubernetesDebugLocalTunnel':
        void bridge?.localTunnelStart();
        clusterTasks.show('cluster'); clusterView.selectTask('debug');
        navigateTo('clusterAdmin', `Local Tunnel: ${node.label}`);
        return;
      case 'extension.vsKubernetesDebugAttach':
        terminalSession.target(reference ?? undefined, true);
        clusterTasks.show('cluster'); clusterView.selectTask('debug');
        navigateTo('clusterAdmin', `Debug: ${node.label}`);
        return;
      case 'extension.vsKubernetesScale':
        if (reference) {
          scale.target(reference);
          navigateTo('actions', `Scale: ${node.label}`, 'scale');
        }
        return;
      case 'extension.vsKubernetesExpose':
        if (reference) {
          expose.target(reference);
          navigateTo('actions', `Expose: ${node.label}`, 'expose');
        }
        return;
      case 'extension.vsKubernetesCronJobRunNow':
        if (reference) {
          cronJobRun.target(reference);
          navigateTo('actions', `Run CronJob: ${node.label}`, 'cronJobRun');
        }
        return;
      case 'extension.vsKubernetesDelete':
      case 'extension.vsKubernetesDeleteNow':
        if (reference) {
          void bridge?.prepareDelete({ reference, mode: command === 'extension.vsKubernetesDeleteNow' ? 'now' : 'standard' });
          navigateTo('actions', `${command === 'extension.vsKubernetesDeleteNow' ? 'Delete Now' : 'Delete'}: ${node.label}`, 'deletes');
        }
        return;
      case 'extension.vsKubernetesAddFile':
        if (reference) {
          configFileAdd.target(reference);
          navigateTo('actions', `Add File: ${node.label}`, 'configFileAdd');
        }
        return;
      case 'extension.vsKubernetesDeleteFile':
        if (node.type === 'config-key' && node.resource?.uid && node.resource?.resourceVersion && node.resource.namespace) {
          configFileDelete.target({
            type: {
              group: '',
              version: 'v1',
              resource: node.resource.resource === 'secrets' ? 'secrets' : 'configmaps',
              kind: node.resource.resource === 'secrets' ? 'Secret' : 'ConfigMap',
              scope: 'namespace',
            },
            namespace: node.resource.namespace,
            name: node.resource.name,
            uid: node.resource.uid,
            resourceVersion: node.resource.resourceVersion,
          });
          navigateTo('actions', `Delete Key: ${node.label}`, 'configFileDelete');
        }
        return;
      case 'openchamber.k8s.openConfigKey':
        if (node.type === 'config-key' && node.key && node.resource?.uid && node.resource?.resourceVersion && node.resource.namespace) {
          void bridge?.readKeyContent({
            parent: {
              resource: node.resource.resource === 'secrets' ? 'secrets' : 'configmaps',
              namespace: node.resource.namespace,
              name: node.resource.name,
              uid: node.resource.uid,
              resourceVersion: node.resource.resourceVersion,
            },
            key: node.key,
          });
          navigateTo('content', `${node.resource.name} / ${node.key}`, 'keyContent');
        }
        return;
      case 'extension.vsKubernetesAddWatch':
        void bridge?.startTreeWatch(row.id);
        navigateTo('content', { action: 'action.watch', name: node.label }, 'watches');
        return;
      case 'extension.vsKubernetesDeleteWatch':
        bridge?.stopWatch();
        return;
      case 'extension.helmConvertToTemplate':
        helmTasks.show('convert');
        navigateTo('helmTools', `Convert to Helm Template: ${node.label}`);
        return;
      case 'extension.helmGet': {
        const ns = node.namespace ?? node.release?.namespace ?? state.config?.currentContextInfo?.namespace ?? 'default';
        const releaseName = node.releaseName ?? node.release?.name ?? node.label;
        void bridge?.readHelmReleaseDetail(ns, releaseName);
        navigateTo('content', `Helm Release: ${releaseName}`, 'helmRelease');
        return;
      }
      case 'extension.helmUninstall':
        if (node.release) {
          const rev = node.release.revisions[0];
          helmRelease.targetAction({
            action: 'uninstall',
            namespace: node.release.namespace,
            release: node.release.name,
            ...(rev?.uid ? { uid: rev.uid } : {}),
            ...(rev?.resourceVersion ? { resourceVersion: rev.resourceVersion } : {}),
          });
          navigateTo('content', `Uninstall Release: ${node.release.name}`, 'helmRelease');
        }
        return;
      case 'extension.helmRollback':
        if (node.revision && node.releaseName && node.namespace) {
          helmRelease.targetAction({
            action: 'rollback',
            namespace: node.namespace,
            release: node.releaseName,
            revision: node.revision.revision,
            uid: node.revision.uid,
            resourceVersion: node.revision.resourceVersion,
          });
          navigateTo('content', `Rollback: ${node.releaseName} r${node.revision.revision}`, 'helmRelease');
        }
        return;
      default:
        return;
    }
  }

  function dispatchHelmRepoCommand(command: ExplorerCommandId, target?: HelmRepoNodeTarget): void {
    const zh = locale.toLowerCase().startsWith('zh');
    if (!target) {
      dispatchTitleCommand(command);
      return;
    }
    switch (command) {
      case 'openchamber.k8s.refreshHelmRepo':
        helmTasks.show('refresh');
        navigateTo('helmTools', zh ? `刷新 Helm 仓库: ${target.node.label}` : `Refresh Helm Repo: ${target.node.label}`);
        return;
      case 'extension.helmInspectChart':
        helmTasks.show('inspect');
        void bridge?.inspectHelmChart(target.chartRef, target.version);
        navigateTo('helmTools', `Inspect Chart: ${target.chartRef}`);
        return;
      case 'extension.helmFetchValues':
        helmTasks.show('values');
        void bridge?.fetchHelmValues(target.chartRef, target.version);
        navigateTo('helmTools', `Fetch Values: ${target.chartRef}`);
        return;
      case 'extension.helmDependencies':
        helmTasks.show('dependencies');
        void bridge?.listHelmDependencies(target.chartRef, target.version);
        navigateTo('helmTools', `Dependencies: ${target.chartRef}`);
        return;
      case 'extension.helmFetch':
        helmTasks.show('fetch');
        navigateTo('helmTools', `Fetch Chart: ${target.chartRef}`);
        return;
      case 'extension.helmInstall':
        helmRelease.targetAction({
          action: 'install',
          chart: target.chartRef,
          ...(target.version ? { version: target.version } : {}),
        });
        navigateTo('content', `Install Chart: ${target.chartRef}`, 'helmRelease');
        return;
      default:
        return;
    }
  }

  const treeView = mountTreeView(
    document,
    clustersTreeMount,
    () => bridge,
    () => locale,
    undefined,
    dispatchNodeCommand,
    () => ({
      configReady: state.phase === 'ready' && !state.stale && state.config?.status === 'ready',
      ...(state.config?.currentContextInfo?.namespace ? { currentNamespace: state.config.currentContextInfo.namespace } : {}),
    }),
  );

  const helmRepoTree = mountHelmRepoTreeView(document, helmReposMount, () => bridge, () => locale, dispatchHelmRepoCommand);

  const select = mountSelect(modeSlot, {
    label: 'Server configuration source (not saved)', value: mode,
    options: [{ id: 'default', label: 'Default' }, { id: 'file', label: 'Single file' }, { id: 'merge', label: 'Ordered file list' }],
    onChange: id => {
      if (id !== 'default' && id !== 'file' && id !== 'merge') return;
      mode = id;
      bridge?.closePreference();
      select.update({ value: id });
      pathsSlot.hidden = mode === 'default';
    },
  });
  const field = mountTextField(pathsSlot, {
    label: 'Absolute Server paths, one per line', value: paths, multiline: true, mono: true,
    onChange: value => { paths = value; bridge?.closePreference(); field.update({ value, error: '' }); },
  });
  pathsSlot.hidden = true;
  const read = mountButton(actions, {
    label: 'Read configuration',
    onClick: () => {
      try {
        const selection = selectionFromLines(mode, paths);
        field.update({ error: '' });
        void bridge?.select(selection);
      } catch {
        field.update({ error: locale.startsWith('zh') ? '请输入单个或有序的绝对 Server 路径，不填写配置正文或凭证。' : 'Enter one or an ordered list of absolute Server paths, not configuration text or credentials.' });
      }
    },
  });
  const next = mountButton(actions, { label: 'Next page', variant: 'outline', disabled: true, onClick: () => { void bridge?.next(); } });
  const cancel = mountButton(actions, { label: 'Stop waiting', variant: 'ghost', onClick: () => bridge?.cancel() });
  const resourceSelect = mountSelect(resourceTypeSlot, {
    label: 'Built-in resource', value: selectedResource,
    options: Object.entries(resourceDescriptors).map(([id, descriptor]) => ({ id, label: descriptor.label })),
    onChange: id => { if (!Object.hasOwn(resourceDescriptors, id)) return; selectedResource = id; resourceSelect.update({ value: id }); bridge?.resetResources(); },
  });
  const resourceRead = mountButton(resourceActions, { label: 'Read resource page', disabled: true, onClick: () => { void bridge?.readResource(selectedResource); } });
  const resourceNext = mountButton(resourceActions, { label: 'Next resource page', variant: 'outline', disabled: true, onClick: () => { void bridge?.nextResource(); } });
  const resourceCancel = mountButton(resourceActions, { label: 'Stop waiting', variant: 'ghost', disabled: true, onClick: () => bridge?.cancelResource() });
  const currentEvents = mountButton(resourceActions, { label: 'Show current namespace events', variant: 'outline', disabled: true, onClick: () => { void bridge?.readEvents(); } });
  const clusterInfo = mountButton(resourceActions, { label: 'Show current Cluster Info', variant: 'outline', disabled: true, onClick: () => { void bridge?.readClusterInfo(); } });
  const watch = mountButton(resourceActions, { label: 'Watch resource directory', variant: 'outline', disabled: true, onClick: () => { const page = resourceState.page; if (page) void bridge?.startWatch(page.resource, page.resourceVersion); } });
  const refreshExplorer = mountButton(resourceActions, { label: 'Refresh Explorer (tree invalidation only)', variant: 'outline', disabled: true, onClick: () => bridge?.refreshExplorer() });
  const messageStatus = document.createElement('p');
  messageStatus.setAttribute('role', 'status');
  messageStatus.style.overflowWrap = 'anywhere';
  resourceSection.append(messageStatus);

  function paintShellHeader(): void {
    paintNamespaceSwitch();
    const zh = locale.toLowerCase().startsWith('zh');
    clustersTitle.textContent = panelText(locale, 'explorer.clusters');
    clustersSection.setAttribute('aria-label', clustersTitle.textContent);
    const currentCtx = state.config?.currentContext;
    const currentNs = state.config?.currentContextInfo?.namespace;
    if (state.phase === 'ready' && contextSwitchStatus.dataset.phase === 'succeeded' && currentCtx === contextSwitchStatus.dataset.context) contextSwitchStatus.hidden = true;
    if (state.phase === 'ready' && state.config?.status === 'ready' && currentCtx) {
      contextPill.hidden = false;
      contextPill.textContent = currentNs ? `${currentCtx} / ${currentNs}` : currentCtx;
    } else {
      contextPill.hidden = true;
      contextPill.textContent = '';
    }

    backButton.textContent = `${panelDirection(locale) === 'rtl' ? '→' : '←'} ${panelText(locale, 'explorer.back')}`;
    subviewHeading.textContent = typeof activeRouteTitle === 'string' ? activeRouteTitle
      : isPanelMessage(activeRouteTitle?.action) && typeof activeRouteTitle.name === 'string'
        ? panelText(locale, 'route.named', panelText(locale, activeRouteTitle.action), activeRouteTitle.name) : '';

    const allTitleActions = localizeExplorerActions(locale, explorerTitleActions({
      view: 'clusters',
      zh,
      hasConfig: state.phase === 'ready' && state.config?.status === 'ready',
      hasActiveContext: !!(state.config?.currentContext && state.config?.currentContextInfo?.available && !state.config?.currentContextMissing),
    }));
    const inlineTitle = allTitleActions.filter(a => a.inline);
    const overflowTitle = allTitleActions.filter(a => !a.inline);

    clustersTitleActions.replaceChildren();
    for (const action of inlineTitle) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'oc-k8s-icon-button';
      btn.setAttribute('aria-label', action.label);
      btn.title = action.disabled && action.disabledReason ? `${action.label} (${action.disabledReason})` : action.label;
      btn.disabled = !!action.disabled;
      if (action.icon) btn.append(createActionSvgIcon(document, action.icon));
      else btn.textContent = action.label;
      btn.addEventListener('click', () => {
        titleMenu.close(false);
        if (!action.disabled) dispatchTitleCommand(action.id);
      });
      clustersTitleActions.append(btn);
    }
    if (overflowTitle.length > 0) {
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'oc-k8s-icon-button';
      moreBtn.setAttribute('aria-haspopup', 'menu');
        moreBtn.setAttribute('aria-label', panelText(locale, 'explorer.actionsFor', clustersTitle.textContent));
      moreBtn.title = panelText(locale, 'explorer.moreActions');
      moreBtn.append(createActionSvgIcon(document, 'more'));
      moreBtn.addEventListener('click', () => {
        titleMenu.open({
          anchor: moreBtn,
          items: overflowTitle,
          targetKey: 'clusters-title',
          onSelect: item => dispatchTitleCommand(item.id),
        });
      });
      clustersTitleActions.append(moreBtn);
    }

    emptyActions.replaceChildren();
    const missingConfig = state.phase === 'ready' && state.config?.status === 'missing';
    const missingCurrent = state.phase === 'ready' && state.config?.currentContextMissing;
    const errorConfig = state.phase === 'error';
    if (missingConfig || errorConfig || missingCurrent) {
      emptyBanner.hidden = false;
      emptyText.textContent = errorConfig
        ? panelText(locale, 'explorer.configError', state.error ?? 'STATE_UNAVAILABLE')
        : missingConfig
          ? panelText(locale, 'config.noKubeconfig')
          : panelText(locale, 'config.missingContext');

      const openSourcesBtn = document.createElement('button');
      openSourcesBtn.type = 'button';
      openSourcesBtn.className = 'oc-k8s-primary-button';
      openSourcesBtn.textContent = panelText(locale, 'action.setKubeconfig');
      openSourcesBtn.addEventListener('click', () => dispatchTitleCommand('extension.vsKubernetesUseKubeconfig'));

      const reloadBtn = document.createElement('button');
      reloadBtn.type = 'button';
      reloadBtn.className = 'oc-k8s-secondary-button';
      reloadBtn.textContent = panelText(locale, 'action.reload');
      reloadBtn.addEventListener('click', () => { void bridge?.reload(); });

      emptyActions.append(openSourcesBtn, reloadBtn);
    } else {
      emptyBanner.hidden = true;
    }
  }

  const paintResources = () => {
    const zh = locale.toLowerCase().startsWith('zh'), loading = resourceState.phase === 'loading';
    const current = state.phase === 'ready' && !state.config?.currentContextMissing && state.config?.currentContextInfo?.available;
    branches.update(!!current);
    keyContent.paint();
    podLogs.paint();
    jobSelections.paint();
    events.paint();
    documents.paint();
    inspections.paint();
    watches.paint();
    deletes.paint();
    namespaces.update(state.phase === 'ready' && state.config?.status === 'ready' && !!state.config.currentContext);
    namespaceDeletes.paint();
    for (const dispose of resourceButtons.splice(0)) dispose();
    resourceSection.setAttribute('aria-label', zh ? '资源读取诊断（非完整资源树）' : 'Resource read diagnostics (not the full resource tree)');
    resourceSection.setAttribute('aria-busy', String(loading));
    resourceNote.textContent = zh ? '显式资源查询：使用所选 kubeconfig 和当前 context/namespace，Server 须已有 kubectl 和 /usr/bin/mkfifo。不设 kubectl 最低或精确版本限制；具体命令能力以实际执行结果为准。exec 认证在实际读取时按需完成，可能刷新云插件自己的凭证缓存，无需另点认证。限时 worker 只接收内存静态凭证。auth-provider 与未知字段仍拒绝。此表不是参考资源树。停止等待不保证宿主代理已中止。'
      : 'Explicit resource query using the selected kubeconfig and current context/namespace. Server requires existing kubectl and /usr/bin/mkfifo. No minimum or exact kubectl version is enforced; command capabilities depend on actual execution. Exec authentication runs on demand for actual reads and may refresh the cloud plugin cache; no separate authentication step. Bounded workers receive static memory credentials only. Auth-provider and unknown fields remain rejected. Not the reference resource tree. Stop waiting does not guarantee host-proxy cancellation.';
    resourceSelect.update({ label: zh ? '内置资源类型' : 'Built-in resource type', disabled: loading });
    resourceRead.update({ label: zh ? '读取资源页' : 'Read resource page', disabled: loading || !current });
    resourceNext.update({ label: zh ? '下一资源页' : 'Next resource page', disabled: resourceState.phase !== 'ready' || !resourceState.page?.nextCursor });
    resourceCancel.update({ label: panelText(locale, 'common.stopWaiting'), disabled: !loading });
    currentEvents.update({ label: zh ? '显示当前 namespace 事件' : 'Show current namespace events', disabled: !current });
    clusterInfo.update({ label: zh ? '显示当前 Cluster Info' : 'Show current Cluster Info', disabled: !current });
    watch.update({ label: zh ? '观察资源目录' : 'Watch resource directory', disabled: !current || resourceState.phase !== 'ready' || resourceState.stale || !resourceState.page });
    refreshExplorer.update({ label: zh ? '刷新Explorer（仅树失效，重读可见展开节点）' : 'Refresh Explorer (tree invalidation only, re-reads visible expanded)', disabled: state.phase !== 'ready' });
    messageStatus.textContent = bridge?.treeMessage() ?? '';
    const stale = resourceState.stale ? (zh ? '（下方为过期结果）' : ' (results below are stale)') : '';
    resourceStatus.textContent = resourceState.phase === 'idle' ? (zh ? '尚未发起资源查询。' : 'No resource query has been started.')
      : loading ? `${zh ? '正在查询服务器资源…' : 'Reading Server resources…'}${stale}`
      : resourceState.phase === 'error' ? `${zh ? '资源读取失败' : 'Resource read failed'}: ${resourceState.error ?? 'STATE_UNAVAILABLE'}${stale}`
      : (zh ? `本页 ${resourceState.page?.nodes.length ?? 0} 项；仅为当前页，不代表集群资源总数。` : `${resourceState.page?.nodes.length ?? 0} items on this page; not a cluster-wide total.`) + stale;
    resourceList.hidden = !resourceState.page;
    resourceCaption.textContent = zh ? '内置资源查询诊断（非资源树）' : 'Built-in resource query diagnostics (not the resource tree)';
    const headings = document.createElement('tr');
    for (const text of zh ? ['资源', '类型', 'Namespace', '子项'] : ['Resource', 'Kind', 'Namespace', 'Children']) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = text; headings.append(cell); }
    resourceHead.replaceChildren(headings);
    resourceBody.replaceChildren(...(resourceState.page?.nodes ?? []).map(node => {
      const row = document.createElement('tr');
      for (const text of [node.label, node.resource.kind, node.resource.namespace ?? '—']) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
      const action = document.createElement('td'); row.append(action);
      if (resourceState.page) resourceButtons.push(mountCopyNameButton(document, action, () => bridge, { kind: 'resource', id: node.id, target: resourceState.page.target }, zh,
        resourceState.phase !== 'ready' || resourceState.stale || !current));
      const documentReference = documentReferenceFromNode(node);
      if (documentReference && resourceState.page) {
        const page = resourceState.page, button = mountButton(action, { label: 'Watch', variant: 'outline', disabled: resourceState.phase !== 'ready' || resourceState.stale || !current,
          onClick: () => { void bridge?.startWatch(page.resource, documentReference.resourceVersion, { name: documentReference.name, uid: documentReference.uid }); } }); resourceButtons.push(() => button.dispose());
      }
      if (documentReference) resourceButtons.push(mountDeleteActions(action, documentReference, () => bridge, zh, resourceState.phase !== 'ready' || resourceState.stale || !current));
      if (documentReference && (documentReference.type.resource === 'configmaps' || documentReference.type.resource === 'secrets')) {
        const button = mountButton(action, { label: zh ? 'Delete File…' : 'Delete File…', variant: 'outline', disabled: resourceState.phase !== 'ready' || resourceState.stale || !current,
          onClick: () => { configFileDelete.target(documentReference); } }); resourceButtons.push(() => button.dispose());
        const add = mountButton(action, { label: zh ? 'Add File…' : 'Add File…', variant: 'outline', disabled: resourceState.phase !== 'ready' || resourceState.stale || !current,
          onClick: () => { configFileAdd.target(documentReference); } }); resourceButtons.push(() => add.dispose());
      }
      if (documentReference && (documentReference.type.resource === 'deployments' || documentReference.type.resource === 'pods' || documentReference.type.resource === 'services')) {
        const button = mountButton(action, { label: zh ? 'Expose…' : 'Expose…', variant: 'outline', disabled: resourceState.phase !== 'ready' || resourceState.stale || !current,
          onClick: () => { expose.target(documentReference); } }); resourceButtons.push(() => button.dispose());
      }
      if (documentReference && documentReference.type.group === 'batch' && documentReference.type.resource === 'cronjobs') {
        const button = mountButton(action, { label: zh ? 'Run Now…' : 'Run Now…', variant: 'outline', disabled: resourceState.phase !== 'ready' || resourceState.stale || !current,
          onClick: () => { cronJobRun.target(documentReference); } }); resourceButtons.push(() => button.dispose());
      }
      if (documentReference && ['deployments', 'replicasets', 'replicationcontrollers', 'statefulsets', 'jobs'].includes(documentReference.type.resource)) {
        const button = mountButton(action, { label: zh ? '缩放…' : 'Scale…', variant: 'outline', disabled: resourceState.phase !== 'ready' || resourceState.stale || !current,
          onClick: () => { scale.target(documentReference); } }); resourceButtons.push(() => button.dispose());
      }
      if (documentReference) for (const format of ['yaml', 'json'] as const) {
        const button = mountButton(action, { label: zh ? `加载 ${format.toUpperCase()}` : `Load ${format.toUpperCase()}`, variant: 'outline', disabled: resourceState.phase !== 'ready' || !current,
          onClick: () => { void bridge?.readDocument(documentReference, format); } }); resourceButtons.push(() => button.dispose());
      }
      if (documentReference) for (const mode of ['wide', 'describe'] as const) {
        const button = mountButton(action, { label: mode === 'wide' ? 'Get wide' : 'Describe', variant: 'outline', disabled: resourceState.phase !== 'ready' || resourceState.stale || !current,
          onClick: () => { void bridge?.readInspection(documentReference, mode); } }); resourceButtons.push(() => button.dispose());
      }
      const eventScope = eventScopeFromNode(node);
      if (eventScope) {
        const sourceTarget = resourceState.page?.target;
        if (eventScope.kind === 'namespace' && sourceTarget && sourceTarget.namespace !== eventScope.name) {
          const use = mountButton(action, { label: panelText(locale, 'action.useNamespace'), variant: 'outline', disabled: resourceState.phase !== 'ready' || resourceState.stale || !current,
            onClick: () => { void bridge?.useNamespace(eventScope.name, sourceTarget); } }); resourceButtons.push(() => use.dispose());
        }
        const button = mountButton(action, { label: zh ? '显示事件' : 'Show events', variant: 'outline', disabled: resourceState.phase !== 'ready' || !current,
          onClick: () => { void bridge?.readEvents(eventScope); } }); resourceButtons.push(() => button.dispose());
      }
      if (node.expandable) {
        const parent = parentFromResource(node);
        const button = mountButton(action, { label: zh ? '读取子项' : 'Read children', variant: 'outline', disabled: !parent || resourceState.phase !== 'ready' || !current,
          onClick: () => { if (parent) void bridge?.readChildren(parent); } }); resourceButtons.push(() => button.dispose());
        if (parent?.resource === 'pods' && parent.namespace) {
          const reference = { ...parent, resource: 'pods' as const, namespace: parent.namespace };
          const logs = mountButton(action, { label: zh ? '打开 Pod 日志' : 'Open Pod logs', variant: 'outline', disabled: resourceState.phase !== 'ready' || !current,
            onClick: () => { void bridge?.openPodLog(reference); } }); resourceButtons.push(() => logs.dispose());
        } else if (parent?.resource === 'jobs') {
          if (parent.namespace) {
            const origin = { ...parent, resource: 'jobs' as const, namespace: parent.namespace };
            const defaults = mountButton(action, { label: zh ? '打开 Job 日志（默认 Pod / 等待）' : 'Open Job logs (default Pod / wait)', variant: 'outline', disabled: resourceState.phase !== 'ready' || resourceState.stale || !current,
              onClick: () => { void bridge?.openJobLog(origin); } }); resourceButtons.push(() => defaults.dispose());
          }
          const logs = mountButton(action, { label: zh ? '选择 Job 日志 Pod' : 'Select Job log Pod', variant: 'outline', disabled: resourceState.phase !== 'ready' || !current,
            onClick: () => { void bridge?.readChildren(parent); } }); resourceButtons.push(() => logs.dispose());
        }
      }
      return row;
    }));
  };

  const paint = () => {
    for (const tasks of [sourceTasks, helmTasks, workspaceTasks, clusterTasks, sessionTasks]) tasks.paint();
    for (const view of [helmVersion, helmRefresh, helmInspect, helmValues, helmDependencies, helmLint, helmTemplate, helmDryRun, helmPackage, helmDepUp, helmCreate, helmFetch, helmRequirement, helmConvert, helmParameterise]) view.paint();
    paintShellHeader();
    helmRepositories.paint();
    helmRepoTree.paint();
    workspace.paint();
    fileSave.paint();
    manifestDiff.paint();
    manifestCreate.paint();
    manifestApply.paint();
    scale.paint();
    cronJobRun.paint();
    applyFile.paint();
    helmRelease.paint();
    imageRun.paint();
    gitSync.paint();
    terminalSession.paint();
    treeView.paint();
    mergeKubeconfig.paint();
    clusterView.paint();
    sessionsView.paint();
    debugControl.paint();
    execForward.paint();
    expose.paint();
    configFileDelete.paint();
    configFileAdd.paint();
    fileDelete.paint();
    requestDiagnostics.paint();
    const zh = locale.toLowerCase().startsWith('zh');
    contexts.paint();
    contextDeletes.paint();
    preferences.paint();
    sourcePicker.paint();
    contextChoices.update(state.phase === 'ready' && state.config?.status === 'ready' && !state.stale);
    for (const dispose of contextButtons.splice(0)) dispose();
    sourceControls.setAttribute('aria-label', panelText(locale, 'config.sources'));
    const loading = state.phase === 'loading';
    sourceControls.setAttribute('aria-busy', String(loading));
    select.update({
      label: zh ? '服务器配置来源（仅当前视图，不保存）' : 'Server source (view only, not saved)', disabled: loading,
      options: [{ id: 'default', label: panelText(locale, 'config.default') }, { id: 'file', label: panelText(locale, 'config.singleFile') }, { id: 'merge', label: panelText(locale, 'config.orderedFiles') }],
    });
    field.update({
      label: zh ? 'Server 绝对路径，每行一个' : 'Absolute Server paths, one per line', disabled: loading,
      helper: zh ? '不展开 ~ 或环境变量；多文件按顺序整条 first-wins，缺失项会披露。' : 'No ~ or environment expansion. Ordered files use first-stanza-wins; missing entries are reported.',
    });
    read.update({ label: panelText(locale, 'config.read'), disabled: loading });
    next.update({ label: panelText(locale, 'common.nextPage'), disabled: state.phase !== 'ready' || !state.config?.nextOffset });
    cancel.update({ label: panelText(locale, 'common.stopWaiting'), disabled: !loading });
    disclosure.textContent = zh ? '读取服务器上的 kubeconfig。默认路径找不到时，请指定文件；资源访问会自动使用其中配置的认证方式，可能运行认证插件。' : 'Read kubeconfig on the Server. Specify a file if the default is missing. Resource access automatically uses its authentication configuration and may run a credential plugin.';
    status.textContent = loading ? (zh ? `正在读取服务器配置…${state.stale ? '（下方是上次读取的过期结果）' : ''}` : `Reading Server configuration…${state.stale ? ' (previous results below are stale)' : ''}`)
      : state.phase === 'error' ? `${zh ? '配置读取失败' : 'Configuration read failed'}: ${state.error ?? 'STATE_UNAVAILABLE'}${state.stale ? (zh ? '（下方为过期结果，不可继续分页）' : ' (results below are stale; paging disabled)') : ''}`
      : state.config?.status === 'missing' ? (zh ? '未发现可读取的 kubeconfig，尚未连接集群。' : 'No kubeconfig files found. Not connected to a cluster.')
      : (zh ? '服务器配置已解析；解析本身未执行认证，显式资源查询状态另见下方。' : 'Server configuration parsed without authentication; explicit resource-query status is shown separately below.');
    const config = state.config;
    const sourceName = config ? { default: zh ? '默认' : 'default', file: zh ? '单文件' : 'single file', merge: zh ? '有序多文件' : 'ordered files' }[config.sources.mode] : '';
    details.textContent = config ? (zh ? `当前来源模式：${sourceName}；当前 context：${config.currentContext || '（未设置）'}；本页 Context ${config.contexts.length} 个，总数 ${config.total}；已读取 ${config.sources.loadedCount}/${config.sources.selectedCount} 个文件，缺失 ${config.sources.missingCount} 个。${config.currentContextMissing ? ' 当前 context 条目缺失。' : ''}`
      : `Active source mode: ${config.sources.mode}; current context: ${config.currentContext || '(unset)'}; contexts on this page ${config.contexts.length}, total ${config.total}; files read ${config.sources.loadedCount}/${config.sources.selectedCount}, missing ${config.sources.missingCount}.${config.currentContextMissing ? ' Current context entry is missing.' : ''}`) : '';
    listSlot.hidden = !config;
    listSlot.setAttribute('aria-busy', String(loading));
    caption.textContent = zh ? 'Context 解析诊断（非资源树）' : 'Context parsing diagnostics (not the resource tree)';
    const headings = document.createElement('tr');
    for (const label of zh ? ['Context', 'Namespace', '认证方式（未执行）', '引用状态', '配置操作'] : ['Context', 'Namespace', 'Authentication (not attempted)', 'References', 'Configuration action']) {
      const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; headings.append(cell);
    }
    head.replaceChildren(headings);
    const rows = (config?.contexts ?? []).map(context => {
      const row = document.createElement('tr');
      for (const text of [`${context.name}${context.active ? (zh ? '（当前）' : ' (current)') : ''}`, context.namespace,
        `${context.authentication.methods.join(', ')}${context.authentication.referencedFiles ? (zh ? '；引用外部文件' : '; references files') : ''}${context.authentication.proxyConfigured ? (zh ? '；配置了代理' : '; proxy configured') : ''}`,
        context.available ? (zh ? '可解析（不代表已连接）' : 'Resolved (not connected)') : (zh ? '引用缺失' : 'Missing reference')]) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      const action = document.createElement('td'); row.append(action);
      if (config) contextButtons.push(mountCopyNameButton(document, action, () => bridge, { kind: 'context', id: context.name, serviceGeneration: config.serviceGeneration, configIdentity: config.configIdentity }, zh,
        state.phase !== 'ready' || state.stale || config.status !== 'ready'));
      const use = mountButton(action, {
        label: zh ? '设为当前Context…' : 'Set as Current Cluster…', variant: 'outline',
        disabled: state.phase !== 'ready' || state.stale || config?.status !== 'ready',
        onClick: () => { void bridge?.prepareContext(context.name); },
      }); contextButtons.push(() => use.dispose());
      const remove = mountButton(action, {
        label: zh ? '从kubeconfig删除…' : 'Delete from kubeconfig…', variant: 'destructive',
        disabled: state.phase !== 'ready' || state.stale || config?.status !== 'ready',
        onClick: () => { void bridge?.prepareContextDelete(context.name); },
      }); contextButtons.push(() => remove.dispose());
      return row;
    });
    body.replaceChildren(...rows);
    scope.textContent = zh ? '此处仅用于诊断；日常浏览请使用资源树。' : 'Diagnostics only; use the resource tree for browsing.';
    paintResources();
  };

  bindScene(workbench, 'shell', () => ({ activeRoute, activeRouteTitle, activePageKey, savedTreeScrollTop, pageScroll: [...pageScroll], mode, paths, selectedResource }), value => {
    mode = value.mode; paths = value.paths; selectedResource = value.selectedResource; savedTreeScrollTop = value.savedTreeScrollTop;
    pageScroll.clear(); for (const [key, position] of value.pageScroll) pageScroll.set(key, position);
    select.update({ value: mode }); field.update({ value: paths }); pathsSlot.hidden = mode === 'default';
    resourceSelect.update({ value: selectedResource });
    const subkey = value.activePageKey.split(':')[1] as keyof typeof contentContainers | keyof typeof actionContainers | undefined;
    navigateTo(value.activeRoute, value.activeRouteTitle, subkey || undefined);
  });
  bridge = mountHostBridge(root, language => {
    if (disposed || locale === language) return;
    locale = language;
    titleMenu.close(false);
    workbenchSplit.setLocale(locale);
    const subviewTop = subviewShell.scrollTop, treeTop = treeView.treeElement.scrollTop;
    paint();
    subviewShell.scrollTop = subviewTop;
    treeView.treeElement.scrollTop = treeTop;
  }, nextState => {
    if (disposed) return;
    state = nextState;
    paint();
  }, () => {
    manifestCreate.resetDraft();
    sourcePicker.reset();
    contextChoices.reset();
    mode = 'default'; paths = '';
    select.update({ value: mode }); field.update({ value: '', error: '' }); pathsSlot.hidden = true;
  }, nextState => { if (disposed) return; resourceState = nextState; paintResources(); },
    nextState => { if (!disposed) branches.show(nextState); },
    nextState => { if (!disposed) keyContent.show(nextState); },
    nextState => { if (!disposed) podLogs.show(nextState); },
    nextState => { if (!disposed) events.show(nextState); },
    nextState => { if (!disposed) documents.show(nextState); },
    nextState => { if (!disposed) deletes.show(nextState); },
    nextState => { if (!disposed) namespaces.show(nextState); },
    nextState => { if (!disposed) namespaceDeletes.show(nextState); },
    nextState => {
      if (disposed) return;
      contexts.show(nextState);
      if (!directContextSwitch) return;
      const outcome = nextState.outcome, zh = locale.toLowerCase().startsWith('zh');
      if (nextState.phase === 'error' || outcome && ['failed', 'unknown', 'cancelled'].includes(outcome.phase)) {
        contextSwitchStatus.dataset.phase = 'error';
        contextSwitchStatus.hidden = false;
        contextSwitchStatus.textContent = `${zh ? '切换未完成，保留原树；请查看原操作结果' : 'Switch not completed; original tree retained. Inspect the original outcome'} (${nextState.error ?? outcome?.code ?? outcome?.phase ?? 'STATE_UNAVAILABLE'})`;
      } else if (outcome?.phase === 'succeeded') {
        contextSwitchStatus.dataset.phase = 'succeeded';
        contextSwitchStatus.hidden = false;
        contextSwitchStatus.textContent = zh ? `已切换到 ${outcome.context}，正在刷新资源树…` : `Switched to ${outcome.context}; refreshing the tree…`;
      }
    },
    nextState => { if (!disposed) preferences.show(nextState); },
    selection => {
      if (disposed) return; mode = selection.mode; paths = selection.mode === 'file' ? selection.path : selection.mode === 'merge' ? selection.paths.join('\n') : '';
      select.update({ value: mode }); field.update({ value: paths, error: '' }); pathsSlot.hidden = mode === 'default';
    },
    nextState => { if (!disposed) contextDeletes.show(nextState); },
    nextState => { if (!disposed) sourcePicker.show(nextState); },
    (path, append) => {
      if (disposed) return;
      try {
        const selection = pickedSource(append ? selectionFromLines(mode, paths) : { mode: 'default' }, path, append);
        mode = selection.mode; paths = selection.mode === 'file' ? selection.path : selection.mode === 'merge' ? selection.paths.join('\n') : '';
        select.update({ value: mode }); field.update({ value: paths, error: '' }); pathsSlot.hidden = false;
      } catch { field.update({ error: 'INVALID_INPUT' }); }
    },
    nextState => { if (!disposed) contextChoices.show(nextState); },
    nextState => { if (!disposed) inspections.show(nextState); },
    nextState => { if (!disposed) documents.showExplanation(nextState); },
    nextState => { if (!disposed) watches.show(nextState); },
    nextState => { if (!disposed) podLogs.showFollow(nextState); },
    nextState => { if (!disposed) events.showFollow(nextState); },
    nextState => { if (!disposed) jobSelections.show(nextState); },
    nextState => { if (!disposed) podLogs.showPreferences(nextState); });

  stopHelmRepositories = bridge.onHelmRepositories(nextState => { if (!disposed) { helmRepositories.update(nextState); helmRepoTree.update(nextState); } });
  const stopWorkspaceResults = bridge.onWorkspaceResult((method, value) => {
    if (disposed) return;
    if (method === 'sessionsOverview') sessionsView.show(value as Parameters<typeof sessionsView.show>[0]);
    if (method === 'stopGateStatus') {
      if (value && typeof value === 'object' && 'error' in value) sessionsView.gateError(String(value.error));
      else sessionsView.setGate(value as Parameters<typeof sessionsView.setGate>[0]);
    }
    if (method === 'readRequestDiagnostics') requestDiagnostics.show(value);
    if (method === 'compareFileConflict') fileSave.showComparison(value as Parameters<typeof fileSave.showComparison>[0]);
    if (['localTunnelStart', 'clusterProviders', 'minikubeConfigView', 'telepresenceStatus'].includes(method)) clusterView.providerResult(method, value);
  });
  const stopHelmVersionView = bridge.onHelmVersion(nextState => { if (!disposed) helmVersion.show(nextState); });
  const stopHelmRefreshView = bridge.onHelmRefresh(nextState => { if (!disposed) helmRefresh.show(nextState); });
  const stopHelmInspectView = bridge.onHelmInspect(nextState => { if (!disposed) helmInspect.show(nextState); });
  const stopHelmValuesView = bridge.onHelmValues(nextState => { if (!disposed) helmValues.show(nextState); });
  const stopHelmDependenciesView = bridge.onHelmDependencies(nextState => { if (!disposed) helmDependencies.show(nextState); });
  const stopHelmLintView = bridge.onHelmLint(nextState => { if (!disposed) helmLint.show(nextState); });
  const stopHelmTemplateView = bridge.onHelmTemplate(nextState => { if (!disposed) helmTemplate.show(nextState); });
  const stopHelmDryRunView = bridge.onHelmDryRun(nextState => { if (!disposed) helmDryRun.show(nextState); });
  const stopHelmPackageView = bridge.onHelmPackage(nextState => { if (!disposed) helmPackage.show(nextState); });
  const stopHelmDepUpView = bridge.onHelmDepUp(nextState => { if (!disposed) helmDepUp.show(nextState); });
  const stopHelmCreateView = bridge.onHelmCreate(nextState => { if (!disposed) helmCreate.show(nextState); });
  const stopHelmFetchView = bridge.onHelmFetch(nextState => { if (!disposed) helmFetch.show(nextState); });
  const stopHelmRequirementView = bridge.onHelmRequirement(nextState => { if (!disposed) helmRequirement.show(nextState); });
  const stopHelmConvertView = bridge.onHelmConvert(nextState => { if (!disposed) helmConvert.show(nextState); });
  const stopHelmParameteriseView = bridge.onHelmParameterise(nextState => { if (!disposed) helmParameterise.show(nextState); });
  stopWorkspace = bridge.onWorkspace(nextState => { if (!disposed) workspace.show(nextState); });
  stopFileSave = bridge.onFileSave(nextState => { if (!disposed) fileSave.show(nextState); });
  stopManifestDiff = bridge.onManifestDiff(nextState => { if (!disposed) manifestDiff.show(nextState); });
  stopManifestCreate = bridge.onManifestCreate(nextState => { if (!disposed) manifestCreate.show(nextState); });
  stopManifestApply = bridge.onManifestApply(nextState => { if (!disposed) manifestApply.show(nextState); });
  stopScale = bridge.onScale(nextState => { if (!disposed) scale.show(nextState); });
  stopCronJobRun = bridge.onCronJobRun(nextState => { if (!disposed) cronJobRun.show(nextState); });
  stopApplyFile = bridge.onApplyFile(nextState => { if (!disposed) applyFile.show(nextState); });
  stopHelmRelease = bridge.onHelmRelease(nextState => { if (!disposed) helmRelease.show(nextState); });
  stopImageRun = bridge.onImageRun(nextState => { if (!disposed) imageRun.show(nextState); });
  stopGitSync = bridge.onGitSync(nextState => { if (!disposed) gitSync.show(nextState); });
  stopSession = bridge.onSession(nextState => { if (!disposed) { terminalSession.show(nextState); execForward.show(nextState); sessionsView.owned(nextState); } });
  const stopSessionTarget = bridge.onSessionTarget(nextState => {
    if (disposed) return;
    terminalSession.showTarget(nextState); execForward.showTarget(nextState); clusterView.paint();
  });
  const stopNamespaceSwitch = bridge.onNamespaceSwitch(next => { if (!disposed) { namespaceSwitch = next; paintNamespaceSwitch(); } });
  stopTree = bridge.onTree(nextSnapshot => { if (!disposed) { latestTreeSnapshot = nextSnapshot; treeView.show(nextSnapshot); } });
  stopHelmWrite = bridge.onHelmWrite(nextState => { if (!disposed) helmRelease.showWrite(nextState); });
  stopMergeKubeconfig = bridge.onMergeKubeconfig(nextState => { if (!disposed) mergeKubeconfig.show(nextState); });
  stopCluster = bridge.onCluster(nextState => { if (!disposed) { clusterView.show(nextState); if (nextState.debugMessages) debugControl.show({ messages: nextState.debugMessages }); } });
  const stopWorkspaceSelectors = bridge.onWorkspaceSelectors(() => {
    if (disposed) return;
    terminalSession.paint(); execForward.paint(); fileSave.paint(); manifestCreate.paint(); workspace.paint();
  });
  stopExpose = bridge.onExpose(nextState => { if (!disposed) expose.show(nextState); });
  stopConfigFileDelete = bridge.onConfigFileDelete(nextState => { if (!disposed) configFileDelete.show(nextState); });
  stopConfigFileAdd = bridge.onConfigFileAdd(nextState => { if (!disposed) configFileAdd.show(nextState); });
  stopFileDelete = bridge.onFileDelete(nextState => { if (!disposed) fileDelete.show(nextState); });

  paint();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    bridge?.dispose(); // Capture the final scene before bindings/DOM are destroyed.
    stopWorkspaceResults();
    stopSessionTarget();
    stopNamespaceSwitch();
    stopWorkspaceSelectors();
    workbenchSplit.dispose();
    disposeScene(document);
    titleMenu.dispose();
    helmRepoTree.dispose();
    requestDiagnostics.dispose();
    stopHelmRepositories(); helmRepositories.dispose();
    stopHelmVersionView(); helmVersion.dispose();
    stopHelmRefreshView(); helmRefresh.dispose();
    stopHelmInspectView(); helmInspect.dispose();
    stopHelmValuesView(); helmValues.dispose();
    stopHelmDependenciesView(); helmDependencies.dispose();
    stopHelmLintView(); helmLint.dispose();
    stopHelmTemplateView(); helmTemplate.dispose();
    stopHelmDryRunView(); helmDryRun.dispose();
    stopHelmPackageView(); helmPackage.dispose();
    stopHelmDepUpView(); helmDepUp.dispose();
    stopHelmCreateView(); helmCreate.dispose();
    stopHelmFetchView(); helmFetch.dispose();
    stopHelmRequirementView(); helmRequirement.dispose();
    stopHelmConvertView(); helmConvert.dispose();
    stopHelmParameteriseView(); helmParameterise.dispose();
    stopWorkspace(); workspace.dispose();
    stopFileSave(); fileSave.dispose();
    stopManifestDiff(); manifestDiff.dispose();
    stopManifestCreate(); manifestCreate.dispose();
    stopManifestApply(); manifestApply.dispose();
    stopScale(); scale.dispose();
    stopCronJobRun(); cronJobRun.dispose();
    stopApplyFile(); applyFile.dispose();
    stopHelmRelease(); helmRelease.dispose();
    stopImageRun(); imageRun.dispose();
    stopGitSync(); gitSync.dispose();
    stopSession(); terminalSession.dispose(); execForward.dispose();
    stopTree(); treeView.dispose();
    stopHelmWrite();
    stopMergeKubeconfig(); mergeKubeconfig.dispose();
    stopCluster(); clusterView.dispose();
    sessionsView.dispose(); debugControl.dispose();
    stopExpose(); expose.dispose();
    stopConfigFileDelete(); configFileDelete.dispose();
    stopConfigFileAdd(); configFileAdd.dispose();
    stopFileDelete(); fileDelete.dispose();
    document.defaultView?.removeEventListener('pagehide', dispose);
    select.dispose(); field.dispose(); read.dispose(); next.dispose(); cancel.dispose();
    resourceSelect.dispose(); resourceRead.dispose(); resourceNext.dispose(); resourceCancel.dispose(); currentEvents.dispose(); clusterInfo.dispose(); watch.dispose(); watches.dispose(); refreshExplorer.dispose();
    contextChoices.dispose(); sourcePicker.dispose(); contextDeletes.dispose(); preferences.dispose(); contexts.dispose(); for (const disposeFn of contextButtons.splice(0)) disposeFn();
    jobSelections.dispose(); inspections.dispose(); namespaceDeletes.dispose(); namespaces.dispose(); deletes.dispose(); documents.dispose(); events.dispose(); podLogs.dispose(); keyContent.dispose(); branches.dispose(); for (const disposeFn of resourceButtons.splice(0)) disposeFn();
    paths = '';
    pageScroll.clear();
    for (const tasks of [sourceTasks, helmTasks, workspaceTasks, clusterTasks, sessionTasks]) tasks.dispose();
    root.replaceChildren();
  };
  document.defaultView?.addEventListener('pagehide', dispose, { once: true });
  return dispose;
}
