import { onSceneChange } from './workspace-scene.ts';
export function setText(element: Element, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
// Defers presentation only, never task work or memory ownership.
export function visiblePresentation(element: Element, paint: () => void) {
  let dirty = false;
  const flush = () => {
    if (dirty && element.isConnected && !element.closest('[hidden]')) { dirty = false; paint(); }
  };
  const stop = onSceneChange(element.ownerDocument, reason => { if (reason === 'appearance') dirty = true; flush(); });
  return { changed() { dirty = true; flush(); }, painted() { dirty = false; }, dispose: stop };
}
