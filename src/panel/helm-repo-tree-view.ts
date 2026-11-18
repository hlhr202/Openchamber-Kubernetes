import type { HelmRepositoryState } from '../host/helm-repository-client.ts';
import type { HelmRepositoryNode } from '../shared/helm-repository-protocol.ts';
import type { TreeNode } from '../shared/tree.ts';
import { explorerDefaultAction, explorerNodeActions, explorerTitleActions } from '../shared/explorer-actions.ts';
import type { ExplorerCommandId } from '../shared/explorer-actions.ts';
import { createActionMenuManager } from './action-menu.ts';
import { createActionSvgIcon, createTreeNodeIcon } from './explorer-icons.ts';
import { bindScene } from './workspace-scene.ts';
import { panelDirection, panelLocale, panelText } from './i18n.ts';
import type { PanelLocale } from './i18n.ts';
import { localizeExplorerActions } from './explorer-localization.ts';

export type HelmRepoTreeBridge = {
  readonly backHelmRepositories: () => unknown;
  readonly openHelmRepositoryNode: (nodeId: string) => unknown;
  readonly nextHelmRepositories: () => unknown;
};

export type HelmRepoNodeTarget = {
  readonly node: HelmRepositoryNode;
  readonly chartRef: string;
  readonly version?: string;
};

export function mountHelmRepoTreeView(
  document: Document,
  container: HTMLElement,
  bridge: () => HelmRepoTreeBridge | undefined,
  locale: () => string,
  onCommand: (command: ExplorerCommandId, target?: HelmRepoNodeTarget) => void,
) {
  const section = document.createElement('section');
  section.className = 'oc-k8s-explorer-section oc-k8s-helm-repos-section';
  section.setAttribute('aria-label', 'Helm Repos');

  const header = document.createElement('header');
  header.className = 'oc-k8s-view-header';

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'oc-k8s-section-toggle';
  collapseBtn.setAttribute('aria-expanded', 'true');

  const title = document.createElement('h2');
  title.className = 'oc-k8s-view-title';

  const titleActions = document.createElement('div');
  titleActions.className = 'oc-k8s-title-actions';

  const body = document.createElement('div');
  body.className = 'oc-k8s-helm-repos-body';

  const breadcrumb = document.createElement('div');
  breadcrumb.className = 'oc-k8s-helm-breadcrumb';

  const statusLine = document.createElement('p');
  statusLine.className = 'oc-k8s-inline-status';
  statusLine.setAttribute('role', 'status');

  const tree = document.createElement('div');
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', 'Helm Repos');
  tree.className = 'oc-k8s-tree oc-k8s-helm-tree';

  const footer = document.createElement('div');
  footer.className = 'oc-k8s-helm-footer';

  const overlayHost = document.createElement('div');
  overlayHost.className = 'oc-k8s-menu-overlay-host';

  header.append(collapseBtn, title, titleActions);
  body.append(breadcrumb, statusLine, tree, footer);
  section.append(header, body, overlayHost);
  container.append(section);

  const menuManager = createActionMenuManager(document, overlayHost);
  let state: HelmRepositoryState = { phase: 'idle', stale: false };
  let sectionCollapsed = false;
  let selectedId: string | undefined;

  function toTreeNode(node: HelmRepositoryNode): TreeNode {
    if (node.kind === 'repository') {
      return { id: node.id, type: 'repo', label: node.label, expandable: true, icon: 'helm-repo' };
    }
    if (node.kind === 'chart') {
      return { id: node.id, type: 'chart', label: node.label, expandable: true, description: node.repository };
    }
    return { id: node.id, type: 'chart-version', label: node.label, expandable: false, tooltip: node.tooltip, ...(node.appVersion ? { description: node.appVersion } : {}) };
  }

  function toTarget(node: HelmRepositoryNode): HelmRepoNodeTarget {
    if (node.kind === 'repository') return { node, chartRef: node.repository };
    if (node.kind === 'chart') return { node, chartRef: `${node.repository}/${node.chart}` };
    return { node, chartRef: `${node.repository}/${node.chart}`, version: node.version };
  }

  function openNodeMenu(node: HelmRepositoryNode, anchor: HTMLElement, pointer?: { readonly clientX: number; readonly clientY: number }): void {
    const language = panelLocale(locale()), zh = language.startsWith('zh');
    const items = localizeExplorerActions(language, explorerNodeActions({
      node: toTreeNode(node),
      zh,
      stale: state.stale,
      configReady: true,
      hasActiveContext: false,
    }));
    if (!items.length) return;
    menuManager.open({
      anchor,
      ...(pointer ? { pointer } : {}),
      items,
      targetKey: `helm:${node.id}`,
      onSelect: item => onCommand(item.id, toTarget(node)),
    });
  }

  collapseBtn.addEventListener('click', () => {
    sectionCollapsed = !sectionCollapsed;
    paint();
  });

  bindScene(section, 'helm-repo-tree', () => ({ sectionCollapsed, selectedId }), value => { sectionCollapsed = value.sectionCollapsed; selectedId = value.selectedId; paint(); });
  let paintedLanguage: PanelLocale | undefined;
  function paint(): void {
    const language = panelLocale(locale()), zh = language.startsWith('zh');
    const rtl = panelDirection(language) === 'rtl';
    if (paintedLanguage !== language) {
      menuManager.close(false);
      paintedLanguage = language;
    }
    const titleText = panelText(language, 'helm.repositories');
    section.setAttribute('aria-label', titleText);
    tree.setAttribute('aria-label', titleText);
    collapseBtn.setAttribute('aria-expanded', String(!sectionCollapsed));
    collapseBtn.textContent = sectionCollapsed ? (rtl ? '◂' : '▸') : '▾';
    collapseBtn.setAttribute('aria-label', panelText(language, sectionCollapsed ? 'explorer.expandNode' : 'explorer.collapseNode', titleText));
    title.textContent = titleText;
    body.hidden = sectionCollapsed;

    const allTitleActions = localizeExplorerActions(language, explorerTitleActions({
      view: 'helm-repos',
      zh,
      hasConfig: true,
      hasActiveContext: false,
      hasHelmRepos: (state.page?.total ?? 0) > 0,
    }));
    const inlineTitle = allTitleActions.filter(a => a.inline);
    const overflowTitle = allTitleActions.filter(a => !a.inline);

    titleActions.replaceChildren();
    for (const action of inlineTitle) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'oc-k8s-icon-button';
      btn.setAttribute('aria-label', action.label);
      btn.title = action.label;
      if (action.icon) btn.append(createActionSvgIcon(document, action.icon));
      else btn.textContent = action.label;
      btn.addEventListener('click', () => {
        menuManager.close(false);
        onCommand(action.id);
      });
      titleActions.append(btn);
    }
    if (overflowTitle.length > 0) {
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'oc-k8s-icon-button';
      moreBtn.setAttribute('aria-haspopup', 'menu');
      moreBtn.setAttribute('aria-label', panelText(language, 'explorer.actionsFor', titleText));
      moreBtn.title = panelText(language, 'explorer.moreActions');
      moreBtn.append(createActionSvgIcon(document, 'more'));
      moreBtn.addEventListener('click', () => {
        menuManager.open({
          anchor: moreBtn,
          items: overflowTitle,
          targetKey: 'helm-title',
          onSelect: item => onCommand(item.id),
        });
      });
      titleActions.append(moreBtn);
    }

    const page = state.page;
    const ready = state.phase === 'ready' && !state.stale;

    breadcrumb.replaceChildren();
    if (page && page.branch.kind !== 'repositories') {
      const backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'oc-k8s-link-button';
      backBtn.textContent = `${rtl ? '→' : '←'} ${panelText(language, 'common.back')}`;
      backBtn.disabled = !ready;
      backBtn.addEventListener('click', () => { void bridge()?.backHelmRepositories(); });
      const crumbText = document.createElement('span');
      crumbText.className = 'oc-k8s-helm-crumb-text';
      crumbText.textContent = page.branch.kind === 'charts' ? page.branch.repository : `${page.branch.repository} / ${page.branch.chart}`;
      breadcrumb.append(backBtn, crumbText);
      breadcrumb.hidden = false;
    } else {
      breadcrumb.hidden = true;
    }

    if (state.phase === 'loading') {
      statusLine.hidden = false;
      statusLine.textContent = panelText(language, 'helm.readingIndex');
    } else if (state.phase === 'error') {
      statusLine.hidden = false;
      statusLine.textContent = panelText(language, 'common.failed', state.error ?? 'ERROR');
    } else if (state.phase === 'idle') {
      statusLine.hidden = false;
      statusLine.textContent = panelText(language, 'helm.indexNotLoaded');
    } else if (page && page.nodes.length === 0) {
      statusLine.hidden = false;
      statusLine.textContent = panelText(language, 'common.noItems');
    } else {
      statusLine.hidden = true;
      statusLine.textContent = '';
    }

    tree.replaceChildren();
    for (const node of page?.nodes ?? []) {
      const treeNode = toTreeNode(node);
      const item = document.createElement('div');
      item.setAttribute('role', 'treeitem');
      item.dataset.nodeId = node.id;
      item.className = 'oc-k8s-tree-item';
      if (selectedId === node.id) item.classList.add('oc-k8s-tree-item-selected');
      item.setAttribute('aria-selected', String(selectedId === node.id));
      item.setAttribute('aria-level', page?.branch.kind === 'repositories' ? '1' : page?.branch.kind === 'charts' ? '2' : '3');
      if (treeNode.expandable) item.setAttribute('aria-expanded', 'false');

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.tabIndex = -1;
      toggle.className = 'oc-k8s-tree-toggle';
      toggle.textContent = treeNode.expandable ? '▸' : '';
      toggle.disabled = !treeNode.expandable || !ready;
      toggle.setAttribute('aria-label', `Open ${node.label}`);
      if (treeNode.expandable) {
        toggle.addEventListener('click', event => {
          event.stopPropagation();
          void bridge()?.openHelmRepositoryNode(node.id);
        });
      }

      const icon = createTreeNodeIcon(document, treeNode.icon, treeNode.type);
      const label = document.createElement('span');
      label.className = 'oc-k8s-tree-label';
      label.textContent = node.label;
      label.title = treeNode.tooltip ?? node.label;

      item.append(toggle, icon, label);
      if (node.kind === 'version' && node.appVersion) {
        const desc = document.createElement('span');
        desc.className = 'oc-k8s-tree-description';
        desc.textContent = `app ${node.appVersion}`;
        item.append(desc);
      }

      const actions = localizeExplorerActions(language, explorerNodeActions({ node: treeNode, zh, stale: state.stale, configReady: true, hasActiveContext: false }));
      if (actions.length > 0) {
        const toolbar = document.createElement('span');
        toolbar.className = 'oc-k8s-tree-inline-actions';
        const menuBtn = document.createElement('button');
        menuBtn.type = 'button';
        menuBtn.tabIndex = -1;
        menuBtn.className = 'oc-k8s-tree-menu-button';
        menuBtn.setAttribute('aria-haspopup', 'menu');
        menuBtn.setAttribute('aria-label', `Actions for ${node.label}`);
        menuBtn.append(createActionSvgIcon(document, 'more'));
        menuBtn.addEventListener('click', event => {
          event.stopPropagation();
          openNodeMenu(node, menuBtn);
        });
        toolbar.append(menuBtn);
        item.append(toolbar);
      }

      item.addEventListener('click', () => {
        menuManager.close(false);
        selectedId = node.id;
        paint();
      });
      item.addEventListener('dblclick', event => {
        event.stopPropagation();
        if (treeNode.expandable) {
          void bridge()?.openHelmRepositoryNode(node.id);
          return;
        }
        const def = explorerDefaultAction(treeNode);
        if (def) onCommand(def, toTarget(node));
      });
      item.addEventListener('contextmenu', event => {
        if (!actions.length) return;
        event.preventDefault();
        event.stopPropagation();
        openNodeMenu(node, item, { clientX: event.clientX, clientY: event.clientY });
      });

      tree.append(item);
    }

    footer.replaceChildren();
    if (page?.nextOffset !== null && page?.nextOffset !== undefined) {
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'oc-k8s-link-button';
      moreBtn.textContent = panelText(language, 'common.moreWithCount', page.offset + page.nodes.length, page.total);
      moreBtn.disabled = !ready;
      moreBtn.addEventListener('click', () => { void bridge()?.nextHelmRepositories(); });
      footer.append(moreBtn);
    }
  }

  paint();

  return {
    element: section,
    update(next: HelmRepositoryState) {
      state = next;
      paint();
    },
    paint,
    dispose() {
      menuManager.dispose();
      tree.replaceChildren();
      section.remove();
    },
  };
}
