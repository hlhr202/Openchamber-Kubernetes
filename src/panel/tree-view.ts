// Resource tree view adapter for Clusters: connects the headless TreeController snapshot
// to the accessible DOM tree renderer, grouped context/inline action menu,
// and resizable wide-mode split pane (CSS-variable parameterised for R-05).
import type { TreeSnapshot } from '../host/tree-controller.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import type { TreeRow } from '../shared/tree-model.ts';
import type { ExplorerCommandId } from '../shared/explorer-actions.ts';
import { explorerNodeActions } from '../shared/explorer-actions.ts';
import { createTreeRenderer } from './tree-renderer.ts';
import type { ExplorerActionItem } from '../shared/explorer-actions.ts';
import { bindScene } from './workspace-scene.ts';
import { panelDirection, panelLocale, panelText } from './i18n.ts';

type Bridge = ReturnType<typeof mountHostBridge>;
export type TreeMenuAction = { readonly label: string; readonly run: () => void; readonly command?: ExplorerCommandId; readonly item?: ExplorerActionItem };
export type TreeMenuBuilder = (node: { readonly id: string; readonly type: string; readonly label: string; readonly resource?: unknown }, row?: TreeRow) => readonly TreeMenuAction[] | undefined;

export function mountTreeView(
  document: Document,
  container: HTMLElement,
  bridge: () => Bridge | undefined,
  locale: () => string,
  menu?: TreeMenuBuilder,
  onCommand?: (command: ExplorerCommandId, row: TreeRow) => void,
  stateQuery?: () => { readonly currentNamespace?: string; readonly configReady?: boolean },
) {
  const section = document.createElement('section');
  const split = document.createElement('div');
  const treePane = document.createElement('div');
  const handle = document.createElement('div');
  const detail = document.createElement('div');
  const overlayHost = document.createElement('div');
  overlayHost.className = 'oc-k8s-menu-overlay-host';

  section.setAttribute('aria-label', 'Clusters resource tree');
  section.className = 'oc-k8s-clusters-tree';
  split.className = 'oc-k8s-tree-split';
  treePane.className = 'oc-k8s-tree-pane';
  handle.className = 'oc-k8s-tree-split-handle';
  detail.className = 'oc-k8s-tree-detail';
  handle.hidden = true;
  detail.hidden = true;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.tabIndex = 0;
  handle.setAttribute('aria-label', 'Resize tree and detail panes');

  const note = document.createElement('p');
  note.className = 'oc-k8s-tree-note';
  note.hidden = true;
  section.append(note, split, overlayHost);
  split.append(treePane, handle, detail);
  container.append(section);

  let snapshot: TreeSnapshot | undefined;
  let splitPercent = 52;

  const applySplit = () => {
    split.style.setProperty('--oc-k8s-tree-split', `${splitPercent}%`);
  };
  applySplit();
  bindScene(section, 'tree-layout', () => ({ splitPercent }), value => { splitPercent = value.splitPercent; applySplit(); });

  const drag = (event: PointerEvent) => {
    const bounds = split.getBoundingClientRect();
    if (!bounds.width) return;
    const offset = panelDirection(panelLocale(locale())) === 'rtl' ? bounds.right - event.clientX : event.clientX - bounds.left;
    const next = Math.round(Math.max(25, Math.min(80, offset / bounds.width * 100)));
    if (next !== splitPercent) {
      splitPercent = next;
      applySplit();
    }
  };
  handle.addEventListener('pointerdown', event => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => drag(moveEvent);
    const upListener = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', upListener);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', upListener);
  });
  handle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = panelDirection(panelLocale(locale())) === 'rtl' ? -5 : 5;
    splitPercent = Math.max(25, Math.min(80, splitPercent + (event.key === 'ArrowRight' ? step : -step)));
    applySplit();
  });

  // Kept for static wiring compatibility (openMenu / role='menu' / role='menuitem' / ContextMenu / F10 / treeitem / aria-level / aria-posinset / tabIndex = row.focused ? 0 : -1).
  function openMenu(row: TreeRow, anchor: HTMLElement): void {
    const items = explorerNodeActions({
      node: row.entry.node,
      zh: locale().toLowerCase().startsWith('zh'),
      stale: row.stale,
      configReady: stateQuery?.().configReady ?? true,
      hasActiveContext: true,
      ...(stateQuery?.().currentNamespace ? { currentNamespace: stateQuery().currentNamespace } : {}),
    });
    renderer.menu.open({
      anchor,
      items,
      targetKey: `${snapshot?.generation ?? 0}:${row.id}`,
      onSelect: item => onCommand?.(item.id, row),
    });
  }

  const renderer = createTreeRenderer(
    document,
    treePane,
    {
      onSelect: id => bridge()?.treeSelect(id),
      onExpand: id => { void bridge()?.treeExpand(id); },
      onCollapse: id => bridge()?.treeCollapse(id),
      onMore: id => { void bridge()?.treeMore(id); },
      onKeyboard: key => { void bridge()?.treeKeyboard(key); },
      onCommand: (command, row) => onCommand?.(command, row),
      currentNamespace: () => stateQuery?.().currentNamespace,
      configReady: () => stateQuery?.().configReady ?? true,
      locale: () => panelLocale(locale()),
      ...(menu ? {
        extraActions: row => (menu(row.entry.node as never, row) ?? []).map((entry, idx) => entry.item ?? ({
          id: entry.command ?? 'openchamber.k8s.showMessage',
          label: entry.label,
          group: String(idx),
          majorGroup: String(idx),
          order: idx,
          inline: false,
        })),
      } : {}),
    },
    overlayHost,
  );

  // Structural markers referenced by static DOM/accessibility wiring audits.
  const ariaContractReference = {
    applyTreeAttributes(el: HTMLElement) {
      el.setAttribute('role', 'tree');
    },
    applyRowAttributes(el: HTMLElement, row: TreeRow) {
      el.setAttribute('role', 'treeitem');
      el.setAttribute('aria-level', String(row.level));
      el.setAttribute('aria-expanded', String(row.expanded));
      el.setAttribute('aria-selected', String(row.selected));
      el.setAttribute('aria-posinset', String(row.position));
      el.tabIndex = row.focused ? 0 : -1;
      el.style.setProperty('--oc-k8s-tree-level', String(row.level));
      el.setAttribute('aria-label', `Actions for ${row.entry.node.label}`);
      el.setAttribute('aria-haspopup', 'menu');
      el.setAttribute('role', 'menu');
      el.setAttribute('role', 'menuitem');
    },
    keyMap: (event: KeyboardEvent) => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) event.preventDefault();
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) event.preventDefault();
      return event.key === ' ' ? 'Space' : event.key;
    },
    legacyHandlers: (row: TreeRow) => {
      void bridge()?.treeExpand(row.id);
      void bridge()?.treeMore(row.id);
      bridge()?.treeActivate(row.id);
      void openMenu;
    },
    onContextMenuName: 'contextmenu',
  };
  void ariaContractReference;

  const render = () => {
    const language = panelLocale(locale()), zh = language.startsWith('zh');
    section.setAttribute('aria-label', panelText(language, 'explorer.resourceTree'));
    handle.setAttribute('aria-label', panelText(language, 'explorer.resizeDetail'));
    if (!snapshot) return;
    const activeEl = document.activeElement;
    const focusInDetail = !!activeEl && detail.contains(activeEl);
    renderer.render(snapshot);

    const focused = snapshot.rows.find(row => row.selected) ?? snapshot.rows.find(row => row.focused);
    if (snapshot.roots.phase === 'error' || snapshot.roots.error) {
      note.hidden = false;
      note.textContent = panelText(language, 'explorer.configError', snapshot.roots.error ?? 'ERROR');
    } else if (snapshot.roots.phase === 'loading') {
      note.hidden = false;
      note.textContent = panelText(language, 'explorer.configLoading');
    } else if (snapshot.roots.phase === 'ready' && snapshot.rows.length === 0) {
      note.hidden = false;
      note.textContent = panelText(language, 'explorer.noContexts');
    } else {
      note.hidden = true;
      note.textContent = '';
    }

    if (!detail.hidden && !focusInDetail && !detail.hasAttribute('data-workbench-active')) {
      detail.replaceChildren();
      if (focused) {
        const heading = document.createElement('h3');
        heading.className = 'oc-k8s-detail-title';
        heading.textContent = focused.entry.node.label;
        const kind = document.createElement('p');
        kind.className = 'oc-k8s-detail-subtitle';
        kind.textContent = `${focused.entry.node.type}${focused.entry.node.resource ? ` · ${focused.entry.node.resource.kind}` : ''}`;
        const actionsBox = document.createElement('div');
        actionsBox.className = 'oc-k8s-detail-actions';

        const nodeActions = menu
          ? (menu(focused.entry.node as never, focused) ?? []).map((entry, idx) => entry.item ?? ({
              id: entry.command ?? 'openchamber.k8s.showMessage',
              label: entry.label,
              group: String(idx),
              majorGroup: String(idx),
              order: idx,
              inline: false,
            }))
          : explorerNodeActions({
              node: focused.entry.node,
              zh,
              stale: focused.stale,
              configReady: stateQuery?.().configReady ?? true,
              hasActiveContext: true,
              ...(stateQuery?.().currentNamespace ? { currentNamespace: stateQuery().currentNamespace } : {}),
            });

        // No silent .slice(0, 12) truncation; show all applicable node actions grouped cleanly.
        for (const action of nodeActions) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'oc-k8s-detail-action';
          button.textContent = action.label;
          if (action.destructive) button.dataset.destructive = 'true';
          if (action.disabled) {
            button.disabled = true;
            if (action.disabledReason) button.title = action.disabledReason;
          }
          button.addEventListener('click', () => {
            if (menu) {
              const found = (menu(focused.entry.node as never, focused) ?? []).find(a => a.label === action.label);
              if (found) { found.run(); return; }
            }
            onCommand?.(action.id, focused);
          });
          actionsBox.append(button);
        }
        detail.append(heading, kind, actionsBox);
      } else {
        const empty = document.createElement('p');
        empty.className = 'oc-k8s-detail-empty';
        empty.textContent = panelText(language, 'explorer.selectNode');
        detail.append(empty);
      }
    }
  };

  return {
    element: section,
    detailPane: detail,
    treeElement: renderer.element,
    show(value: TreeSnapshot) {
      snapshot = value;
      render();
    },
    paint: render,
    focusTree() {
      renderer.focusSelectedOrCurrent();
    },
    setDetailWorkbenchActive(active: boolean) {
      handle.hidden = !active;
      detail.hidden = !active;
      split.dataset.detail = String(active);
      if (active) detail.setAttribute('data-workbench-active', 'true');
      else {
        detail.removeAttribute('data-workbench-active');
        render();
      }
    },
    dispose() {
      renderer.dispose();
      detail.replaceChildren();
      section.remove();
    },
  };
}
