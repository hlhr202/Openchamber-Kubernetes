export type TaskTab = { readonly id: string } & ({ readonly label: string; readonly zh: string } | { readonly message: PanelMessage });
import { bindScene, sceneChanged } from './workspace-scene.ts';
import { panelLocale, panelText } from './i18n.ts';
import type { PanelMessage } from './i18n.ts';

// Switch visibility, never unmount. Drafts, native <details>, scroll, selection,
// output and sessions belong to their mounted task, not the currently visible tab.
// Selecting a tab never calls a service or starts an operation.
export function mountTaskTabs(document: Document, container: HTMLElement, items: readonly TaskTab[], locale: () => string) {
  const section = document.createElement('div'), label = document.createElement('label'), text = document.createElement('span'), select = document.createElement('select');
  section.className = 'oc-k8s-task-deck'; label.className = 'oc-k8s-task-picker'; select.className = 'oc-k8s-task-select';
  label.append(text, select); section.append(label); container.append(section);
  const slots: Record<string, HTMLElement> = {}, scroll = new Map<string, { top: number; left: number }>();
  for (const item of items) {
    const slot = document.createElement('div'); slot.className = 'oc-k8s-task-content'; slot.dataset.task = item.id;
    slots[item.id] = slot; section.append(slot);
  }
  let active = items[0]?.id ?? '';
  function paint() {
    const language = panelLocale(locale()), zh = language.startsWith('zh');
    text.textContent = panelText(language, 'task.current');
    // Keep the select itself mounted and do not change it during ordinary paints.
    const labels = items.map(item => 'message' in item ? panelText(language, item.message) : zh ? item.zh : item.label);
    if ([...select.children].map(option => option.textContent).join('\n') !== labels.join('\n')) {
      select.replaceChildren(...items.map((item, index) => {
        const option = document.createElement('option'); option.value = item.id; option.textContent = labels[index] ?? ''; return option;
      }));
    }
    select.value = active;
    for (const [key, slot] of Object.entries(slots)) slot.hidden = key !== active;
  }
  function show(id: string): void {
    if (!slots[id] || id === active) return;
    const viewport = container.closest<HTMLElement>('.oc-k8s-subview-shell') ?? container;
    scroll.set(active, { top: viewport.scrollTop, left: viewport.scrollLeft });
    active = id; paint();
    const position = scroll.get(id);
    viewport.scrollTop = position?.top ?? 0; viewport.scrollLeft = position?.left ?? 0;
    sceneChanged(section);
  }
  const changed = () => show(select.value);
  select.addEventListener('change', changed); paint();
  bindScene(section, 'task-tabs', () => ({ active, scroll: [...scroll] }), value => {
    if (!slots[value.active]) return;
    active = value.active; scroll.clear(); for (const [key, position] of value.scroll) scroll.set(key, position); paint();
  });
  return { slots, show, paint, get active() { return active; }, dispose() { select.removeEventListener('change', changed); scroll.clear(); section.remove(); } };
}
