import type { TreeNode } from './tree.ts';

export type ExplorerCommandId =
  | 'extension.vsKubernetesRefreshExplorer'
  | 'extension.vsKubernetesRefreshHelmRepoExplorer'
  | 'extension.vsKubernetesUseKubeconfig'
  | 'extension.vsKubernetesCreateCluster'
  | 'extension.vsKubernetesConfigureFromCluster'
  | 'extension.vsKubernetesUseContext'
  | 'extension.vsKubernetesDeleteContext'
  | 'extension.vsKubernetesClusterInfo'
  | 'extension.vsKubernetesDashboard'
  | 'extension.vsMinikubeStart'
  | 'extension.vsMinikubeStop'
  | 'extension.vsMinikubeStatus'
  | 'extension.vsKubernetesUseNamespace'
  | 'extension.vsKubernetesShowEvents'
  | 'extension.vsKubernetesFollowEvents'
  | 'extension.vsKubernetesCopy'
  | 'extension.vsKubernetesGet'
  | 'extension.vsKubernetesAddWatch'
  | 'extension.vsKubernetesDeleteWatch'
  | 'extension.vsKubernetesLoad'
  | 'extension.vsKubernetesDescribe'
  | 'extension.vsKubernetesDelete'
  | 'extension.vsKubernetesDeleteNow'
  | 'extension.vsKubernetesTerminal'
  | 'extension.vsKubernetesDebugAttach'
  | 'extension.vsKubernetesDebugLocalTunnel'
  | 'extension.vsKubernetesPortForward'
  | 'extension.vsKubernetesScale'
  | 'extension.vsKubernetesExpose'
  | 'extension.vsKubernetesLogs'
  | 'extension.vsKubernetesCronJobRunNow'
  | 'extension.vsKubernetesAddFile'
  | 'extension.vsKubernetesDeleteFile'
  | 'extension.helmConvertToTemplate'
  | 'extension.helmGet'
  | 'extension.helmUninstall'
  | 'extension.helmRollback'
  | 'extension.helmInspectChart'
  | 'extension.helmFetchValues'
  | 'extension.helmDependencies'
  | 'extension.helmFetch'
  | 'extension.helmInstall'
  | 'openchamber.k8s.collapseAll'
  | 'openchamber.k8s.refreshBranch'
  | 'openchamber.k8s.openConfigKey'
  | 'openchamber.k8s.showMessage'
  | 'openchamber.k8s.openSources'
  | 'openchamber.k8s.openWorkspace'
  | 'openchamber.k8s.openClusterAdmin'
  | 'openchamber.k8s.openSessions'
  | 'openchamber.k8s.openPreferences'
  | 'openchamber.k8s.openDiagnostics'
  | 'openchamber.k8s.openRequestDiagnostics'
  | 'openchamber.k8s.openHelmTools'
  | 'openchamber.k8s.refreshHelmRepo';

export type ExplorerActionIcon =
  | 'describe'
  | 'logs'
  | 'terminal'
  | 'refresh'
  | 'collapse-all'
  | 'kubeconfig'
  | 'more';

export type ExplorerActionItem = {
  readonly id: ExplorerCommandId;
  readonly label: string;
  readonly group: string;
  readonly majorGroup: string;
  readonly order: number;
  readonly inline: boolean;
  readonly icon?: ExplorerActionIcon;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly mutating?: boolean;
};

export type ExplorerTitleContext = {
  readonly view: 'clusters' | 'helm-repos';
  readonly zh: boolean;
  readonly hasConfig: boolean;
  readonly hasActiveContext: boolean;
  readonly hasHelmRepos?: boolean;
};

export type ExplorerNodeContext = {
  readonly node: TreeNode;
  readonly zh: boolean;
  readonly stale: boolean;
  readonly configReady: boolean;
  readonly hasActiveContext: boolean;
  readonly currentNamespace?: string;
  readonly activeWatchResource?: string;
  readonly isCustomResource?: boolean;
};

const watchableResources = new Set([
  'Namespaces',
  'Nodes',
  'Deployments',
  'StatefulSets',
  'DaemonSets',
  'Jobs',
  'CronJobs',
  'Pods',
  'Services',
  'Endpoints',
  'Ingress',
  'Persistent Volumes',
  'Persistent Volume Claims',
  'Storage Classes',
  'Config Maps',
  'Secrets',
]);

const scaleResources = new Set(['deployments', 'jobs', 'replicationcontrollers', 'replicasets', 'statefulsets']);
const portForwardResources = new Set(['pods', 'services', 'deployments']);
const localTunnelResources = new Set(['pods', 'jobs', 'services', 'deployments']);
const exposeResources = new Set(['deployments', 'pods', 'services']);

function parseGroupSort(group: string): { major: string; order: number } {
  const [major = '9', minor = '0'] = group.split('@');
  const parsed = Number.parseInt(minor, 10);
  return { major, order: Number.isFinite(parsed) ? parsed : 0 };
}

function sortActions(items: ExplorerActionItem[]): readonly ExplorerActionItem[] {
  return Object.freeze(
    [...items].sort((a, b) => {
      const majorCompare = a.majorGroup.localeCompare(b.majorGroup, 'en');
      if (majorCompare !== 0) return majorCompare;
      if (a.order !== b.order) return a.order - b.order;
      return a.label.localeCompare(b.label, 'en');
    }),
  );
}

function makeItem(
  id: ExplorerCommandId,
  label: string,
  group: string,
  options: {
    readonly inline?: boolean;
    readonly icon?: ExplorerActionIcon | undefined;
    readonly destructive?: boolean;
    readonly disabled?: boolean;
    readonly disabledReason?: string | undefined;
    readonly mutating?: boolean;
  } = {},
): ExplorerActionItem {
  const { major, order } = parseGroupSort(group);
  return Object.freeze({
    id,
    label,
    group,
    majorGroup: major,
    order,
    inline: options.inline ?? false,
    ...(options.icon !== undefined ? { icon: options.icon } : {}),
    ...(options.destructive !== undefined ? { destructive: options.destructive } : {}),
    ...(options.disabled !== undefined ? { disabled: options.disabled } : {}),
    ...(options.disabledReason !== undefined ? { disabledReason: options.disabledReason } : {}),
    ...(options.mutating !== undefined ? { mutating: options.mutating } : {}),
  });
}

// Pure view/title actions (Clusters & Helm Repos headers). Never reads or probes the cluster.
export function explorerTitleActions(context: ExplorerTitleContext): readonly ExplorerActionItem[] {
  const { zh } = context;
  if (context.view === 'helm-repos') {
    return sortActions([
      makeItem('extension.vsKubernetesRefreshHelmRepoExplorer', zh ? '刷新 Helm 仓库索引' : 'Refresh Helm Repos', 'navigation', {
        inline: true,
        icon: 'refresh',
      }),
      makeItem('openchamber.k8s.openHelmTools', zh ? 'Helm 工具与版本…' : 'Helm Tools & Version…', '1@1'),
      makeItem('openchamber.k8s.openRequestDiagnostics', zh ? '请求预算与诊断…' : 'Request Budget & Diagnostics…', '2@1'),
    ]);
  }
  return sortActions([
    makeItem('extension.vsKubernetesRefreshExplorer', zh ? '刷新' : 'Refresh', 'navigation@1', {
      inline: true,
      icon: 'refresh',
      disabled: !context.hasConfig,
      ...(context.hasConfig ? {} : { disabledReason: zh ? '未加载配置' : 'No configuration loaded' }),
    }),
    makeItem('openchamber.k8s.collapseAll', zh ? '全部折叠' : 'Collapse All', 'navigation@2', {
      inline: true,
      icon: 'collapse-all',
      disabled: !context.hasConfig,
      ...(context.hasConfig ? {} : { disabledReason: zh ? '未加载配置' : 'No configuration loaded' }),
    }),
    makeItem('extension.vsKubernetesUseKubeconfig', zh ? '切换 / 选择 Kubeconfig…' : 'Set Kubeconfig…', '1@1', {
      inline: true,
      icon: 'kubeconfig',
    }),
    makeItem('extension.vsKubernetesCreateCluster', zh ? '创建集群…' : 'Create Cluster…', '0@1', { mutating: true }),
    makeItem('extension.vsKubernetesConfigureFromCluster', zh ? '从已有集群配置…' : 'Add Existing Cluster…', '0@2', { mutating: true }),
    makeItem('openchamber.k8s.openSources', zh ? '配置来源与上下文管理…' : 'Configuration Sources & Contexts…', '1@2'),
    makeItem('openchamber.k8s.openWorkspace', zh ? 'Manifest 文件（Apply / Diff / Create）…' : 'Manifest Files (Apply / Diff / Create)…', '2@1'),
    makeItem('openchamber.k8s.openClusterAdmin', zh ? 'Kubeconfig 合并 / 镜像运行 / Git 同步…' : 'Merge Kubeconfig / Image Run / Git Sync…', '2@2'),
    makeItem('openchamber.k8s.openSessions', zh ? '运行中会话与调试（Sessions / Debug）…' : 'Active Sessions & Debug…', '3@1'),
    makeItem('openchamber.k8s.openPreferences', zh ? '偏好设置…' : 'Preferences…', '4@1'),
    makeItem('openchamber.k8s.openRequestDiagnostics', zh ? '请求预算与诊断…' : 'Request Budget & Diagnostics…', '4@2'),
    makeItem('openchamber.k8s.openDiagnostics', zh ? '分支与兼容诊断抽屉…' : 'Branch & Compatibility Diagnostics…', '4@3'),
  ]);
}

// Pure view/item/context & inline action evaluator. Aligned with VS Code Kubernetes 1.4.1
// (`f54aef89a48c64e3df66af4a75cc5dd3d80f4a75`) without RBAC/container/port pre-probing.
export function explorerNodeActions(context: ExplorerNodeContext): readonly ExplorerActionItem[] {
  const { node, zh, stale, configReady } = context;
  const unavailableReason = !configReady
    ? (zh ? '配置未就绪' : 'Configuration not ready')
    : stale
      ? (zh ? '节点已过期，请刷新' : 'Node stale; refresh first')
      : undefined;
  const items: ExplorerActionItem[] = [];

  if (node.type === 'context') {
    const active = node.expandable;
    if (!active) {
      items.push(makeItem('extension.vsKubernetesUseContext', zh ? '设为当前集群' : 'Set as Current Cluster', '0@1', {
        mutating: true,
        disabled: !configReady,
        ...(configReady ? {} : { disabledReason: unavailableReason }),
      }));
    } else {
      items.push(makeItem('extension.vsKubernetesClusterInfo', zh ? '显示集群信息 (Cluster Info)' : 'Show Cluster Info', '0@1', {
        disabled: !configReady,
        ...(configReady ? {} : { disabledReason: unavailableReason }),
      }));
      items.push(makeItem('extension.vsKubernetesDashboard', zh ? '打开 Dashboard…' : 'Open Dashboard…', '0@3', {
        disabled: !configReady,
        ...(configReady ? {} : { disabledReason: unavailableReason }),
      }));
      if (node.icon === 'minikube' || node.label === 'minikube') {
        items.push(makeItem('extension.vsMinikubeStart', 'Minikube Start…', '2@0', { mutating: true }));
        items.push(makeItem('extension.vsMinikubeStop', 'Minikube Stop…', '2@1', { mutating: true }));
        items.push(makeItem('extension.vsMinikubeStatus', 'Minikube Status', '2@3'));
      }
    }
    items.push(makeItem('extension.vsKubernetesDeleteContext', zh ? '从 kubeconfig 删除…' : 'Delete from kubeconfig…', '0@2', {
      destructive: true,
      mutating: true,
      disabled: !configReady,
      ...(configReady ? {} : { disabledReason: unavailableReason }),
    }));
    items.push(makeItem('extension.vsKubernetesCopy', zh ? '复制名称' : 'Copy Name', '1@1', {
      disabled: !configReady,
      ...(configReady ? {} : { disabledReason: unavailableReason }),
    }));
    return sortActions(items);
  }

  if (node.type === 'folder') {
    items.push(makeItem('openchamber.k8s.refreshBranch', zh ? '刷新分支' : 'Refresh', '0@1', {
      disabled: !configReady,
      ...(configReady ? {} : { disabledReason: unavailableReason }),
    }));
    if (watchableResources.has(node.label)) {
      items.push(makeItem('extension.vsKubernetesGet', zh ? '获取列表 (Get)' : 'Get', '1@1', {
        disabled: !configReady,
        ...(configReady ? {} : { disabledReason: unavailableReason }),
      }));
      items.push(makeItem('extension.vsKubernetesAddWatch', zh ? '开始观察 (Watch)' : 'Watch', '3@1', {
        disabled: !configReady,
        ...(configReady ? {} : { disabledReason: unavailableReason }),
      }));
      items.push(makeItem('extension.vsKubernetesDeleteWatch', zh ? '停止观察 (Stop Watching)' : 'Stop Watching', '3@2', {
        disabled: !configReady,
        ...(configReady ? {} : { disabledReason: unavailableReason }),
      }));
    }
    return sortActions(items);
  }

  if (node.type === 'resource' && node.resource) {
    const resource = node.resource;
    const isNamespace = resource.group === '' && resource.resource === 'namespaces';
    const disabled = !configReady || stale || !resource.uid || !resource.resourceVersion;
    const reason = unavailableReason ?? (!resource.uid || !resource.resourceVersion ? (zh ? '缺少稳定 UID/RV' : 'Missing stable UID/RV') : undefined);

    if (isNamespace) {
      const isCurrent = node.description?.includes('*') || (context.currentNamespace !== undefined && resource.name === context.currentNamespace);
      if (!isCurrent) {
        items.push(makeItem('extension.vsKubernetesUseNamespace', zh ? '设为当前 Namespace' : 'Use Namespace', '0@1', {
          mutating: true,
          disabled,
          ...(reason ? { disabledReason: reason } : {}),
        }));
      }
      items.push(makeItem('extension.vsKubernetesShowEvents', zh ? '显示事件 (Show Events)' : 'Show Events', '1@1', {
        disabled: !configReady || stale,
        ...(unavailableReason ? { disabledReason: unavailableReason } : {}),
      }));
      items.push(makeItem('extension.vsKubernetesFollowEvents', zh ? '持续观察事件 (Follow Events)' : 'Follow Events', '1@2', {
        disabled: !configReady || stale,
        ...(unavailableReason ? { disabledReason: unavailableReason } : {}),
      }));
      items.push(makeItem('extension.vsKubernetesCopy', zh ? '复制名称' : 'Copy Name', '1@3', {
        disabled: !configReady || stale,
        ...(unavailableReason ? { disabledReason: unavailableReason } : {}),
      }));
      items.push(makeItem('extension.vsKubernetesDelete', zh ? '删除…' : 'Delete…', '2@2', {
        destructive: true,
        mutating: true,
        disabled,
        ...(reason ? { disabledReason: reason } : {}),
      }));
      return sortActions(items);
    }

    // Non-namespace resources (all builtin groups '', 'apps', 'batch', 'networking.k8s.io', 'storage.k8s.io', and CRDs)
    items.push(makeItem('extension.vsKubernetesLoad', zh ? '加载 YAML / JSON' : 'Load', '0@1', {
      disabled,
      ...(reason ? { disabledReason: reason } : {}),
    }));
    items.push(makeItem('extension.vsKubernetesCopy', zh ? '复制名称' : 'Copy Name', '1@1', {
      disabled: !configReady || stale,
      ...(unavailableReason ? { disabledReason: unavailableReason } : {}),
    }));
    items.push(makeItem('extension.vsKubernetesGet', zh ? 'Get Wide' : 'Get', '2@1', {
      disabled,
      ...(reason ? { disabledReason: reason } : {}),
    }));
    items.push(makeItem('extension.helmConvertToTemplate', zh ? '转换为 Helm 模板…' : 'Convert to Helm Template…', '2@1', {
      disabled,
      ...(reason ? { disabledReason: reason } : {}),
    }));
    // Upstream applies Delete to all vsKubernetes.resource.*; custom resources keep an explicit disabled reason until CRD delete is wired.
    items.push(makeItem('extension.vsKubernetesDelete', zh ? '删除…' : 'Delete…', '2@2', {
      destructive: true,
      mutating: true,
      disabled: disabled || !!context.isCustomResource,
      ...(context.isCustomResource
        ? { disabledReason: zh ? 'CRD 删除尚未支持' : 'CRD delete not yet supported' }
        : reason ? { disabledReason: reason } : {}),
    }));

    if (resource.group === '' && resource.resource === 'pods') {
      items.push(makeItem('extension.vsKubernetesDeleteNow', zh ? '立即删除…' : 'Delete Now…', '2@3', {
        destructive: true,
        mutating: true,
        disabled,
        ...(reason ? { disabledReason: reason } : {}),
      }));
      items.push(makeItem('extension.vsKubernetesTerminal', zh ? '终端 (Terminal)' : 'Terminal', '2@4', {
        inline: true,
        icon: 'terminal',
        disabled,
        ...(reason ? { disabledReason: reason } : {}),
      }));
      items.push(makeItem('extension.vsKubernetesDebugAttach', zh ? '调试 (Debug Attach)…' : 'Debug (Attach)…', '2@5', {
        mutating: true,
        disabled,
        ...(reason ? { disabledReason: reason } : {}),
      }));
    }

    if (localTunnelResources.has(resource.resource) && (resource.group === '' || resource.group === 'apps' || resource.group === 'batch')) {
      items.push(makeItem('extension.vsKubernetesDebugLocalTunnel', zh ? '本地隧道调试…' : 'Debug (Local Tunnel)…', '2@5', {
        mutating: true,
        disabled,
        ...(reason ? { disabledReason: reason } : {}),
      }));
    }

    if (portForwardResources.has(resource.resource) && (resource.group === '' || resource.group === 'apps')) {
      items.push(makeItem('extension.vsKubernetesPortForward', zh ? '端口转发 (Port Forward)…' : 'Port Forward…', '2@6', {
        mutating: true,
        disabled,
        ...(reason ? { disabledReason: reason } : {}),
      }));
    }

    if (scaleResources.has(resource.resource) && (resource.group === '' || resource.group === 'apps' || resource.group === 'batch')) {
      items.push(makeItem('extension.vsKubernetesScale', zh ? '扩缩容 (Scale)…' : 'Scale…', '2@6', {
        mutating: true,
        disabled,
        ...(reason ? { disabledReason: reason } : {}),
      }));
    }

    if (exposeResources.has(resource.resource) && (resource.group === '' || resource.group === 'apps')) {
      items.push(makeItem('extension.vsKubernetesExpose', zh ? '暴露服务 (Expose)…' : 'Expose…', '2@7', {
        mutating: true,
        disabled,
        ...(reason ? { disabledReason: reason } : {}),
      }));
    }

    items.push(makeItem('extension.vsKubernetesDescribe', zh ? '详情 (Describe)' : 'Describe', '3@1', {
      inline: true,
      icon: 'describe',
      disabled,
      ...(reason ? { disabledReason: reason } : {}),
    }));

    if ((resource.group === '' && resource.resource === 'pods') || (resource.group === 'batch' && resource.resource === 'jobs')) {
      items.push(makeItem('extension.vsKubernetesLogs', zh ? '日志 (Logs)' : 'Logs', '3@2', {
        inline: true,
        icon: 'logs',
        disabled,
        ...(reason ? { disabledReason: reason } : {}),
      }));
    }

    if (resource.group === 'batch' && resource.resource === 'cronjobs') {
      items.push(makeItem('extension.vsKubernetesCronJobRunNow', zh ? '立即运行 (Run Now)…' : 'Run CronJob Now…', '3@3', {
        mutating: true,
        disabled,
        ...(reason ? { disabledReason: reason } : {}),
      }));
    }

    if (resource.group === '' && (resource.resource === 'configmaps' || resource.resource === 'secrets')) {
      items.push(makeItem('extension.vsKubernetesAddFile', zh ? '添加文件 / 键…' : 'Add File(s)…', '3@3', {
        mutating: true,
        disabled,
        ...(reason ? { disabledReason: reason } : {}),
      }));
    }

    if (!context.isCustomResource) {
      items.push(makeItem('extension.vsKubernetesAddWatch', zh ? '观察此对象 (Watch)' : 'Watch', '3@4', {
        disabled,
        ...(reason ? { disabledReason: reason } : {}),
      }));
      items.push(makeItem('extension.vsKubernetesDeleteWatch', zh ? '停止观察 (Stop Watching)' : 'Stop Watching', '3@5', {
        disabled: !configReady,
        ...(configReady ? {} : { disabledReason: unavailableReason }),
      }));
    }

    return sortActions(items);
  }

  if (node.type === 'config-key') {
    const disabled = !configReady || stale || !node.resource?.uid || !node.resource?.resourceVersion;
    const reason = unavailableReason ?? (!node.resource?.uid || !node.resource?.resourceVersion ? (zh ? '缺少稳定 UID/RV' : 'Missing stable UID/RV') : undefined);
    items.push(makeItem('openchamber.k8s.openConfigKey', zh ? '查看键值 (View Value)' : 'View Key Value', '0@1', {
      disabled,
      ...(reason ? { disabledReason: reason } : {}),
    }));
    items.push(makeItem('extension.vsKubernetesCopy', zh ? '复制键名' : 'Copy Key Name', '1@1', {
      disabled: !configReady || stale,
      ...(unavailableReason ? { disabledReason: unavailableReason } : {}),
    }));
    items.push(makeItem('extension.vsKubernetesDeleteFile', zh ? '删除文件 / 键…' : 'Delete File…', '3@1', {
      destructive: true,
      mutating: true,
      disabled,
      ...(reason ? { disabledReason: reason } : {}),
    }));
    return sortActions(items);
  }

  if (node.type === 'release') {
    items.push(makeItem('extension.helmGet', zh ? '查看 Release 详情 (Get)' : 'Get Release', '0@1', {
      disabled: !configReady || stale,
      ...(unavailableReason ? { disabledReason: unavailableReason } : {}),
    }));
    items.push(makeItem('extension.vsKubernetesCopy', zh ? '复制名称' : 'Copy Name', '1@1', {
      disabled: !configReady || stale,
      ...(unavailableReason ? { disabledReason: unavailableReason } : {}),
    }));
    items.push(makeItem('extension.helmUninstall', zh ? '卸载 Release…' : 'Uninstall…', '3@2', {
      destructive: true,
      mutating: true,
      disabled: !configReady || stale,
      ...(unavailableReason ? { disabledReason: unavailableReason } : {}),
    }));
    return sortActions(items);
  }

  if (node.type === 'revision') {
    items.push(makeItem('extension.helmGet', zh ? '查看 Release 详情 (Get)' : 'Get Release', '0@1', {
      disabled: !configReady || stale,
      ...(unavailableReason ? { disabledReason: unavailableReason } : {}),
    }));
    items.push(makeItem('extension.helmRollback', zh ? '回滚到此版本…' : 'Rollback…', '3@1', {
      mutating: true,
      disabled: !configReady || stale,
      ...(unavailableReason ? { disabledReason: unavailableReason } : {}),
    }));
    return sortActions(items);
  }

  if (node.type === 'repo') {
    items.push(makeItem('openchamber.k8s.refreshHelmRepo', zh ? '刷新此仓库索引…' : 'Refresh Repository…', '0@1', { mutating: true }));
    return sortActions(items);
  }

  if (node.type === 'chart' || node.type === 'chart-version') {
    items.push(makeItem('extension.helmInspectChart', zh ? '检查 Chart (Inspect)' : 'Inspect Chart', '0@1'));
    items.push(makeItem('extension.helmFetchValues', zh ? '查看默认值 (Fetch Values)' : 'Fetch Values', '0@3'));
    items.push(makeItem('extension.helmDependencies', zh ? '查看依赖 (Dependencies)' : 'Dependencies', '0@3'));
    items.push(makeItem('extension.helmFetch', zh ? '拉取 Chart (Fetch)…' : 'Fetch…', '1@1', { mutating: true }));
    items.push(makeItem('extension.helmInstall', zh ? '安装 Chart (Install)…' : 'Install…', '2@1', { mutating: true }));
    return sortActions(items);
  }

  if (node.type === 'message') {
    items.push(makeItem('openchamber.k8s.showMessage', zh ? '查看说明' : 'Show Info Message', '0@1'));
    return sortActions(items);
  }

  return Object.freeze([]);
}

// Default explicit double-click / open-content command (RX-D2: single click selects only, never reads).
export function explorerDefaultAction(node: TreeNode): ExplorerCommandId | null {
  if (node.type === 'resource' && node.resource) {
    if (node.resource.group === '' && node.resource.resource === 'namespaces') return null;
    return 'extension.vsKubernetesLoad';
  }
  if (node.type === 'config-key') return 'openchamber.k8s.openConfigKey';
  if (node.type === 'release' || node.type === 'revision') return 'extension.helmGet';
  if (node.type === 'chart' || node.type === 'chart-version') return 'extension.helmInspectChart';
  if (node.type === 'message') return 'openchamber.k8s.showMessage';
  return null;
}
