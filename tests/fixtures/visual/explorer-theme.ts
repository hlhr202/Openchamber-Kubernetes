// Browser-only synthetic presentation fixture. Never loads mountPanel/host bridge
// or any service executor; all callbacks are local display operations or no-ops.
import { applyHostTheme } from '@openchamber/sdk/ui';
import type { HostTheme } from '@openchamber/sdk';
import { mountInspectionView } from '../../../src/panel/inspection-view.ts';
import { mountTreeView } from '../../../src/panel/tree-view.ts';
import type { TreeSnapshot } from '../../../src/host/tree-controller.ts';
import type { TreeRow } from '../../../src/shared/tree-model.ts';
import { inspectionSyntaxTheme } from '../../../src/shared/presentation-theme.ts';

const tokens = {
  font: 'system-ui, sans-serif', mono: 'ui-monospace, SFMono-Regular, Menlo, monospace', radius: '6px',
};
const themes: Record<'dark' | 'light', HostTheme> = {
  dark: { mode: 'dark', tokens: { ...tokens, background: '#121418', elevated: '#1b1e24', foreground: '#e4e7ed', muted: '#a1a9b6',
    subtle: '#687282', border: '#303640', hover: '#222833', selection: '#263b58', selectionForeground: '#f0f5ff', focus: '#8fb8ff',
    primary: '#97bfff', primaryForeground: '#111c2e', primaryText: '#a9c9ff', mutedSurface: '#191d24', elevatedForeground: '#e4e7ed', active: '#293343',
    success: '#6dc49a', warning: '#e5bd73', error: '#ec929d', info: '#8ebaff',
    successText: '#8fdaad', warningText: '#edc987', errorText: '#f2a1ab', infoText: '#a9c9ff',
    syntaxKeyword: '#a9c9ff', syntaxType: '#cfb7f3', syntaxNumber: '#e7c58d', syntaxString: '#a1d9b5' } },
  light: { mode: 'light', tokens: { ...tokens, background: '#ffffff', elevated: '#ffffff', foreground: '#202631', muted: '#596475',
    subtle: '#707a89', border: '#d9dee6', hover: '#f0f3f8', selection: '#dceaff', selectionForeground: '#172f57', focus: '#355eac',
    primary: '#315b9f', primaryForeground: '#ffffff', primaryText: '#254f94', mutedSurface: '#f6f8fb', elevatedForeground: '#202631', active: '#e5ecf7',
    success: '#237346', warning: '#825514', error: '#b63043', info: '#2c5b9c',
    successText: '#216b40', warningText: '#80520e', errorText: '#ae293d', infoText: '#285593',
    syntaxKeyword: '#285593', syntaxType: '#75449e', syntaxNumber: '#855610', syntaxString: '#216b40' } },
};
const root = document.getElementById('app')!;
const workbench = document.createElement('div'); workbench.className = 'oc-k8s-workbench'; workbench.dataset.route = 'content';
const explorer = document.createElement('div'); explorer.className = 'oc-k8s-explorer-shell';
const clusters = document.createElement('section'); clusters.className = 'oc-k8s-explorer-section oc-k8s-clusters-section';
const header = document.createElement('div'); header.className = 'oc-k8s-view-header';
const title = document.createElement('h2'); title.className = 'oc-k8s-view-title'; title.textContent = 'Clusters';
const context = document.createElement('span'); context.className = 'oc-k8s-context-pill'; context.textContent = 'demo-cluster / web';
header.append(title, context); clusters.append(header); explorer.append(clusters);
const pane = document.createElement('div'); pane.className = 'oc-k8s-subview-shell';
const bar = document.createElement('div'); bar.className = 'oc-k8s-subview-bar';
const back = document.createElement('button'); back.className = 'oc-k8s-back-button'; back.textContent = '← 返回资源树';
const heading = document.createElement('h2'); heading.className = 'oc-k8s-subview-title'; heading.textContent = 'Describe: api-worker-7bf4c8f59b-sample';
bar.append(back, heading); pane.append(bar); workbench.append(explorer, pane); root.append(workbench);
const target = { serviceGeneration: 'synthetic', projectId: 'fixture', configIdentity: 'fixture', context: 'demo-cluster', namespace: 'web' };
const names = [
  ['cluster', null, 1, 'demo-cluster', 'context', 'kubernetes'],
  ['ns', 'cluster', 2, 'Namespaces', 'folder'],
  ['web', 'ns', 3, '* web', 'resource'],
  ['system', 'ns', 3, 'kube-system', 'resource'],
  ['nodes', 'cluster', 2, 'Nodes', 'folder'],
  ['workloads', 'cluster', 2, 'Workloads', 'folder'],
  ['deployments', 'workloads', 3, 'Deployments', 'folder'],
  ['deploy-ready', 'deployments', 4, 'web-frontend', 'resource', 'workload-ready'],
  ['deploy-error', 'deployments', 4, 'api-worker', 'resource', 'workload-error'],
  ['pod-ready', 'deploy-error', 5, 'api-worker-7bf4c8f59b-ready', 'resource', 'pod-running'],
  ['pod-error', 'deploy-error', 5, 'api-worker-7bf4c8f59b-sample', 'resource', 'pod-error'],
  ['pod-pending', 'deploy-error', 5, 'api-worker-7bf4c8f59b-pending', 'resource', 'pod-not-ready'],
  ['pod-done', 'deploy-error', 5, 'api-worker-7bf4c8f59b-completed', 'resource', 'pod-completed'],
  ['deploying', 'deployments', 4, 'background-processor', 'resource', 'workload-progressing'],
  ['deploy-paused', 'deployments', 4, 'scheduled-worker', 'resource', 'workload-paused'],
] as const;
const rows: TreeRow[] = names.map(([id, parent, level, label, type, icon]) => ({
  id, parent, level, position: 1, setSize: 1, expanded: true, selected: id === 'pod-error', focused: false,
  phase: 'ready', stale: false, error: null, canMore: false, empty: false,
  entry: { query: null, node: { id, type, label, expandable: !['web', 'system', 'nodes'].includes(id),
    ...(icon ? { icon } : {}), ...(id.startsWith('pod-') ? { resource: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace', name: label, namespace: 'web', uid: id, resourceVersion: '10' }, children: 'pod-info' } : {}) } },
}));
// Production navigation and CSS; absent bridge means no service/SDK operations.
const tree = mountTreeView(document, clusters, () => undefined, () => 'zh-CN');
const snapshot = { generation: 1, rows, roots: { phase: 'ready', error: null }, message: undefined } as unknown as TreeSnapshot;
tree.show(snapshot);
// mountTreeView intentionally keeps nested details hidden. Use its real selected row
// and navigation; leave all callback execution disconnected in this fixture.
const view = mountInspectionView(document, pane, () => undefined, () => 'zh-CN');
view.show({ phase: 'ready', stale: false, complete: true, source: { protocol: 2, target, selection: { mode: 'default' }, mode: 'describe',
  reference: { type: { group: '', version: 'v1', resource: 'pods', kind: 'Pod', scope: 'namespace' }, name: 'api-worker-7bf4c8f59b-sample', namespace: 'web', uid: 'synthetic-pod', resourceVersion: '10' } },
  text: `Name:             api-worker-7bf4c8f59b-sample
Namespace:        web
Node:             worker-01/10.0.0.12
Status:           Running
IP:               10.0.1.24
Controlled By:    ReplicaSet/api-worker-7bf4c8f59b

Containers:
  api-worker:
    Image:          registry.example.invalid/api-worker:1.2.0
    Port:           3000/TCP
    State:          Waiting
      Reason:       CrashLoopBackOff
    Last State:     Terminated
      Reason:       Error
      Exit Code:    1
    Ready:          False
    Restart Count:  37
    Limits:
      cpu:          1
      memory:       1Gi
    Requests:
      cpu:          100m
      memory:       32Mi

Conditions:
  Type              Status
  Initialized       True
  Ready             False
  ContainersReady   False
  PodScheduled      True

Events:
  Type     Reason   Age    Message
  Warning  BackOff  2m     Back-off restarting failed container api-worker
` });
function luminance(color: string) {
  const values = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map(value => {
    const part = value / 255; return part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  });
  return (values[0] ?? 0) * .2126 + (values[1] ?? 0) * .7152 + (values[2] ?? 0) * .0722;
}
function check() {
  const selected = document.querySelector<HTMLElement>('.oc-k8s-tree-item-selected')!;
  const style = getComputedStyle(selected), a = luminance(style.color), b = luminance(style.backgroundColor);
  const contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  const buttons = [...document.querySelectorAll<HTMLElement>('.oc-k8s-tree-nav button')];
  const navigationFits = buttons.every(button => button.scrollWidth <= button.clientWidth + 1 && button.getBoundingClientRect().height < 40);
  const output = document.querySelector('.oc-k8s-inspection-output pre');
  const highlighted = !!output?.querySelector('.oc-k8s-syntax-error');
  const checks = { theme: document.documentElement.dataset.ocTheme, contrast: Number(contrast.toFixed(2)), navigationFits, highlighted, clusterRequests: 0 };
  document.getElementById('fixture-checks')!.textContent = JSON.stringify(checks);
  if (contrast < 4.5 || !navigationFits || !highlighted) throw new Error(`Display fixture check failed: ${JSON.stringify(checks)}`);
}
function theme(mode: 'dark' | 'light') {
  applyHostTheme(themes[mode], document.documentElement);
  document.documentElement.style.fontSize = '16px'; // Browser default; production SDK paints #app, not html.
  applyHostTheme(themes[mode], root);
  for (const [name, value] of Object.entries(inspectionSyntaxTheme(themes[mode].tokens))) root.style.setProperty(name, value);
  document.documentElement.dataset.ocTheme = mode;
  check();
}
document.getElementById('dark')!.addEventListener('click', () => theme('dark'));
document.getElementById('light')!.addEventListener('click', () => theme('light'));
window.addEventListener('resize', check);
theme('dark');
