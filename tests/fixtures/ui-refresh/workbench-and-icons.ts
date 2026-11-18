import { mountWorkbenchSplit } from '../../../src/panel/workbench-split.ts';
import { captureScene, disposeScene, restoreScene, sceneRestoring, onSceneChange } from '../../../src/panel/workspace-scene.ts';
import { createTreeNodeIcon, explorerIcon } from '../../../src/panel/explorer-icons.ts';
import { createTreeRenderer } from '../../../src/panel/tree-renderer.ts';
import { TreeModel } from '../../../src/shared/tree-model.ts';
import type { TreeEntry } from '../../../src/shared/tree-entries.ts';
import { resourceDescriptors } from '../../../src/shared/tree.ts';
import { createPanelLanguage } from '../../../src/panel/i18n.ts';
import type { PanelLocale } from '../../../src/panel/i18n.ts';
import { mountTaskTabs } from '../../../src/panel/task-tabs.ts';

const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const target = { serviceGeneration: 'synthetic', projectId: 'a', configIdentity: 'config', context: 'local', namespace: 'default' };

export async function checkWorkbenchAndIcons() {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:1200px;height:500px;border:0';
  await new Promise<void>(resolve => { frame.onload = () => resolve(); frame.srcdoc = '<!doctype html><html><head></head><body></body></html>'; document.body.append(frame); });
  const doc = frame.contentDocument!, win = frame.contentWindow!;
  const css = doc.createElement('link'); css.rel = 'stylesheet'; css.href = './panel.css';
  await new Promise<void>((resolve, reject) => { css.onload = () => resolve(); css.onerror = () => reject(new Error('Production CSS not loaded in layout frame')); doc.head.append(css); });
  function mount() {
    const root = doc.createElement('div'), explorer = doc.createElement('div'), detail = doc.createElement('div');
    root.id = 'app'; root.style.cssText = '--oc-fg:#202124;--oc-bg:#fff;--oc-border:#999;--oc-focus:#386dde';
    explorer.className = 'oc-k8s-explorer-shell'; explorer.id = 'fixture-explorer';
    detail.className = 'oc-k8s-subview-shell';
    const workbench = doc.createElement('div'); workbench.className = 'oc-k8s-workbench'; workbench.dataset.route = 'content';
    const status = doc.createElement('p'); status.className = 'oc-k8s-namespace-switch-status'; status.textContent = 'Status';
    const split = mountWorkbenchSplit(workbench, explorer), { handle } = split;
    workbench.append(status, explorer, handle, detail); root.append(workbench); doc.body.append(root); sceneRestoring(doc, false);
    const width = () => explorer.getBoundingClientRect().width;
    const press = (key: string) => handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    return { root, workbench, explorer, detail, status, handle, width, press, setLocale: split.setLocale, dispose() { split.dispose(); root.remove(); disposeScene(doc); } };
  }
  const a = mount(), defaultWidth = a.width();
  const saved = () => captureScene(doc, a.root);
  assert(a.handle.getBoundingClientRect().width > 0 && a.handle.getAttribute('aria-controls') === a.explorer.id, 'Wide separator not linked to the explorer');
  assert(a.status.getBoundingClientRect().bottom <= a.detail.getBoundingClientRect().top, 'Status overlaps split panes');
  a.handle.focus();
  a.press('ArrowRight');
  assert(doc.activeElement === a.handle && a.width() > defaultWidth + 45, 'Keyboard did not resize the actual outer frame');
  a.press('End');
  assert(a.detail.getBoundingClientRect().width >= 18.5 * 16, 'Right frame collapsed at max left bound');
  a.press('Home');
  assert(a.width() >= 18 * 16, 'Left frame collapsed at min bound');
  let changes = 0;
  const unsubscribe = onSceneChange(doc, () => { changes++; });
  // Scripted events cannot acquire a native pointer capture; only bypass that browser precondition.
  a.handle.setPointerCapture = () => {};
  const pointer = (type: string, clientX: number) => a.handle.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX, bubbles: true, cancelable: true }));
  const start = a.handle.getBoundingClientRect().left, before = a.width();
  pointer('pointerdown', start);
  pointer('pointermove', start + 100);
  pointer('pointermove', start + 200);
  assert(a.width() > before + 185 && changes === 0, 'Drag did not resize locally or wrote intermediate scenes');
  pointer('pointerup', start + 200);
  assert(changes === 1 && !a.handle.hasAttribute('data-dragging'), 'Drag settlement did not commit exactly once');
  const sceneA = saved(), widthA = a.width();
  frame.style.width = '600px';
  await new Promise<void>(resolve => win.requestAnimationFrame(() => resolve()));
  a.explorer.hidden = true;
  assert(win.getComputedStyle(a.handle).display === 'none' && win.getComputedStyle(a.explorer).display === 'none'
    && a.detail.getBoundingClientRect().width > 550, 'Narrow view did not remain single-column');
  frame.style.width = '1200px';
  await new Promise<void>(resolve => win.requestAnimationFrame(() => resolve()));
  assert(Math.abs(a.width() - widthA) < 1, 'Narrow viewport discarded the saved ratio');
  a.workbench.dataset.route = 'explorer';
  assert(win.getComputedStyle(a.handle).display === 'none', 'Separator remained visible without a detail route');
  unsubscribe(); a.dispose();

  const nextA = mount(); restoreScene(doc, nextA.root, sceneA);
  assert(Math.abs(nextA.width() - widthA) < 1, 'Same project scene lost its split'); nextA.dispose();
  const b = mount(); assert(Math.abs(b.width() - defaultWidth) < 1, 'New project inherited A width');
  b.press('End'); const sceneB = captureScene(doc, b.root), widthB = b.width(); b.dispose();
  const restored = mount(); restoreScene(doc, restored.root, sceneA);
  assert(Math.abs(restored.width() - widthA) < 1 && Math.abs(widthB - widthA) > 50, 'A ratio not restored after B');
  restoreScene(doc, restored.root, sceneB);
  assert(Math.abs(restored.width() - widthB) < 1, 'Project B ratio not independent');

  const host = doc.createElement('div');
  host.style.cssText = '--oc-success-text:#17521f;--oc-error-text:#961c35;--oc-warning-text:#785614;--oc-muted:#606060;--oc-info-text:#31578b';
  restored.detail.append(host);
  const entries: TreeEntry[] = [
    { node: { id: 'k8s', type: 'context', label: 'local', expandable: true, tooltip: 'local', icon: 'kubernetes' }, query: { kind: 'context', target } },
    { node: { id: 'mini', type: 'context', label: 'minikube', expandable: true, tooltip: 'minikube', icon: 'minikube' }, query: { kind: 'context', target } },
    { node: { id: 'secret', type: 'folder', label: 'Secrets', expandable: true }, query: { kind: 'resources', resource: 'secrets', target } },
    { node: { id: 'custom', type: 'folder', label: 'Custom Resources', expandable: true }, query: { kind: 'custom-types', target } },
  ];
  const model = new TreeModel(); model.reset(entries);
  const rowId = (id: string) => model.visible().find(row => row.entry.node.id === id)!.id;
  let locale: PanelLocale = 'en', calls = 0;
  const called = () => { calls++; };
  const renderer = createTreeRenderer(doc, host, { onSelect: called, onExpand: called, onCollapse: called, onMore: called, onKeyboard: called, onCommand: called, locale: () => locale });
  assert(model.expand(rowId('custom'), true), 'Custom branch did not admit its test read');
  assert(model.fail(model.begin(rowId('custom'), false, true)!, 'CRD_LIST_BUDGET_EXCEEDED'), 'CRD failure did not settle');
  const snapshot = { generation: model.generation, rows: model.visible(), message: null,
    roots: { phase: 'ready' as const, total: entries.length, nextOffset: null, error: null, available: true } };
  renderer.render(snapshot);
  const glyph = (id: string) => host.querySelector<SVGSVGElement>(`[data-row-id="${rowId(id)}"] svg.oc-k8s-icon`)!;
  assert(glyph('k8s').querySelector('path')?.getAttribute('d') !== glyph('mini').querySelector('path')?.getAttribute('d'), 'Provider glyphs are indistinguishable');
  assert(glyph('secret').classList.contains('oc-k8s-icon-secret') && glyph('custom').classList.contains('oc-k8s-icon-custom'), 'Semantic glyphs missing');
  const light = win.getComputedStyle(glyph('secret')).color;
  assert(light !== win.getComputedStyle(glyph('custom')).color, 'Resource category colors are indistinguishable');
  restored.root.style.setProperty('--oc-fg', '#eee'); restored.root.style.setProperty('--oc-bg', '#121212');
  assert(win.getComputedStyle(glyph('secret')).color !== light, 'Type color did not follow the theme foreground');
  assert(host.querySelector(`[data-row-id="${rowId('custom')}"] .oc-k8s-tree-badge`)?.textContent === 'CRD list too large', 'Budget stage was not shown to user');
  const { group, version, resource, kind, scope } = resourceDescriptors.deployments;
  for (const [icon, color] of [['workload-ready', 'rgb(23, 82, 31)'], ['workload-error', 'rgb(150, 28, 53)'], ['workload-progressing', 'rgb(120, 86, 20)'],
    ['workload-paused', 'rgb(96, 96, 96)'], ['pod-running', 'rgb(23, 82, 31)'], ['helm-failed', 'rgb(150, 28, 53)']] as const) {
    const name = explorerIcon({ node: { type: 'resource', id: icon, label: icon, expandable: false, icon,
      resource: { group, version, resource, kind, scope, name: 'sample' } }, query: null });
    const svg = createTreeNodeIcon(doc, name, 'resource'); host.append(svg);
    assert(name === icon && win.getComputedStyle(svg).color === color, `Existing ${icon} status color changed`);
  }
  const row = (id: string) => host.querySelector<HTMLElement>(`[data-row-id="${rowId(id)}"]`)!;
  const custom = row('custom'), originalWidth = restored.width();
  const tasks = mountTaskTabs(doc, restored.detail, [{ id: 'files', message: 'task.files' }, { id: 'save', message: 'task.save' }], () => locale);
  tasks.show('save');
  const draft = doc.createElement('textarea'); draft.value = 'kind: Pod'; tasks.slots.save!.append(draft);
  draft.focus(); draft.setSelectionRange(1, 4);
  let repaints = 0;
  const hostLanguage = createPanelLanguage(doc, next => {
    locale = next; repaints++; restored.setLocale(locale); renderer.render(snapshot); tasks.paint();
  });
  hostLanguage('zh-TW');
  assert(custom.querySelector('.oc-k8s-tree-label')?.textContent === '自訂資源', 'Traditional Chinese folder label did not update');
  hostLanguage('fr');
  assert(custom.querySelector('.oc-k8s-tree-label')?.textContent === 'Ressources personnalisées', 'French folder label did not update');
  assert(custom.querySelector('.oc-k8s-tree-badge')?.textContent === 'Liste des CRD trop volumineuse', 'Budget label did not update in place');
  assert(restored.detail.querySelector('option:checked')?.textContent === 'Enregistrer le fichier' && tasks.active === 'save', 'Localized task picker changed the active task');
  hostLanguage('ar');
  hostLanguage('ar-SA');
  assert(repaints === 3 && doc.documentElement.lang === 'ar' && doc.documentElement.dir === 'rtl', 'RTL switch or equivalent snapshot dedupe failed');
  assert(restored.explorer.getBoundingClientRect().left > restored.detail.getBoundingClientRect().left && Math.abs(restored.width() - originalWidth) < 1, 'RTL did not mirror the layout while retaining the split');
  assert(row('custom') === custom && row('k8s').querySelector('.oc-k8s-tree-label')?.textContent === 'local' && custom.getAttribute('aria-expanded') === 'true', 'Locale switch changed tree rows, names or expansion');
  assert(doc.activeElement === draft && draft.value === 'kind: Pod' && draft.selectionStart === 1 && draft.selectionEnd === 4 && win.getComputedStyle(draft).direction === 'ltr', 'Locale switch changed the draft or its direction');
  hostLanguage('en');
  assert(calls === 0 && doc.documentElement.dir === 'ltr', 'Locale update invoked tree actions or failed to restore LTR');
  tasks.dispose(); renderer.dispose(); restored.dispose(); frame.remove();
  return { outerDrag: true, keyboard: true, narrow: true, projectRestore: true, semanticColors: true, originalStatusColors: true, crdBudgetLabel: true, hostLocaleSwitch: true, rtl: true, unchangedDraftAndRow: true };
}
