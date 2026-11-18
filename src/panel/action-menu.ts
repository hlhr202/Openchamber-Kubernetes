import type { ExplorerActionItem } from '../shared/explorer-actions.ts';

export type ActionMenuOpenOptions = {
  readonly anchor: HTMLElement;
  readonly pointer?: { readonly clientX: number; readonly clientY: number };
  readonly items: readonly ExplorerActionItem[];
  readonly targetKey: string;
  readonly restoreFocusTo?: HTMLElement | (() => HTMLElement | null) | null;
  readonly onSelect: (item: ExplorerActionItem) => void;
  readonly onClose?: () => void;
};

// Accessible, edge-flipping, grouped context/dropdown menu anchored outside re-rendered tree rows.
// Never probes the cluster and cleans up global listeners on close/dispose.
export function createActionMenuManager(document: Document, overlayHost?: HTMLElement) {
  let menu: HTMLElement | undefined;
  let boundTargetKey: string | undefined;
  let restoreTarget: HTMLElement | (() => HTMLElement | null) | null = null;
  let closeCallback: (() => void) | undefined;

  const docView = document.defaultView;

  function clearMenu(restoreFocus: boolean): void {
    if (!menu) return;
    menu.remove();
    menu = undefined;
    boundTargetKey = undefined;
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    document.removeEventListener('keydown', onDocumentKeydown, true);
    docView?.removeEventListener('blur', onWindowBlur);
    const resolvedTarget = restoreFocus
      ? (typeof restoreTarget === 'function' ? restoreTarget() : restoreTarget)
      : null;
    restoreTarget = null;
    const cb = closeCallback;
    closeCallback = undefined;
    cb?.();
    if (resolvedTarget && resolvedTarget.isConnected) resolvedTarget.focus();
  }

  function onOutsidePointer(event: Event): void {
    const target = event.target as Node | null;
    if (menu && target && menu.contains(target)) return;
    clearMenu(false);
  }

  function onWindowBlur(): void {
    clearMenu(false);
  }

  function onDocumentKeydown(event: KeyboardEvent): void {
    if (!menu) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      clearMenu(true);
    } else if (event.key === 'Tab') {
      clearMenu(false);
    }
  }

  function positionMenu(el: HTMLElement, anchor: HTMLElement, pointer?: { readonly clientX: number; readonly clientY: number }): void {
    const viewWidth = docView?.innerWidth || document.documentElement?.clientWidth || 720;
    const viewHeight = docView?.innerHeight || document.documentElement?.clientHeight || 480;
    const rect = anchor.getBoundingClientRect();
    const baseLeft = pointer ? pointer.clientX : rect.left;
    const baseTop = pointer ? pointer.clientY : rect.bottom + 2;

    el.style.maxHeight = `${Math.max(120, viewHeight - 16)}px`;
    el.style.left = `${Math.max(4, baseLeft)}px`;
    el.style.top = `${Math.max(4, baseTop)}px`;

    const menuRect = el.getBoundingClientRect();
    const width = menuRect.width || 220;
    const height = menuRect.height || 200;

    const left = baseLeft + width > viewWidth - 6
      ? Math.max(4, (pointer ? pointer.clientX : rect.right) - width)
      : Math.max(4, baseLeft);
    const top = baseTop + height > viewHeight - 6
      ? Math.max(4, (pointer ? pointer.clientY : rect.top) - height - 2)
      : Math.max(4, baseTop);

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function open(options: ActionMenuOpenOptions): void {
    clearMenu(false);
    if (!options.items.length) return;

    const container = overlayHost ?? document.body ?? document.documentElement;
    if (!container) return;

    const el = document.createElement('div');
    el.className = 'oc-k8s-tree-menu oc-k8s-action-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('tabindex', '-1');

    const buttons: HTMLButtonElement[] = [];
    let lastMajorGroup: string | undefined;

    for (const item of options.items) {
      if (lastMajorGroup !== undefined && item.majorGroup !== lastMajorGroup) {
        const sep = document.createElement('div');
        sep.setAttribute('role', 'separator');
        sep.className = 'oc-k8s-menu-separator';
        el.append(sep);
      }
      lastMajorGroup = item.majorGroup;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'menuitem');
      btn.className = 'oc-k8s-menu-item';
      btn.dataset.command = item.id;
      if (item.destructive) btn.dataset.destructive = 'true';
      if (item.disabled) {
        btn.setAttribute('aria-disabled', 'true');
        btn.classList.add('oc-k8s-menu-item-disabled');
        if (item.disabledReason) btn.title = item.disabledReason;
      }

      const labelSpan = document.createElement('span');
      labelSpan.className = 'oc-k8s-menu-item-label';
      labelSpan.textContent = item.label;
      btn.append(labelSpan);

      if (item.disabled && item.disabledReason) {
        const reasonSpan = document.createElement('span');
        reasonSpan.className = 'oc-k8s-menu-item-reason';
        reasonSpan.textContent = item.disabledReason;
        btn.append(reasonSpan);
      }

      btn.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (item.disabled) return;
        clearMenu(false);
        options.onSelect(item);
      });

      buttons.push(btn);
      el.append(btn);
    }

    el.addEventListener('keydown', event => {
      event.stopPropagation();
      if (!buttons.length) return;
      const activeIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = activeIndex < 0 ? 0 : (activeIndex + 1) % buttons.length;
        buttons[next]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        const prev = activeIndex <= 0 ? buttons.length - 1 : activeIndex - 1;
        buttons[prev]?.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        buttons[0]?.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        buttons[buttons.length - 1]?.focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const current = buttons[activeIndex];
        current?.click();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        clearMenu(true);
      } else if (event.key === 'Tab') {
        clearMenu(false);
      }
    });

    container.append(el);
    menu = el;
    boundTargetKey = options.targetKey;
    restoreTarget = options.restoreFocusTo ?? options.anchor;
    closeCallback = options.onClose;

    positionMenu(el, options.anchor, options.pointer);
    document.addEventListener('pointerdown', onOutsidePointer, true);
    document.addEventListener('keydown', onDocumentKeydown, true);
    docView?.addEventListener('blur', onWindowBlur);

    const firstEnabled = buttons.find(btn => btn.getAttribute('aria-disabled') !== 'true') ?? buttons[0];
    firstEnabled?.focus();
  }

  return {
    open,
    close: (restoreFocus = false) => clearMenu(restoreFocus),
    isOpen: () => !!menu,
    targetKey: () => boundTargetKey,
    reconcileTargets(validKeys: ReadonlySet<string>): void {
      if (boundTargetKey && !validKeys.has(boundTargetKey)) clearMenu(false);
    },
    dispose(): void {
      clearMenu(false);
    },
  };
}
