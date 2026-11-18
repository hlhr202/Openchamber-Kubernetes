// Presentation-only scene state. No service, bridge, business commands, storage,
// HTML snapshots or execution replay. Every binding owns explicit local values.
type Binding = { element: Element; phase: 'model' | 'control'; read(): unknown; write(value: unknown): void };
type SceneReason = 'state' | 'appearance';
type Scene = { bindings: Map<string, Binding>; counts: Map<string, number>; restoring: boolean; lastFocus?: string;
  scrolls: Set<Element>; listeners: Set<(reason: SceneReason) => void> };
const scenes = new WeakMap<Document, Scene>();
function scene(document: Document): Scene {
  let value = scenes.get(document);
  if (!value) { value = { bindings: new Map(), counts: new Map(), restoring: true, scrolls: new Set(), listeners: new Set() }; scenes.set(document, value); }
  return value;
}
export function bindScene<T>(element: Element, name: string, read: () => T, write: (value: T) => void, phase: Binding['phase'] = 'model'): void {
  const value = scene(element.ownerDocument), index = value.counts.get(name) ?? 0;
  value.counts.set(name, index + 1);
  value.bindings.set(`${name}:${index}`, { element, read, write: next => write(next as T), phase });
}
export function isSceneRestoring(document: Document): boolean { return scene(document).restoring; }
export function sceneRestoring(document: Document, value: boolean): void { scene(document).restoring = value; }
export function onSceneChange(document: Document, callback: (reason: SceneReason) => void): () => void {
  const value = scene(document); value.listeners.add(callback); return () => value.listeners.delete(callback);
}
// Explicit model/route/terminal changes only. Renderer DOM churn is not a user edit.
export function sceneChanged(element: Element, reason: SceneReason = 'state'): void {
  const value = scene(element.ownerDocument);
  if (!value.restoring) for (const callback of value.listeners) callback(reason);
}
export function noteSceneScroll(element: Element): void {
  if (!element.closest('[data-scene-renderer]')) scene(element.ownerDocument).scrolls.add(element);
}
function path(root: Element, element: Element): string {
  const parts: number[] = [];
  let node: Element | null = element;
  while (node && node !== root) {
    const parent: Element | null = node.parentElement;
    if (!parent) return '';
    parts.unshift(Array.prototype.indexOf.call(parent.children, node) as number); node = parent;
  }
  return node === root ? parts.join('/') : '';
}
function locate(root: Element, key: string): Element | undefined {
  let current: Element | undefined = root;
  for (const index of key.split('/').filter(Boolean)) current = current?.children[Number(index)];
  return current;
}
export function captureScene(document: Document, root: HTMLElement): Record<string, unknown> {
  const value = scene(document), bindings: Record<string, unknown> = {};
  for (const [key, binding] of value.bindings) {
    if (root.contains(binding.element) && !(binding.phase === 'control' && binding.element.closest('[data-scene-runtime-value]'))) bindings[key] = binding.read();
  }
  const geometry: Record<string, unknown> = {};
  // No walk over thousands of resource rows or xterm cells on each keystroke.
  for (const element of value.scrolls) if (!root.contains(element)) value.scrolls.delete(element);
  const elements = new Set<HTMLElement>([root, ...root.querySelectorAll<HTMLElement>('details,input,textarea,select'),
    ...[...value.scrolls] as HTMLElement[]]);
  for (const element of elements) {
    if (element.closest('[data-scene-renderer]')) continue;
    const key = path(root, element);
    const state: Record<string, unknown> = {};
    if (value.scrolls.has(element) || element.scrollTop || element.scrollLeft) { state.top = element.scrollTop; state.left = element.scrollLeft; }
    if (element.tagName === 'DETAILS') state.open = (element as HTMLDetailsElement).open;
    if (element.matches('input, textarea, select')) {
      const control = element as HTMLInputElement;
      if (control.type !== 'password' && !control.closest('[data-scene-runtime-value]')) state.value = control.value;
      if (control.type === 'checkbox') state.checked = control.checked;
      if (element.matches('input, textarea')) {
        state.start = control.selectionStart; state.end = control.selectionEnd; state.direction = control.selectionDirection;
      }
    }
    if (Object.keys(state).length) geometry[key] = { ...state, tag: element.tagName, label: element.getAttribute('aria-label') };
  }
  if (document.activeElement && root.contains(document.activeElement)) value.lastFocus = path(root, document.activeElement);
  // Switching a host tab blurs the iframe before it is removed. That blur is
  // not an instruction to erase the last meaningful workspace focus.
  return { bindings, geometry, focus: value.lastFocus };
}
export function restoreScene(document: Document, root: HTMLElement, input: Record<string, unknown>): void {
  const value = scene(document), bindings = input.bindings as Record<string, unknown> | undefined;
  value.restoring = true;
  for (const phase of ['model', 'control'] as const) {
    for (const [key, binding] of value.bindings) {
      if (binding.phase === phase && !(phase === 'control' && binding.element.closest('[data-scene-runtime-value]')) && bindings && Object.hasOwn(bindings, key)) binding.write(bindings[key]);
    }
  }
  const geometry = input.geometry as Record<string, Record<string, unknown>> | undefined;
  const positions: { element: HTMLElement; top: number; left: number }[] = [];
  for (const [key, state] of Object.entries(geometry ?? {})) {
    const element = locate(root, key) as HTMLElement | undefined; if (!element) continue;
    if (state.tag && (state.tag !== element.tagName || state.label !== element.getAttribute('aria-label'))) continue;
    if (element.tagName === 'DETAILS' && typeof state.open === 'boolean') (element as HTMLDetailsElement).open = state.open;
    if (element.matches('input, textarea, select')) {
      const control = element as HTMLInputElement;
      if (typeof state.value === 'string' && control.type !== 'password' && !control.closest('[data-scene-runtime-value]')) control.value = state.value;
      if (typeof state.checked === 'boolean' && control.type === 'checkbox') control.checked = state.checked;
      if (typeof state.start === 'number' && typeof state.end === 'number' && element.matches('textarea, input:not([type=checkbox])')) {
        try { control.setSelectionRange(state.start, state.end, state.direction as 'forward' | 'backward' | 'none'); } catch { /* Non-text input has no text selection. */ }
      }
    }
    positions.push({ element, top: typeof state.top === 'number' ? state.top : 0, left: typeof state.left === 'number' ? state.left : 0 });
    if (typeof state.top === 'number' || typeof state.left === 'number') value.scrolls.add(element);
  }
  // Parent paths such as "1" enumerate before "1/0": restore ALL nested
  // disclosures first or a parent's saved scroll is clamped to the closed height.
  for (const position of positions) { position.element.scrollTop = position.top; position.element.scrollLeft = position.left; }
  if (typeof input.focus === 'string') {
    value.lastFocus = input.focus;
    (locate(root, input.focus) as HTMLElement | undefined)?.focus({ preventScroll: true });
  }
}
export function disposeScene(document: Document): void { scenes.delete(document); }
