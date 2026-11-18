import type { ResourceIdentity, ResourceType, TargetIdentity } from './identity.ts';
import type { HelmReleaseEntry, HelmReleaseRevisionView } from './helm-release-protocol.ts';
import { stableNodeId } from './identity.ts';

export type TreeIcon = 'kubernetes' | 'aks' | 'minikube' | 'pod-running' | 'pod-not-ready' | 'pod-completed' | 'pod-error' | 'helm-repo' | 'helm-deployed' | 'helm-failed'
  | 'workload-ready' | 'workload-progressing' | 'workload-error' | 'workload-paused';
export type ResourceChildren = 'none' | 'pods-on-node' | 'selected-pods' | 'pod-info' | 'config-keys';
export type TreeNode = {
  readonly id: string;
  readonly type: 'context' | 'folder' | 'resource' | 'config-key' | 'info' | 'message' | 'release' | 'revision' | 'repo' | 'chart' | 'chart-version';
  readonly label: string;
  readonly expandable: boolean;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon?: TreeIcon;
  readonly resource?: ResourceIdentity;
  readonly forwardPorts?: readonly number[];
  readonly key?: string;
  readonly children?: ResourceChildren;
  readonly release?: HelmReleaseEntry;
  readonly revision?: HelmReleaseRevisionView;
  readonly releaseName?: string;
  readonly namespace?: string;
  readonly partial?: boolean;
};
export type ResourceDescriptor = ResourceType & { readonly label: string; readonly children: ResourceChildren };

function resource(label: string, kind: string, plural: string, group = '', scope: 'cluster' | 'namespace' = 'namespace', children: ResourceChildren = 'none'): ResourceDescriptor {
  return Object.freeze({ label, kind, resource: plural, group, version: 'v1', scope, children });
}
export const resourceDescriptors = Object.freeze({
  namespaces: resource('Namespaces', 'Namespace', 'namespaces', '', 'cluster'),
  nodes: resource('Nodes', 'Node', 'nodes', '', 'cluster', 'pods-on-node'),
  deployments: resource('Deployments', 'Deployment', 'deployments', 'apps', 'namespace', 'selected-pods'),
  statefulsets: resource('StatefulSets', 'StatefulSet', 'statefulsets', 'apps', 'namespace', 'selected-pods'),
  daemonsets: resource('DaemonSets', 'DaemonSet', 'daemonsets', 'apps', 'namespace', 'selected-pods'),
  jobs: resource('Jobs', 'Job', 'jobs', 'batch', 'namespace', 'selected-pods'),
  cronjobs: resource('CronJobs', 'CronJob', 'cronjobs', 'batch'),
  pods: resource('Pods', 'Pod', 'pods', '', 'namespace', 'pod-info'),
  services: resource('Services', 'Service', 'services', '', 'namespace', 'selected-pods'),
  endpoints: resource('Endpoints', 'Endpoints', 'endpoints'),
  ingresses: resource('Ingress', 'Ingress', 'ingresses', 'networking.k8s.io'),
  persistentvolumes: resource('Persistent Volumes', 'PersistentVolume', 'persistentvolumes', '', 'cluster'),
  persistentvolumeclaims: resource('Persistent Volume Claims', 'PersistentVolumeClaim', 'persistentvolumeclaims'),
  storageclasses: resource('Storage Classes', 'StorageClass', 'storageclasses', 'storage.k8s.io', 'cluster'),
  configmaps: resource('Config Maps', 'ConfigMap', 'configmaps', '', 'namespace', 'config-keys'),
  secrets: resource('Secrets', 'Secret', 'secrets', '', 'namespace', 'config-keys'),
});
export type ResourceKey = keyof typeof resourceDescriptors;
export type FolderDescriptor = { readonly label: string; readonly resources?: readonly ResourceKey[]; readonly resource?: ResourceKey; readonly dependency?: 'helm' | 'discovery' };
const folderDefinitions: readonly FolderDescriptor[] = [
  { label: 'Namespaces', resource: 'namespaces' },
  { label: 'Nodes', resource: 'nodes' },
  { label: 'Workloads', resources: Object.freeze(['deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'pods'] as const) },
  { label: 'Network', resources: Object.freeze(['services', 'endpoints', 'ingresses'] as const) },
  { label: 'Storage', resources: Object.freeze(['persistentvolumes', 'persistentvolumeclaims', 'storageclasses'] as const) },
  { label: 'Configuration', resources: Object.freeze(['configmaps', 'secrets'] as const) },
  { label: 'Custom Resources', dependency: 'discovery' },
  { label: 'Helm Releases', dependency: 'helm' },
];
export const contextFolders: readonly FolderDescriptor[] = Object.freeze(folderDefinitions.map(folder => Object.freeze(folder)));

export function contextChildren(target: TargetIdentity, active: boolean): readonly TreeNode[] {
  if (!active) return [];
  return contextFolders.map(folder => ({ type: 'folder', id: stableNodeId(target, 'folder', folder.label), label: folder.label, expandable: true }));
}

export function groupingChildren(target: TargetIdentity, label: string): readonly TreeNode[] {
  const group = contextFolders.find(folder => folder.label === label);
  return (group?.resources ?? []).map(key => ({ type: 'folder', id: stableNodeId(target, 'resource-folder', key), label: resourceDescriptors[key].label, expandable: true }));
}
