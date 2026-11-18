// Actual production presentation, real DOM/SDK controls; no bridge or executors.
import { applyHostTheme } from '@openchamber/sdk/ui';
import type { HostTheme } from '@openchamber/sdk';
import { HostSnapshotLifecycle } from '../../../src/host/host-snapshot-lifecycle.ts';
import { mountTaskTabs } from '../../../src/panel/task-tabs.ts';
import { inspectionSyntaxTheme } from '../../../src/shared/presentation-theme.ts';

type View = { paint?: () => void; dispose?: () => void; show?: (state: unknown) => void };
export function runPanelAudit(mounts: Record<string, unknown>): void {
  let locale = 'zh-CN', mode: 'light' | 'dark' = 'dark', scopes = 0, snapshots = 0;
  const lifecycle = new HostSnapshotLifecycle(); lifecycle.ready('/synthetic/project'); scopes++;
  const root = document.getElementById('app')!, container = document.getElementById('audit')!;
  const themes = (): HostTheme => {
    const dark = mode === 'dark';
    return { mode, tokens: { background: dark ? '#121418' : '#fff', foreground: dark ? '#e4e7ed' : '#202631',
      elevated: dark ? '#1b1e24' : '#fff', elevatedForeground: dark ? '#e4e7ed' : '#202631', muted: dark ? '#a1a9b6' : '#596475',
      subtle: dark ? '#687282' : '#707a89', border: dark ? '#303640' : '#d9dee6', hover: dark ? '#222833' : '#f0f3f8',
      selection: dark ? '#263b58' : '#dceaff', selectionForeground: dark ? '#f0f5ff' : '#172f57', focus: dark ? '#8fb8ff' : '#355eac',
      primary: dark ? '#97bfff' : '#315b9f', primaryForeground: dark ? '#111c2e' : '#fff', primaryText: dark ? '#a9c9ff' : '#254f94',
      active: dark ? '#293343' : '#e5ecf7', mutedSurface: dark ? '#191d24' : '#f6f8fb',
      success: '#237346', successText: dark ? '#8fdaad' : '#216b40', warning: '#825514', warningText: dark ? '#edc987' : '#80520e',
      error: '#b63043', errorText: dark ? '#f2a1ab' : '#ae293d', info: '#2c5b9c', infoText: dark ? '#a9c9ff' : '#285593',
      font: 'system-ui, sans-serif', mono: 'ui-monospace, monospace', radius: '6px' } };
  };
  const theme = () => {
    const current = themes(); applyHostTheme(current, root); applyHostTheme(current, document.documentElement);
    document.documentElement.style.fontSize = '16px';
    for (const [name, value] of Object.entries(inspectionSyntaxTheme(current.tokens))) root.style.setProperty(name, value);
  };
  theme();
  const items = Object.keys(mounts).map(id => ({ id, label: id.replace('-view.ts:mount', ' · '), zh: id.replace('-view.ts:mount', ' · ') }));
  const tasks = mountTaskTabs(document, container, items, () => locale), views: View[] = [], failures: string[] = [];
  const empty = { phase: 'error', error: 'SYNTHETIC_DISPLAY_ERROR', code: 'SYNTHETIC_DISPLAY_ERROR', history: [], next: null, canCancel: false, stale: false, text: '', output: '', documents: [], changed: false, dropped: false, complete: false, containers: [], rows: [], truncated: false, synchronizing: true };
  for (const [name, exported] of Object.entries(mounts)) {
    const mount = exported as (doc: Document, slot: HTMLElement, ...args: unknown[]) => View;
    try {
      const args = name.startsWith('preference-') ? [() => undefined, () => ({ mode: 'default' }), () => locale]
        : name.startsWith('log-text-') ? [() => locale, async () => undefined]
          : name.startsWith('log-terminal-') ? [() => locale] : [() => undefined, () => locale];
      const view = mount(document, tasks.slots[name]!, ...args); views.push(view); view.paint?.();
      // Presentation error states only. No prepare/submit/session/auth chain is run.
      if (name.includes('mountSessionsView')) view.show?.({ sessions: [], events: [] });
      else if (name.includes('mountDebugControlView')) view.show?.({ messages: ['Synthetic debug output'] });
      else if (!/tree-view|log-text-view|log-terminal-view/.test(name)) view.show?.({ ...empty });
      view.paint?.();
    } catch (error) { failures.push(`${name}: ${String(error)}`); }
  }
  const logName = items.find(item => item.id.startsWith('pod-log-'))!.id;
  const log = views[items.findIndex(item => item.id === logName)];
  log?.show?.({ ...empty, phase: 'ready', error: undefined, complete: true, containers: [{ name: 'api', kind: 'regular' }], text: 'INFO Started\nERROR Synthetic application stack trace\n'.repeat(200) });
  tasks.show(logName);
  const input = document.createElement('textarea'); input.value = 'Synthetic unsaved draft';
  const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'Synthetic nested details'; details.open = true; details.append(summary, input);
  tasks.slots[logName]!.append(details); input.focus(); input.setSelectionRange(2, 9);
  const initialNodes = [...container.querySelectorAll('*')], initialInputs = [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type=checkbox]):not(:disabled), textarea:not(:disabled)')];
  // Exercise the real SDK wrapper: unrelated paint must not restore stale props.
  for (const field of initialInputs) {
    if (field === input) continue;
    field.value = 'synthetic-draft'; field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const drafts = initialInputs.map(field => field.value);
  for (const view of views) view.paint?.();
  const draftsRetained = initialInputs.every((field, index) => field.value === drafts[index]);
  const overflows: string[] = [];
  function measure() {
    overflows.length = 0;
    const activeTask = tasks.active;
    for (const item of items) {
      tasks.show(item.id);
      const slot = tasks.slots[item.id]!;
      if (slot.scrollWidth > slot.clientWidth + 2) overflows.push(item.id);
    }
    tasks.show(activeTask);
  }
  measure();
  const logViewport = tasks.slots[logName]!.querySelector<HTMLElement>('.log-viewer-output');
  const logScrolls = !!logViewport && logViewport.scrollHeight > logViewport.clientHeight && logViewport.clientHeight <= Math.max(320, window.innerHeight);
  const report = () => {
    document.getElementById('report')!.textContent = JSON.stringify({ modules: new Set(items.map(item => item.id.split(':')[0])).size, mounted: views.length, failures, theme: mode, locale, snapshots, scopeInitializations: scopes, draftsRetained, overflows, logScrolls, width: window.innerWidth, clusterRequests: 0 }, null, 2);
  };
  const repeat = () => {
    const before = [...container.querySelectorAll('*')], active = tasks.active, top = container.scrollTop;
    input.focus(); input.setSelectionRange(2, 9);
    for (let index = 0; index < 100; index++) {
      if (lifecycle.ready('/synthetic/project').projectChanged) scopes++;
      if (lifecycle.directory('/synthetic/project')) scopes++;
      snapshots++; theme();
    }
    const after = [...container.querySelectorAll('*')];
    if (before.length !== after.length || before.some((node, index) => node !== after[index])) failures.push('Repeated snapshot replaced task DOM');
    if (!details.open || input.value !== 'Synthetic unsaved draft' || input.selectionStart !== 2 || input.selectionEnd !== 9 || container.scrollTop !== top || tasks.active !== active) failures.push('Repeated snapshot lost UI state');
    tasks.show(items[0]!.id); tasks.show(active);
    if (!details.open) failures.push('Task switch lost disclosure state');
    report();
  };
  document.getElementById('repeat')!.addEventListener('click', repeat);
  document.getElementById('theme')!.addEventListener('click', () => { mode = mode === 'dark' ? 'light' : 'dark'; theme(); measure(); report(); });
  document.getElementById('locale')!.addEventListener('click', () => { locale = locale === 'zh-CN' ? 'en' : 'zh-CN'; tasks.paint(); for (const view of views) view.paint?.(); measure(); report(); });
  if (!initialNodes.length) failures.push('No mounted presentation nodes');
  repeat();
}
