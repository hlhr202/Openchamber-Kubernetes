import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { bindScene, sceneChanged } from './workspace-scene.ts';
import { terminalOutputDelta, terminalScreenSchema } from '../shared/session-terminal-output.ts';
import type { TerminalOutputCursor } from '../shared/session-terminal-output.ts';
import type { SessionClientState } from '../host/session-client.ts';

// Presentation only. The caller owns input dispatch; this view owns no session,
// reconnect, lease, shell probe or close. Rehydrating a screen never sends input.
export function mountSessionTerminalView(document: Document, container: HTMLElement, input: (value: string) => void) {
  const shell = document.createElement('div'), surface = document.createElement('div');
  shell.className = 'log-terminal-shell'; surface.className = 'log-terminal-surface';
  surface.setAttribute('data-scene-runtime-value', ''); surface.setAttribute('data-scene-renderer', ''); shell.append(surface); container.append(shell); shell.hidden = true;
  let terminal: Terminal | undefined, serializer: SerializeAddon | undefined, subscription: { dispose(): void } | undefined;
  let latest: SessionClientState | undefined, cursor: TerminalOutputCursor | undefined, writing = false, replaying = false, disposed = false;
  type Screen = { id: string; end: number; vt: string; columns: number; rows: number; viewport: number;
    selection?: { start: { x: number; y: number }; end: { x: number; y: number } }; focused: boolean };
  let restore: Screen | undefined;
  let committed: Screen | undefined;
  let screenDirty = true, vt = '', theme = '';
  const subscriptions: { dispose(): void }[] = [];
  let columns = 80, rows = 24;
  const writable = () => latest?.kind === 'terminal' && !!latest.id && !latest.closed && !latest.detached && !latest.controlRevoked && !latest.controlSuspended && !latest.inputBlocked && latest.error !== 'OPERATION_UNKNOWN';
  const enable = () => { if (terminal) terminal.options.disableStdin = replaying || !writable(); };
  function ensure() {
    if (terminal || disposed) return;
    terminal = new Terminal({ cols: columns, rows, scrollback: 128, disableStdin: true, convertEol: false,
      allowProposedApi: false, altClickMovesCursor: false, cursorBlink: true, screenReaderMode: true,
      logLevel: 'off', windowOptions: {}, linkHandler: { activate() {} } });
    serializer = new SerializeAddon(); terminal.loadAddon(serializer); terminal.open(surface);
    terminal.textarea?.setAttribute('aria-label', 'Container terminal input');
    subscription = terminal.onData(value => { if (!replaying && writable()) input(value); });
    subscriptions.push(terminal.onScroll(() => sceneChanged(shell)), terminal.onSelectionChange(() => sceneChanged(shell)));
  }
  function viewport(value: Screen) {
    if (!terminal) return;
    terminal.scrollToLine(Math.min(value.viewport, terminal.buffer.active.baseY));
    if (value.selection) {
      const { start, end } = value.selection;
      const length = (end.y - start.y) * terminal.cols + end.x - start.x;
      if (length > 0 && start.y < terminal.buffer.active.length) terminal.select(start.x, start.y, length);
    }
    if (value.focused) terminal.focus();
  }
  function pump() {
    if (disposed || writing || !terminal || !latest?.id || latest.kind !== 'terminal') return;
    const value = terminal;
    if (restore) {
      const saved = restore; restore = undefined;
      if (saved.id === latest.id) {
        replaying = true; enable(); writing = true;
        columns = saved.columns; rows = saved.rows;
        value.reset(); value.resize(saved.columns, saved.rows);
        value.write(saved.vt, () => {
          if (disposed || terminal !== value) return;
          cursor = { id: saved.id, end: saved.end };
          viewport(saved); writing = false; vt = saved.vt; screenDirty = false; committed = saved; replaying = false; enable(); pump(); sceneChanged(shell);
        });
        return;
      }
    }
    const next = terminalOutputDelta(cursor, { id: latest.id, outputStart: latest.outputStart ?? 0, output: latest.output });
    if (!next.reset && !next.text) { enable(); return; }
    // A new viewer has no trusted screen yet. Disable device-status replies
    // while restoring retained bytes; live deltas may reply only to the same owner.
    replaying = next.reset; enable();
    if (next.reset) value.reset();
    writing = true;
    value.write(next.text, () => {
      if (disposed || terminal !== value) return;
      cursor = next.cursor; writing = false; screenDirty = true; replaying = false; enable(); pump(); sceneChanged(shell);
    });
  }
  function capture(): Screen | undefined {
    if (!terminal || !serializer || !cursor) return restore;
    if (writing) return committed;
    const selection = terminal.getSelectionPosition();
    if (screenDirty) { vt = serializer.serialize({ scrollback: 128 }); screenDirty = false; }
    const screen = { id: cursor.id, end: cursor.end, vt,
      columns: terminal.cols, rows: terminal.rows, viewport: terminal.buffer.active.viewportY,
      ...(selection ? { selection } : {}), focused: document.activeElement === terminal.textarea };
    if (!terminalScreenSchema.safeParse(screen).success) return undefined;
    committed = screen; return screen;
  }
  bindScene(shell, 'interactive-terminal-screen', capture, value => {
    if (!terminalScreenSchema.safeParse(value).success) return;
    restore = value;
    if (value && latest?.id === value.id) { ensure(); pump(); }
  });
  return {
    show(state: SessionClientState) {
      latest = state;
      const hidden = state.kind !== 'terminal' || !state.id; if (shell.hidden !== hidden) shell.hidden = hidden;
      if (shell.hidden) { if (terminal) terminal.options.disableStdin = true; return; }
      ensure(); enable(); pump();
    },
    resize(width: number, height: number) {
      if (width >= 20 && width <= 120 && height >= 10 && height <= 40 && (columns !== width || rows !== height)) {
        columns = width; rows = height; terminal?.resize(columns, rows); screenDirty = true; sceneChanged(shell);
      }
    },
    paint() {
      if (!terminal) return;
      const style = document.defaultView?.getComputedStyle(container);
      const foreground = style?.color ?? '#d0d0d0', background = style?.getPropertyValue('--oc-bg').trim() || '#202020', key = `${foreground}\0${background}`;
      if (theme !== key) { theme = key; terminal.options.theme = { foreground, background }; }
    },
    dispose() { disposed = true; subscription?.dispose(); for (const value of subscriptions) value.dispose(); terminal?.dispose(); terminal = undefined; serializer = undefined; shell.remove(); },
  };
}
