import type { ExplorerActionIcon } from '../shared/explorer-actions.ts';
import type { TreeEntry } from '../shared/tree-entries.ts';
import { resourceDescriptors } from '../shared/tree.ts';
import type { ResourceKey } from '../shared/tree.ts';
import { panelText } from './i18n.ts';
import type { PanelLocale } from './i18n.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgElement(document: Document, paths: readonly string[], className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export function createTreeNodeIcon(document: Document, icon: string | undefined, nodeType: string): SVGSVGElement {
  const name = icon ?? nodeType;
  const cls = `oc-k8s-icon oc-k8s-icon-${name}`;
  switch (name) {
    case 'kubernetes':
      return svgElement(document, ['M8 1.4l5.2 2.7 1.3 5.7-3.7 4.4H5.2L1.5 9.8l1.3-5.7z', 'M8 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM8 3.6v2M8 10.4v2M4.2 5.8l1.7 1M10.1 9.2l1.7 1M4.2 10.2l1.7-1M10.1 6.8l1.7-1'], cls);
    case 'aks':
      return svgElement(document, ['M5.2 11.9H3.9a2.5 2.5 0 0 1-.5-5 4.1 4.1 0 0 1 7.8-1.1 3.1 3.1 0 0 1 .9 6.1H11', 'M8 8l2 1.2v2.4L8 13l-2-1.4V9.2z'], cls);
    case 'minikube':
      return svgElement(document, ['M1.8 12.7l4.5-7.5 2.6 4.2 1.9-2.9 3.4 6.2z', 'M5 7.5l1.3 1 1.3-1M9.2 3h3.5v3.2'], cls);
    case 'namespace':
      return svgElement(document, ['M2.6 6V2.6H6m4 0h3.4V6m0 4v3.4H10m-4 0H2.6V10', 'M6 6h4v4H6z'], cls);
    case 'node':
      return svgElement(document, ['M2.5 2.6h11v4H2.5zM2.5 9.4h11v4H2.5zM5 4.6h.01M5 11.4h.01M8 4.6h3M8 11.4h3'], cls);
    case 'workload':
      return svgElement(document, ['M2 7.4l6-3.2 6 3.2-6 3.2zM2 10.6l6 3.2 6-3.2'], cls);
    case 'pod':
      return svgElement(document, ['M8 2l5.4 3v6L8 14l-5.4-3V5zM2.6 5L8 8l5.4-3M8 8v6'], cls);
    case 'job':
      return svgElement(document, ['M3.3 2.5h9.4v11H3.3zM5.5 8l1.6 1.7 3.3-3.4'], cls);
    case 'cronjob':
      return svgElement(document, ['M8 2.4a5.6 5.6 0 1 1 0 11.2 5.6 5.6 0 0 1 0-11.2zM8 5v3.2l2 1.2'], cls);
    case 'network':
      return svgElement(document, ['M6.4 3h3.2v3.2H6.4zM2 10h3.2v3.2H2zM10.8 10H14v3.2h-3.2zM8 6.2v2.1H3.6V10M8 8.3h4.4V10'], cls);
    case 'storage':
      return svgElement(document, ['M2.7 5V11c0 3.3 10.6 3.3 10.6 0V5M2.7 5c0-3.3 10.6-3.3 10.6 0s-10.6 3.3-10.6 0M2.7 8c0 3.3 10.6 3.3 10.6 0'], cls);
    case 'configuration':
      return svgElement(document, ['M3.4 2.5h9.2v11H3.4zM5.5 6h5M5.5 9.7h5M7.1 5v2m2 1.7v2'], cls);
    case 'secret':
      return svgElement(document, ['M3.1 7h9.8v6.2H3.1zM5.2 7V5a2.8 2.8 0 0 1 5.6 0v2M8 9.5v1.4'], cls);
    case 'custom':
      return svgElement(document, ['M3 5.2h3V4a2 2 0 0 1 4 0v1.2h3.2v3h-1.1a1.7 1.7 0 0 0 0 3.4h1.1v1.7H3V10h1a1.5 1.5 0 0 0 0-3H3z'], cls);
    case 'helm':
      return svgElement(document, ['M8 2.4v8M3 10h10l-2 3H5zM7.8 3.2L4.3 8h3.5m2-3.5L12 8H9.8'], cls);
    case 'pod-running':
    case 'workload-ready':
      return svgElement(document, ['M8 2.2a5.8 5.8 0 1 1 0 11.6 5.8 5.8 0 0 1 0-11.6z', 'M5.5 8.2l1.8 1.8 3.4-3.8'], cls);
    case 'pod-not-ready':
    case 'workload-progressing':
      return svgElement(document, ['M8 2.2a5.8 5.8 0 1 1 0 11.6 5.8 5.8 0 0 1 0-11.6z', 'M8 5.2v3.3M8 10.8h.01'], cls);
    case 'pod-completed':
      return svgElement(document, ['M8 2.2a5.8 5.8 0 1 1 0 11.6 5.8 5.8 0 0 1 0-11.6z', 'M5.4 8h5.2'], cls);
    case 'pod-error':
    case 'workload-error':
      return svgElement(document, ['M8 2.2a5.8 5.8 0 1 1 0 11.6 5.8 5.8 0 0 1 0-11.6z', 'M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4'], cls);
    case 'workload-paused':
      return svgElement(document, ['M8 2.2a5.8 5.8 0 1 1 0 11.6 5.8 5.8 0 0 1 0-11.6z', 'M6.4 5.7v4.6M9.6 5.7v4.6'], cls);
    case 'helm-repo':
    case 'repo':
      return svgElement(document, ['M2.5 4.2h4.2l1.3 1.4h5.5v6.8h-11z'], cls);
    case 'helm-deployed':
    case 'release':
      return svgElement(document, ['M8 2l4.8 2.8v6.4L8 14l-4.8-2.8V4.8z', 'M5.8 8l1.6 1.6 3-3.2'], cls);
    case 'helm-failed':
      return svgElement(document, ['M8 2l4.8 2.8v6.4L8 14l-4.8-2.8V4.8z', 'M6 6l4 4M10 6l-4 4'], cls);
    case 'config-key':
      return svgElement(document, ['M5.5 6.5a2.5 2.5 0 1 1 2.2 2.4V13l1.8-1.2'], cls);
    case 'folder':
      return svgElement(document, ['M2 4.2h4.2l1.2 1.4H14v6.6H2z'], cls);
    case 'info':
      return svgElement(document, ['M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z', 'M8 7.5v3.5M8 5.2h.01'], cls);
    case 'message':
      return svgElement(document, ['M2.5 3.5h11v7.5H6.5l-3 2v-2h-1z'], cls);
    default:
      return svgElement(document, ['M3.2 3.2h9.6v9.6H3.2z', 'M5.5 6.2h5M5.5 9.2h3.5'], cls);
  }
}

const resourceIcons: Record<ResourceKey, string> = {
  namespaces: 'namespace', nodes: 'node', deployments: 'workload', statefulsets: 'workload', daemonsets: 'workload',
  jobs: 'job', cronjobs: 'cronjob', pods: 'pod', services: 'network', endpoints: 'network', ingresses: 'network',
  persistentvolumes: 'storage', persistentvolumeclaims: 'storage', storageclasses: 'storage', configmaps: 'configuration', secrets: 'secret',
};
const groupIcons = { Workloads: 'workload', Network: 'network', Storage: 'storage', Configuration: 'configuration' };
const builtins = Object.entries(resourceDescriptors) as [ResourceKey, (typeof resourceDescriptors)[ResourceKey]][];

export function explorerIcon({ node, query }: TreeEntry): string {
  if (node.icon) return node.icon; // Status glyph and color take precedence over type.
  if (node.type === 'context') return 'kubernetes';
  if (query?.kind === 'group' && Object.hasOwn(groupIcons, query.label)) return groupIcons[query.label as keyof typeof groupIcons];
  if (query?.kind === 'resources' && Object.hasOwn(resourceIcons, query.resource)) return resourceIcons[query.resource as ResourceKey];
  if (query?.kind === 'custom-types' || query?.kind === 'custom-resources') return 'custom';
  if (query?.kind === 'helm-releases' || query?.kind === 'helm-dependency' || node.type === 'revision') return 'helm';
  const type = node.resource;
  if (type && node.type === 'resource') {
    const builtin = builtins.find(([, value]) => value.group === type.group && value.version === type.version
      && value.resource === type.resource && value.kind === type.kind && value.scope === type.scope);
    return builtin ? resourceIcons[builtin[0]] : 'custom';
  }
  return node.type;
}

export function treeIconStatus(icon: string | undefined, language: PanelLocale | boolean): string | undefined {
  const locale = typeof language === 'boolean' ? (language ? 'zh-CN' : 'en') : language;
  switch (icon) {
    case 'pod-running': return panelText(locale, 'status.podReady');
    case 'pod-not-ready': return panelText(locale, 'status.podNotReady');
    case 'pod-completed': return panelText(locale, 'status.completed');
    case 'pod-error': return panelText(locale, 'status.podError');
    case 'workload-ready': return panelText(locale, 'status.deploymentReady');
    case 'workload-progressing': return panelText(locale, 'status.deploymentProgress');
    case 'workload-error': return panelText(locale, 'status.deploymentError');
    case 'workload-paused': return panelText(locale, 'status.deploymentPaused');
    case 'helm-deployed': return panelText(locale, 'status.releaseDetails');
    case 'helm-failed': return panelText(locale, 'status.releaseFailed');
    default: return undefined;
  }
}

export function createActionSvgIcon(document: Document, icon: ExplorerActionIcon): SVGSVGElement {
  const cls = `oc-k8s-action-icon oc-k8s-action-icon-${icon}`;
  switch (icon) {
    case 'describe':
      return svgElement(document, ['M3.5 2.2h6.5l2.5 2.5v9.1h-9z', 'M5.8 7.2h4.4M5.8 9.8h4.4M5.8 12h2.6'], cls);
    case 'logs':
      return svgElement(document, ['M2.5 3.5h11M2.5 6.8h8.5M2.5 10.1h10M2.5 13.2h6.5'], cls);
    case 'terminal':
      return svgElement(document, ['M2.2 3h11.6v10H2.2z', 'M4.5 6.2L6.8 8l-2.3 1.8', 'M8 10h3.2'], cls);
    case 'refresh':
      return svgElement(document, ['M13 7.8a5 5 0 1 1-1.4-3.4', 'M13 2.6v2.6h-2.6'], cls);
    case 'collapse-all':
      return svgElement(document, ['M3 5.5h10M5.2 3L8 5.2 10.8 3', 'M3 10.5h10M5.2 13L8 10.8 10.8 13'], cls);
    case 'kubeconfig':
      return svgElement(document, ['M3 4.5h10v7H3z', 'M5.5 7.2h5M5.5 9.5h3'], cls);
    case 'more':
      return svgElement(document, ['M3.5 8h.02M8 8h.02M12.5 8h.02'], cls);
  }
}
