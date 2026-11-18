import type { TreeSnapshot } from '../host/tree-controller.ts';
import type { TreeRow } from '../shared/tree-model.ts';
import { explorerNodeActions } from '../shared/explorer-actions.ts';
import type { ExplorerActionItem, ExplorerCommandId } from '../shared/explorer-actions.ts';
import { createActionMenuManager } from './action-menu.ts';
import { createActionSvgIcon, createTreeNodeIcon, explorerIcon, treeIconStatus } from './explorer-icons.ts';
import { panelDirection, panelText } from './i18n.ts';
import type { PanelLocale } from './i18n.ts';
import { explorerLabel, localizeExplorerActions } from './explorer-localization.ts';

export type TreeRendererCallbacks = {
  readonly onSelect: (rowId: string) => void;
  readonly onExpand: (rowId: string) => void;
  readonly onCollapse: (rowId: string) => void;
  readonly onMore: (rowId: string) => void;
  readonly onKeyboard: (key: string) => void;
  readonly onCommand: (command: ExplorerCommandId, row: TreeRow) => void;
  readonly extraActions?: (row: TreeRow) => readonly ExplorerActionItem[];
  readonly currentNamespace?: () => string | undefined;
  readonly configReady?: () => boolean;
  readonly isZh?: () => boolean;
  readonly locale?: () => PanelLocale;
};

export function rowTargetKey(row: TreeRow, generation: number): string {
  const res = row.entry.node.resource;
  return `${generation}:${row.id}:${res?.uid ?? ''}:${res?.resourceVersion ?? ''}:${row.stale ? 'stale' : 'fresh'}`;
}

export function createTreeRenderer(document: Document, host: HTMLElement, callbacks: TreeRendererCallbacks, overlayHost?: HTMLElement) {
  const tree = document.createElement('div');
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', 'Clusters');
  tree.className = 'oc-k8s-tree';
  tree.tabIndex = 0;

  const menuManager = createActionMenuManager(document, overlayHost);
  const rowElements = new Map<string, HTMLElement>();
  const rowContents = new Map<string, { entry: TreeRow['entry']; state: string }>();
  let snapshot: TreeSnapshot | undefined;
  let forceFocusTreeOnRender = false;
  let paintedLocale: PanelLocale | undefined;
  const locale = () => callbacks.locale?.() ?? (callbacks.isZh?.() ? 'zh-CN' : 'en');

  function actionsFor(row: TreeRow): readonly ExplorerActionItem[] {
    if (callbacks.extraActions) return localizeExplorerActions(locale(), callbacks.extraActions(row));
    const zh = locale().startsWith('zh');
    const configReady = callbacks.configReady?.() ?? true;
    const currentNamespace = callbacks.currentNamespace?.();
    const isCustom = row.entry.query?.kind === 'custom-resources'
      || (row.entry.node.type === 'resource' && !!row.entry.node.resource && row.entry.node.resource.group !== '' && !['apps', 'batch', 'networking.k8s.io', 'storage.k8s.io'].includes(row.entry.node.resource.group));
    return localizeExplorerActions(locale(), explorerNodeActions({
      node: row.entry.node,
      zh,
      stale: row.stale,
      configReady,
      hasActiveContext: true,
      ...(currentNamespace !== undefined ? { currentNamespace } : {}),
      isCustomResource: isCustom,
    }));
  }

  function openMenuFor(row: TreeRow, anchor: HTMLElement, pointer?: { readonly clientX: number; readonly clientY: number }): void {
    const items = actionsFor(row);
    if (!items.length || !snapshot) return;
    const gen = snapshot.generation;
    menuManager.open({
      anchor,
      ...(pointer ? { pointer } : {}),
      items,
      targetKey: rowTargetKey(row, gen),
      restoreFocusTo: () => rowElements.get(row.id) ?? tree,
      onSelect: item => {
        // Re-validate row target in the latest snapshot before dispatching (RX-F5).
        const latest = snapshot?.rows.find(candidate => candidate.id === row.id);
        if (!latest || snapshot?.generation !== gen) return;
        if (latest.entry.node.resource?.uid !== row.entry.node.resource?.uid) return;
        callbacks.onCommand(item.id, latest);
      },
    });
  }

  function buildRowElement(row: TreeRow, language: PanelLocale, existing?: HTMLElement, sameContent = false): HTMLElement {
    const zh = language.startsWith('zh');
    const nodeLabel = explorerLabel(language, row.entry);
    const item = existing ?? document.createElement('div');
    if (!sameContent) item.replaceChildren();
    item.removeAttribute('aria-expanded');
    if (row.opening) item.setAttribute('aria-busy', 'true');
    else if (item.hasAttribute('aria-busy')) item.removeAttribute('aria-busy');
    item.removeAttribute('aria-label');
    item.removeAttribute('title');
    item.setAttribute('role', 'treeitem');
    item.dataset.rowId = row.id;
    item.dataset.nodeType = row.entry.node.type;
    item.setAttribute('aria-level', String(row.level));
    item.setAttribute('aria-posinset', String(row.position));
    item.setAttribute('aria-setsize', String(row.setSize));
    if (row.entry.node.expandable) item.setAttribute('aria-expanded', String(row.expanded));
    item.setAttribute('aria-selected', String(row.selected));
    item.tabIndex = row.focused ? 0 : -1;
    item.className = 'oc-k8s-tree-item';
    if (row.focused) item.classList.add('oc-k8s-tree-item-focused');
    if (row.selected) item.classList.add('oc-k8s-tree-item-selected');
    if (row.stale) item.classList.add('oc-k8s-tree-item-stale');
    if (row.error) item.classList.add('oc-k8s-tree-item-error');
    item.style.setProperty('--oc-k8s-tree-level', String(row.level));
    if (sameContent) {
      const statusText = treeIconStatus(row.entry.node.icon, language);
      if (statusText) {
        item.setAttribute('aria-label', `${row.entry.node.label} · ${statusText}`);
        item.title = `${row.entry.node.tooltip ?? row.entry.node.label} · ${statusText}`;
      }
      return item;
    }

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.tabIndex = -1;
    toggle.className = 'oc-k8s-tree-toggle';
    toggle.setAttribute('aria-label', panelText(language, row.opening ? 'explorer.loadingNode' : row.expanded ? 'explorer.collapseNode' : 'explorer.expandNode', nodeLabel));
    if (row.opening) {
      const spinner = document.createElement('span');
      spinner.className = 'oc-k8s-tree-spinner'; spinner.setAttribute('aria-hidden', 'true'); toggle.append(spinner);
    } else toggle.textContent = row.entry.node.expandable ? (row.expanded ? '▾' : panelDirection(language) === 'rtl' ? '◂' : '▸') : '';
    toggle.disabled = !row.entry.node.expandable || !!row.opening;
    if (row.entry.node.expandable) {
      toggle.addEventListener('click', event => {
        event.stopPropagation();
        menuManager.close(false);
        if (row.opening) return;
        if (row.expanded) callbacks.onCollapse(row.id);
        else callbacks.onExpand(row.id);
      });
    }

    const icon = createTreeNodeIcon(document, explorerIcon(row.entry), row.entry.node.type);
    const statusText = treeIconStatus(row.entry.node.icon, language);
    if (statusText) {
      item.setAttribute('aria-label', `${row.entry.node.label} · ${statusText}`);
      item.title = `${row.entry.node.tooltip ?? row.entry.node.label} · ${statusText}`;
    }

    const label = document.createElement('span');
    label.className = 'oc-k8s-tree-label';
    label.textContent = nodeLabel;
    label.dir = nodeLabel === row.entry.node.label ? 'ltr' : 'auto';
    label.title = item.title || row.entry.node.tooltip || nodeLabel;

    item.append(toggle, icon, label);

    if (row.entry.node.description) {
      const desc = document.createElement('span');
      desc.className = 'oc-k8s-tree-description';
      desc.textContent = row.entry.node.description;
      item.append(desc);
    }

    if (!row.opening && (row.phase === 'loading' || row.stale || row.error)) {
      const badge = document.createElement('span');
      badge.className = 'oc-k8s-tree-badge';
      const budget = row.error === 'CRD_LIST_BUDGET_EXCEEDED' ? panelText(language, 'explorer.crdListLimit')
        : row.error === 'CRD_OBJECT_BUDGET_EXCEEDED' ? panelText(language, 'explorer.crdObjectLimit')
          : row.error === 'CUSTOM_LIST_BUDGET_EXCEEDED' ? panelText(language, 'explorer.customListLimit') : undefined;
      badge.textContent = row.error ? (budget ?? (row.error === 'AUTHENTICATION_UNAVAILABLE' ? panelText(language, 'explorer.authFailed') : row.error === 'AUTH_PLUGIN_NOT_FOUND' ? panelText(language, 'explorer.authPluginMissing') : row.error)) : row.phase === 'loading' ? '…' : panelText(language, 'explorer.stale');
      if (row.error) {
        badge.title = row.error === 'AUTHENTICATION_UNAVAILABLE'
          ? (zh ? '自动认证失败。请检查 Server 的云登录状态，再刷新此分支。' : 'Automatic authentication failed. Check cloud login on the Server, then refresh this branch.')
          : row.error === 'AUTH_PLUGIN_NOT_FOUND'
            ? (zh ? 'Server 上找不到 kubeconfig 声明的认证插件。请检查其安装路径。' : 'The kubeconfig credential plugin was not found on the Server. Check its installed path.')
            : budget ? `${budget} (${row.error})` : row.error;
        badge.setAttribute('aria-label', budget ?? row.error);
      }
      item.append(badge);
    }

    const actions = actionsFor(row);
    const inlineActions = actions.filter(action => action.inline);
    const rowToolbar = document.createElement('span');
    rowToolbar.className = 'oc-k8s-tree-inline-actions';

    for (const action of inlineActions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.tabIndex = -1;
      btn.className = 'oc-k8s-tree-inline-button';
      btn.dataset.command = action.id;
      btn.setAttribute('aria-label', `${action.label} ${nodeLabel}`);
      btn.title = action.disabled && action.disabledReason ? `${action.label} (${action.disabledReason})` : action.label;
      btn.disabled = !!action.disabled;
      if (action.icon) btn.append(createActionSvgIcon(document, action.icon));
      else btn.textContent = action.label;
      btn.addEventListener('click', event => {
        event.stopPropagation();
        menuManager.close(false);
        if (!action.disabled) callbacks.onCommand(action.id, row);
      });
      rowToolbar.append(btn);
    }

    if (actions.length > 0) {
      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.tabIndex = -1;
      menuBtn.className = 'oc-k8s-tree-menu-button';
      menuBtn.setAttribute('aria-haspopup', 'menu');
      menuBtn.setAttribute('aria-label', panelText(language, 'explorer.actionsFor', nodeLabel));
      menuBtn.title = panelText(language, 'explorer.moreActions');
      menuBtn.append(createActionSvgIcon(document, 'more'));
      menuBtn.addEventListener('click', event => {
        event.stopPropagation();
        openMenuFor(row, menuBtn);
      });
      rowToolbar.append(menuBtn);
    }

    if (row.canMore) {
      const more = document.createElement('button');
      more.type = 'button';
      more.tabIndex = -1;
      more.className = 'oc-k8s-tree-more';
      more.textContent = panelText(language, 'explorer.loadMore');
      more.setAttribute('aria-label', panelText(language, 'explorer.moreFor', nodeLabel));
      more.addEventListener('click', event => {
        event.stopPropagation();
        menuManager.close(false);
        callbacks.onMore(row.id);
      });
      rowToolbar.append(more);
    }

    if (rowToolbar.childNodes.length) item.append(rowToolbar);

    // Keep the row identity through selection redraws: replacing it after the
    // first click prevents native double-click recognition. Resolve live state.
    if (!existing) {
      const current = () => snapshot?.rows.find(candidate => candidate.id === row.id);
      item.addEventListener('click', () => {
        if (!current()) return;
        menuManager.close(false);
        item.focus({ preventScroll: true });
        callbacks.onSelect(row.id);
      });
      item.addEventListener('dblclick', event => {
        event.stopPropagation();
        if ((event.target as HTMLElement | null)?.closest('button')) return;
        menuManager.close(false);
        const latest = current();
        if (!latest?.entry.node.expandable || latest.opening) return;
        if (latest.expanded) callbacks.onCollapse(latest.id);
        else if (!latest.stale) callbacks.onExpand(latest.id);
      });
      // Right-click binds the live row WITHOUT altering selection or reading.
      item.addEventListener('contextmenu', event => {
        const latest = current();
        if (!latest || !actionsFor(latest).length) return;
        event.preventDefault();
        event.stopPropagation();
        openMenuFor(latest, item, { clientX: event.clientX, clientY: event.clientY });
      });
    }

    return item;
  }

  function render(nextSnapshot: TreeSnapshot): void {
    const activeEl = document.activeElement;
    const previousFocus = snapshot?.rows.find(row => row.focused)?.id;
    const activeRow = activeEl?.parentElement === tree ? activeEl as HTMLElement : undefined;
    const ownsModelFocus = activeEl === tree || (previousFocus !== undefined && rowElements.get(previousFocus) === activeRow);
    snapshot = nextSnapshot;
    const language = locale();
    if (paintedLocale !== language) {
      if (paintedLocale !== undefined) menuManager.close(true);
      paintedLocale = language;
      tree.setAttribute('aria-label', panelText(language, 'explorer.clusters'));
    }
    const validTargets = new Set(nextSnapshot.rows.map(row => rowTargetKey(row, nextSnapshot.generation)));
    menuManager.reconcileTargets(validTargets);

    const nodes: HTMLElement[] = [];
    const previousRows = new Map(rowElements);
    const previousContents = new Map(rowContents);
    rowElements.clear();
    rowContents.clear();
    for (const row of nextSnapshot.rows) {
      const content = JSON.stringify([row.level, row.position, row.setSize, row.expanded, row.opening, row.phase, row.stale, row.error, row.canMore, row.empty, language]);
      const previous = previousContents.get(row.id);
      const el = buildRowElement(row, language, previousRows.get(row.id), previous?.entry === row.entry && previous.state === content);
      rowElements.set(row.id, el);
      rowContents.set(row.id, { entry: row.entry, state: content });
      nodes.push(el);
    }
    if (nextSnapshot.message) {
      const msg = document.createElement('div');
      msg.setAttribute('role', 'note');
      msg.className = 'oc-k8s-tree-message';
      msg.textContent = nextSnapshot.message;
      nodes.push(msg);
    }
    // Do not detach unchanged rows, even for an instant. Native dblclick tracks
    // the original connected target through the two selection click handlers.
    for (const [index, node] of nodes.entries()) {
      const current = tree.childNodes[index] ?? null;
      if (current !== node) tree.insertBefore(node, current);
    }
    while (tree.childNodes.length > nodes.length) tree.removeChild(tree.childNodes[tree.childNodes.length - 1]!);

    const focused = nextSnapshot.rows.find(row => row.focused);
    const modelMoved = ownsModelFocus && previousFocus !== focused?.id;
    const lostRowFocus = activeRow && (document.activeElement === document.body || !document.activeElement);
    // An unchanged cursor in a background snapshot cannot pull focus back
    // from a click whose selection has not reached the project model yet.
    if ((forceFocusTreeOnRender || modelMoved || lostRowFocus) && !menuManager.isOpen()) {
      const focusedElement = lostRowFocus && activeRow.isConnected && !forceFocusTreeOnRender && !modelMoved
        ? activeRow : focused ? rowElements.get(focused.id) : tree;
      if (focusedElement !== document.activeElement) focusedElement?.focus({ preventScroll: true });
    }
    forceFocusTreeOnRender = false;
  }

  tree.addEventListener('keydown', event => {
    if (menuManager.isOpen()) return;
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const focused = snapshot?.rows.find(row => row.focused);
      if (focused) {
        const anchor = rowElements.get(focused.id) ?? tree;
        openMenuFor(focused, anchor);
      }
      return;
    }
    const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    menuManager.close(false);
    forceFocusTreeOnRender = true;
    const rtl = panelDirection(locale()) === 'rtl';
    callbacks.onKeyboard(event.key === ' ' ? 'Space' : rtl && event.key === 'ArrowRight' ? 'ArrowLeft' : rtl && event.key === 'ArrowLeft' ? 'ArrowRight' : event.key);
  });

  host.append(tree);

  return {
    element: tree,
    menu: menuManager,
    render,
    focusSelectedOrCurrent(): void {
      const focused = tree.querySelector('.oc-k8s-tree-item-focused') as HTMLElement | null;
      (focused ?? tree).focus({ preventScroll: true });
    },
    dispose(): void {
      menuManager.dispose();
      rowElements.clear();
      rowContents.clear();
      tree.replaceChildren();
      tree.remove();
    },
  };
}
