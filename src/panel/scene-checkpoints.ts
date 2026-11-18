import { captureScene, isSceneRestoring, onSceneChange, noteSceneScroll } from './workspace-scene.ts';

// Presentation state only. No bridge, host, transport, task or execution callback.
// Model deltas and user intent drive checkpoints; rendered DOM mutations do not.
export function mountSceneCheckpoints(root: HTMLElement, active: () => boolean, accept: (scene: Record<string, unknown>) => void) {
  const document = root.ownerDocument;
  let timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
  const enabled = () => !disposed && active() && !isSceneRestoring(document);
  const flush = () => {
    if (timer) clearTimeout(timer); timer = undefined;
    if (enabled()) accept(captureScene(document, root));
  };
  const checkpoint = () => {
    if (!enabled() || timer) return;
    // A bounded window, not a trailing debounce that starves continuous typing.
    timer = setTimeout(flush, 120);
  };
  const scroll = (event: Event) => {
    const element = event.target as HTMLElement | null;
    if (element && typeof element.closest === 'function') {
      if (element.closest('[data-scene-renderer]')) return;
      noteSceneScroll(element);
    }
    checkpoint();
  };
  const events = ['input', 'change', 'click', 'toggle', 'pointerup', 'keyup'] as const;
  let selected: Element | null = null, range = '';
  const selection = () => {
    const element = document.activeElement as HTMLInputElement | null;
    if (element && root.contains(element) && element.matches('input,textarea') && !element.closest('[data-scene-renderer]')) {
      const next = `${element.selectionStart}:${element.selectionEnd}:${element.selectionDirection}`;
      if (selected !== element || next !== range) { selected = element; range = next; checkpoint(); }
      return;
    }
    // Replacing renderer text can fire a BODY selectionchange even when the
    // user selected nothing. It must not become another scene checkpoint.
    const value = document.getSelection();
    if (value && !value.isCollapsed && (root.contains(value.anchorNode) || root.contains(value.focusNode))) checkpoint();
  };
  for (const event of events) root.addEventListener(event, checkpoint, true);
  root.addEventListener('scroll', scroll, true);
  document.addEventListener('selectionchange', selection);
  const stop = onSceneChange(document, reason => { if (reason === 'state') checkpoint(); });
  return { checkpoint, flush, dispose() {
    disposed = true; if (timer) clearTimeout(timer);
    for (const event of events) root.removeEventListener(event, checkpoint, true);
    root.removeEventListener('scroll', scroll, true); document.removeEventListener('selectionchange', selection); stop();
  } };
}
