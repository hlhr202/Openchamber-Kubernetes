import { bindScene, sceneChanged } from './workspace-scene.ts';
import { panelText } from './i18n.ts';
import type { PanelLocale } from './i18n.ts';

const defaultPercent = 30;
const maxPercent = 65;

export function mountWorkbenchSplit(workbench: HTMLElement, explorer: HTMLElement) {
  const { ownerDocument: document } = workbench, window = document.defaultView!;
  const handle = document.createElement('div');
  handle.className = 'oc-k8s-workbench-split';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-controls', explorer.id);
  let percent = defaultPercent;
  let drag: { id: number; initial: number; startX: number; startPercent: number; width: number } | undefined;
  const controller = new AbortController(), { signal } = controller;
  const rtl = () => window.getComputedStyle(workbench).direction === 'rtl';
  const bounds = () => {
    const width = workbench.clientWidth;
    const rem = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
    const min = width ? Math.ceil(Math.min(40, 1800 * rem / width)) : 0;
    const max = width ? Math.floor(Math.min(maxPercent, Math.max(40, 100 - 1925 * rem / width))) : maxPercent;
    return [min, max] as const;
  };
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const updateAria = () => {
    const [min, max] = bounds();
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(clamp(percent, min, max)));
  };
  const apply = (value: number) => {
    percent = value;
    workbench.style.setProperty('--oc-k8s-explorer-width', `${value}%`);
    updateAria();
  };
  bindScene(workbench, 'workbench-layout', () => ({ percent }), value => {
    apply(typeof value?.percent === 'number' && Number.isFinite(value.percent) ? clamp(Math.round(value.percent), 0, maxPercent) : defaultPercent);
  });
  const update = (value: number) => {
    const next = clamp(Math.round(value), ...bounds());
    if (next !== percent) apply(next);
  };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag || !workbench.clientWidth) return;
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, initial: percent, startX: event.clientX,
      startPercent: explorer.getBoundingClientRect().width / workbench.clientWidth * 100, width: workbench.clientWidth };
    handle.dataset.dragging = 'true';
    event.preventDefault();
  }, { signal });
  handle.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId || !handle.getClientRects().length) return;
    const delta = (event.clientX - drag.startX) * (rtl() ? -1 : 1);
    if (delta || percent !== drag.initial) update(drag.startPercent + delta / drag.width * 100);
  }, { signal });
  const end = (event: PointerEvent) => {
    if (drag?.id !== event.pointerId) return;
    const initial = drag.initial;
    drag = undefined;
    delete handle.dataset.dragging;
    if (initial !== percent) sceneChanged(workbench);
  };
  handle.addEventListener('pointerup', end, { signal });
  handle.addEventListener('pointercancel', end, { signal });
  handle.addEventListener('lostpointercapture', end, { signal });
  handle.addEventListener('keydown', event => {
    const [min, max] = bounds();
    const current = clamp(percent, min, max);
    const next = event.key === 'Home' ? min : event.key === 'End' ? max : event.key === 'ArrowLeft' || event.key === 'ArrowRight'
      ? clamp(current + (event.key === 'ArrowRight' ? 5 : -5) * (rtl() ? -1 : 1), min, max) : current;
    if (!['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    if (next !== current) { apply(next); sceneChanged(workbench); }
  }, { signal });
  const resize = new window.ResizeObserver(updateAria);
  resize.observe(workbench);
  const setLocale = (locale: PanelLocale) => handle.setAttribute('aria-label', panelText(locale, 'explorer.resize'));
  setLocale('en');
  apply(defaultPercent);
  return { handle, setLocale, dispose() { controller.abort(); resize.disconnect(); } };
}
