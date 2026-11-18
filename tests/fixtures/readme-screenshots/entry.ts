// Screenshot composition only: real panel views, fixed display state, no SDK
// connection, transport, operation client, PTY, socket or product entry point.
import { mountDocumentView } from '../../../src/panel/document-view.ts';
import { mountExecForwardDashboardView } from '../../../src/panel/exec-forward-dashboard-view.ts';
import { mountTaskTabs } from '../../../src/panel/task-tabs.ts';
import { mountTerminalSessionView } from '../../../src/panel/terminal-session-view.ts';
import { mountTreeView } from '../../../src/panel/tree-view.ts';
import { mountWorkbenchSplit } from '../../../src/panel/workbench-split.ts';
import { sceneRestoring } from '../../../src/panel/workspace-scene.ts';
import type { ResourceType } from '../../../src/shared/identity.ts';
import { localTreeEntries, resourceTreeEntry } from '../../../src/shared/tree-entries.ts';
import type { TreeEntry, TreeQuery } from '../../../src/shared/tree-entries.ts';
import { TreeModel } from '../../../src/shared/tree-model.ts';
import { resourceDescriptors } from '../../../src/shared/tree.ts';
import type { TreeIcon } from '../../../src/shared/tree.ts';

const target = { serviceGeneration: 'preview', projectId: 'storefront-demo', configIdentity: 'preview', context: 'demo-cluster', namespace: 'storefront' };
const selection = { mode: 'default' } as const;
const locale = () => 'en';
const unavailable = (): never => { throw new Error('Screenshot views may not use a host bridge'); };
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };

function reference({ group, version, kind, resource, scope }: ResourceType, name: string) {
  return { type: { group, version, kind, resource, scope }, name, namespace: target.namespace, uid: `preview-${resource}-${name}`, resourceVersion: '42' };
}

function node(ref: ReturnType<typeof reference>, icon?: TreeIcon, forwardPorts?: number[]) {
  const { type, ...identity } = ref;
  const children = Object.values(resourceDescriptors).find(item => item.resource === type.resource)?.children ?? 'none';
  return resourceTreeEntry({ id: ref.uid, type: 'resource', label: ref.name, expandable: children !== 'none', children,
    resource: { ...type, ...identity }, ...(icon ? { icon } : {}), ...(forwardPorts ? { forwardPorts } : {}) }, target);
}

const deployment = reference(resourceDescriptors.deployments, 'storefront-api');
const worker = reference(resourceDescriptors.deployments, 'order-worker');
const pod = reference(resourceDescriptors.pods, 'storefront-api-7d89c-hv6zx');
const pendingPod = reference(resourceDescriptors.pods, 'order-worker-6ccf8-p7nb4');
const service = reference(resourceDescriptors.services, 'storefront-api');
const canary = reference({ group: 'delivery.example', version: 'v1', kind: 'Canary', resource: 'canaries', scope: 'namespace' }, 'storefront-api-canary');
const definition = { name: 'canaries.delivery.example', uid: 'preview-canaries', resourceVersion: '42' };
const contextQuery = { kind: 'context', target } as const;
const folders = localTreeEntries(contextQuery, { helmReleases: true })!;

function makeTree(selected: ReturnType<typeof reference>, scene: string) {
  const model = new TreeModel();
  model.reset([{ node: { type: 'context', id: 'demo-cluster', label: target.context, tooltip: target.context, icon: 'kubernetes', expandable: true }, query: contextQuery }]);
  const rows = () => model.visible();
  function open(query: TreeQuery, entries: readonly TreeEntry[]) {
    const row = rows().find(item => item.entry.query?.kind === query.kind &&
      (query.kind !== 'group' || item.entry.query.kind === 'group' && item.entry.query.label === query.label) &&
      (query.kind !== 'resources' || item.entry.query.kind === 'resources' && item.entry.query.resource === query.resource));
    if (!row) throw new Error(`Missing fixture branch: ${query.kind}`);
    const ticket = model.begin(row.id, false, true);
    if (!ticket || !model.apply(ticket, { entries, cursor: null, proof: { resourceVersion: '42' } })) throw new Error('Could not load fixture rows');
  }
  const group = (label: string) => ({ kind: 'group', label, target } as const);
  const list = (resource: string) => ({ kind: 'resources', resource, target } as const);
  open(contextQuery, folders);
  open(group('Workloads'), localTreeEntries(group('Workloads'))!);
  open(list('deployments'), [node(deployment, 'workload-ready'), node(worker, 'workload-progressing')]);
  open(list('pods'), [node(pod, 'pod-running', [8080]), node(pendingPod, 'pod-not-ready')]);
  if (scene === 'explorer' || scene === 'port-forward') {
    open(group('Network'), localTreeEntries(group('Network'))!);
    open(list('services'), [node(service, undefined, [80, 443])]);
  }
  if (scene === 'explorer') {
    const query = { kind: 'custom-resources', target, definition } as const;
    open({ kind: 'custom-types', target }, [{ node: { type: 'folder', id: definition.uid, label: 'canaries', expandable: true }, query }]);
    open(query, [node(canary)]);
  }
  // Service and Deployment intentionally share a name, but not a row identity.
  const row = rows().find(item => item.entry.node.resource?.uid === selected.uid);
  if (!row) throw new Error(`Missing selected fixture resource: ${selected.uid}`);
  model.select(row.id);
  return { generation: model.generation, rows: rows(), message: null,
    roots: { phase: 'ready' as const, total: 1, nextOffset: null, error: null, available: true } };
}

const yaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront-api
  namespace: storefront
spec:
  replicas: 3
  selector:
    matchLabels: {app: storefront-api}
  template:
    metadata:
      labels: {app: storefront-api}
    spec:
      containers:
        - name: api
          image: registry.example/storefront-api:1.4.2
          ports: [{containerPort: 8080}]
`;

const terminalText = [
  '\x1b[96mapi@storefront-api-7d89c-hv6zx\x1b[0m:/app$ pwd',
  '/app',
  '\x1b[96mapi@storefront-api-7d89c-hv6zx\x1b[0m:/app$ ls',
  'config  public  server.js',
  '\x1b[96mapi@storefront-api-7d89c-hv6zx\x1b[0m:/app$ ',
].join('\r\n');

function mount() {
  const scene = new URLSearchParams(location.search).get('view');
  if (scene !== 'explorer' && scene !== 'resource-details' && scene !== 'terminal' && scene !== 'port-forward') throw new Error('Unknown screenshot scene');
  const app = document.querySelector<HTMLElement>('#app')!;
  const workbench = document.createElement('div');
  workbench.className = 'oc-k8s-workbench'; workbench.dataset.route = scene === 'explorer' ? 'explorer' : scene === 'resource-details' ? 'content' : 'sessions';
  const explorer = document.createElement('div');
  explorer.className = 'oc-k8s-explorer-shell'; explorer.id = 'oc-k8s-explorer-shell';
  const clusters = document.createElement('section');
  clusters.className = 'oc-k8s-explorer-section oc-k8s-clusters-section';
  const clusterHeader = document.createElement('header');
  clusterHeader.className = 'oc-k8s-view-header';
  const title = document.createElement('h2'), context = document.createElement('span');
  title.className = 'oc-k8s-view-title'; title.textContent = 'Clusters';
  context.className = 'oc-k8s-context-pill'; context.textContent = `${target.context} / ${target.namespace}`;
  clusterHeader.append(title, context); clusters.append(clusterHeader); explorer.append(clusters);

  const split = mountWorkbenchSplit(workbench, explorer);
  const detail = document.createElement('div');
  detail.className = 'oc-k8s-subview-shell'; detail.hidden = scene === 'explorer';
  workbench.append(explorer, split.handle, detail); app.append(workbench);
  const tree = mountTreeView(document, clusters, unavailable, locale, undefined, undefined, () => ({ currentNamespace: target.namespace, configReady: true }));
  tree.show(makeTree(scene === 'terminal' ? pod : scene === 'resource-details' ? deployment : service, scene));
  sceneRestoring(document, false);
  if (scene === 'explorer') {
    // Open the real, inert row menu via a presentation-only context-menu event.
    const row = tree.treeElement.querySelector<HTMLElement>('[aria-selected="true"]')!;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 550, clientY: row.getBoundingClientRect().top + 4 }));
    assert(tree.element.querySelector('[role="menu"]'), 'Resource action menu did not render');
    assert(tree.treeElement.textContent?.includes(canary.name), 'Custom resource instance did not render');
    return;
  }

  const bar = document.createElement('header');
  bar.className = 'oc-k8s-subview-bar';
  const back = document.createElement('button'), heading = document.createElement('h2'), route = document.createElement('div');
  back.className = 'oc-k8s-back-button'; back.textContent = '← Explorer';
  heading.className = 'oc-k8s-subview-title'; route.className = 'oc-k8s-route';
  bar.append(back, heading); detail.append(bar, route);
  if (scene === 'resource-details') {
    heading.textContent = `Load · ${deployment.name}`;
    const slot = document.createElement('div'); slot.className = 'oc-k8s-task-content'; route.append(slot);
    const source = { protocol: 2, selection, target, reference: deployment, format: 'yaml' } as const;
    const contentIdentity = '0'.repeat(64);
    mountDocumentView(document, slot, unavailable, locale).show({ phase: 'ready', stale: false, text: yaml, complete: true, source,
      page: { ...source, kind: 'resource-document', contentIdentity, totalBytes: yaml.length, totalCharacters: yaml.length, offset: 0, end: yaml.length, text: yaml, nextCursor: null },
      editor: { origin: { ...source, contentIdentity }, text: yaml, dirty: false, activeDocument: 0, revision: 0 },
    });
    const manifest = slot.querySelector('textarea');
    assert(manifest?.value === yaml && manifest.clientWidth > 500, 'Manifest is missing or too narrow');
    return;
  }

  const tasks = mountTaskTabs(document, route, [{ id: 'sessions', message: 'task.sessions' }, { id: 'terminal', message: 'action.terminal' },
    { id: 'forward', message: 'action.forward' }], locale);
  if (scene === 'terminal') {
    heading.textContent = `Terminal · ${pod.name}`;
    tasks.show('terminal');
    const terminal = mountTerminalSessionView(document, tasks.slots.terminal!, unavailable, locale);
    terminal.showTarget({ phase: 'ready', selection, target, reference: pod, containers: ['api', 'metrics'], container: 'api' });
    terminal.show({ phase: 'ready', id: 'preview-terminal', kind: 'terminal', inputBlocked: true, dropped: false, output: terminalText, scope: target,
      target: { podName: pod.name, podUid: pod.uid, namespace: pod.namespace, container: 'api' } });
    return;
  }
  heading.textContent = `Port Forward · ${service.name}`;
  tasks.show('forward');
  const forward = mountExecForwardDashboardView(document, tasks.slots.forward!, unavailable, locale);
  forward.selectTask('forward');
  forward.showTarget({ phase: 'ready', selection, target, reference: service, containers: [], forwardPorts: [80, 443] });
  assert(detail.querySelector<HTMLInputElement>('input[aria-label="Ports (local:remote)"]')?.value === '8080:80', 'Expected the first-port draft');
}

try {
  mount();
  document.body.dataset.result = 'ready';
} catch (error) {
  document.body.dataset.result = 'error';
  document.body.textContent = String(error);
  throw error;
}
