import type { ExplorerActionItem, ExplorerCommandId } from '../shared/explorer-actions.ts';
import type { TreeEntry } from '../shared/tree-entries.ts';
import { panelText } from './i18n.ts';
import type { PanelLocale, PanelMessage } from './i18n.ts';

const groups: ReadonlyMap<string, PanelMessage> = new Map([
  ['Workloads', 'folder.workloads'], ['Network', 'folder.network'],
  ['Storage', 'folder.storage'], ['Configuration', 'folder.configuration'],
]);
const resources: ReadonlyMap<string, PanelMessage> = new Map([
  ['namespaces', 'folder.namespaces'], ['nodes', 'folder.nodes'],
]);

// Match the trusted folder kind/descriptor, never a resource/CRD/user name.
export function explorerLabel(locale: PanelLocale, { query, node }: TreeEntry): string {
  if (node.type !== 'folder' || !query) return node.label;
  const message = query.kind === 'group' ? groups.get(query.label)
    : query.kind === 'resources' ? resources.get(query.resource)
      : query.kind === 'custom-types' ? 'folder.custom'
        : query.kind === 'helm-releases' || query.kind === 'helm-dependency' ? 'folder.helmReleases'
          : undefined;
  return message ? panelText(locale, message) : node.label;
}

const actions: Readonly<Partial<Record<ExplorerCommandId, PanelMessage>>> = {
  'extension.vsKubernetesRefreshExplorer': 'action.refresh',
  'extension.vsKubernetesRefreshHelmRepoExplorer': 'helm.refreshRepositories',
  'openchamber.k8s.refreshBranch': 'action.refresh',
  'openchamber.k8s.collapseAll': 'action.collapseAll',
  'extension.vsKubernetesUseKubeconfig': 'action.setKubeconfig',
  'extension.vsKubernetesCreateCluster': 'action.createCluster',
  'extension.vsKubernetesConfigureFromCluster': 'action.addCluster',
  'extension.vsKubernetesCopy': 'action.copyName',
  'extension.vsKubernetesDelete': 'action.delete',
  'extension.vsKubernetesDeleteNow': 'action.deleteNow',
  'extension.vsKubernetesGet': 'action.get',
  'extension.vsKubernetesLoad': 'action.load',
  'extension.vsKubernetesDescribe': 'action.describe',
  'extension.vsKubernetesLogs': 'action.logs',
  'extension.vsKubernetesTerminal': 'action.terminal',
  'extension.vsKubernetesPortForward': 'action.forward',
  'extension.vsKubernetesAddWatch': 'action.watch',
  'extension.vsKubernetesDeleteWatch': 'action.stopWatch',
  'extension.vsKubernetesShowEvents': 'action.showEvents',
  'extension.vsKubernetesUseNamespace': 'action.useNamespace',
  'extension.vsKubernetesUseContext': 'action.activeContext',
  'extension.vsKubernetesClusterInfo': 'action.clusterInfo',
  'extension.vsKubernetesDashboard': 'action.dashboard',
  'extension.vsKubernetesDeleteContext': 'action.deleteContext',
  'extension.vsKubernetesFollowEvents': 'action.followEvents',
  'extension.vsKubernetesScale': 'action.scale',
  'extension.vsKubernetesExpose': 'action.expose',
  'extension.vsKubernetesCronJobRunNow': 'action.runCronJob',
  'extension.vsKubernetesAddFile': 'action.addFile',
  'extension.vsKubernetesDeleteFile': 'action.deleteFile',
  'openchamber.k8s.openSources': 'action.openSources',
  'openchamber.k8s.openWorkspace': 'action.openWorkspace',
  'openchamber.k8s.openClusterAdmin': 'action.openClusterTools',
  'openchamber.k8s.openSessions': 'action.openSessions',
  'openchamber.k8s.openDiagnostics': 'action.openDiagnostics',
  'openchamber.k8s.openRequestDiagnostics': 'action.openRequestDiagnostics',
  'openchamber.k8s.openHelmTools': 'action.openHelmTools',
  'openchamber.k8s.openPreferences': 'action.preferences',
};

export function localizeExplorerActions(locale: PanelLocale, items: readonly ExplorerActionItem[]): readonly ExplorerActionItem[] {
  return items.map(item => {
    const key = actions[item.id];
    return key ? { ...item, label: panelText(locale, key) } : item;
  });
}
