import { Terminal } from '@xterm/xterm';
import { mountButton } from '@openchamber/sdk/ui';
import { LogTerminalOutput } from '../host/log-terminal-output.ts';
import { LogOutputProducer } from '../host/log-output-producer.ts';
import type { PodLogState } from '../host/pod-log-client.ts';
import type { LogFollowState } from '../host/log-follow-client.ts';
import type { LogTerminalStatus } from '../host/log-terminal-output.ts';
import { BoundaryError } from '../shared/errors.ts';
import { phaseLabel } from './presentation.ts';
// Local output-only xterm. No onData/onBinary/input/paste, socket, CLI, session, PTY or writable capability.
export function mountLogTerminalView(document: Document, container: HTMLElement, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), status = document.createElement('p'), shell = document.createElement('div'), surface = document.createElement('div');
  shell.className = 'log-terminal-shell'; surface.className = 'log-terminal-surface'; shell.append(surface); status.setAttribute('role', 'status'); section.append(note, status, shell); container.append(section);
  let terminal: Terminal | undefined, consumer: LogTerminalOutput | undefined, latest: LogTerminalStatus = { masked: true }, enabled = false, disposed = false, scrollbackLimited = false;
  const producer = new LogOutputProducer();
  let theme = '';
  const failure = (error: unknown) => { const code = error instanceof BoundaryError && ['BUDGET_EXCEEDED', 'STALE_TARGET'].includes(error.code) ? error.code as 'BUDGET_EXCEEDED' | 'STALE_TARGET' : 'STATE_UNAVAILABLE';
    if (consumer) consumer.fail(code); else { latest = { masked: true, error: code }; paint(); } };
  const bottom = mountButton(section, { label: 'Terminal bottom', variant: 'outline', onClick: () => terminal?.scrollToBottom() });
  function paint() {
    if (disposed) return; const zh = locale().startsWith('zh'); section.hidden = !enabled;
    note.textContent = zh ? '只读日志视图，不是容器 Shell。滚动窗口有限，较早内容可能已移出。' : 'Read-only logs, not a container shell. The scrollback window is limited; earlier output may have been removed.';
    const frame = latest.frame; status.textContent = latest.error ?? `${phaseLabel(frame?.phase ?? 'idle', zh)}${frame?.error ? ` · ${frame.error}` : ''}${frame?.partial || scrollbackLimited ? (zh ? ' · 部分日志，较早内容可能已移出' : ' · Partial logs; earlier output may be outside the window') : ''}${frame ? ` · ${frame.source.target.context}/${frame.source.reference.namespace}/${frame.source.reference.name}/${frame.source.container}` : ''}`;
    surface.style.visibility = latest.masked ? 'hidden' : 'visible'; bottom.update({ label: zh ? '终端到底部' : 'Terminal bottom' });
    if (terminal) {
      const style = document.defaultView?.getComputedStyle(container), foreground = style?.color ?? '#d0d0d0',
        background = style?.getPropertyValue('--oc-bg').trim() || '#202020', key = `${foreground}\0${background}`;
      if (theme !== key) { theme = key; terminal.options.theme = { foreground, background }; }
    }
  }
  function ensure() {
    if (terminal || !enabled || disposed) return;
    Terminal.strings = { promptLabel: locale().startsWith('zh') ? '只读日志终端输出，无输入' : 'Read-only log terminal output, no input', tooMuchOutput: locale().startsWith('zh') ? '输出过多，朗读已限制。' : 'Too much output; speech is limited.' };
    terminal = new Terminal({ cols: 80, rows: 24, scrollback: 512, disableStdin: true, convertEol: true, allowProposedApi: false, altClickMovesCursor: false,
      cursorBlink: false, cursorInactiveStyle: 'none', screenReaderMode: true, logLevel: 'off', windowOptions: {}, linkHandler: { activate() {} } });
    theme = ''; terminal.open(surface); terminal.textarea?.setAttribute('aria-readonly', 'true'); const value = terminal;
    consumer = new LogTerminalOutput({ write: (text, done) => value.write(text, () => { if (!disposed && value === terminal) { if (value.buffer.active.length >= 536) scrollbackLimited = true; done(); paint(); } }), reset: () => { scrollbackLimited = false; value.reset(); }, dispose: () => value.dispose() }, next => { latest = next; paint(); }); paint();
  }
  return {
    setEnabled(value: boolean) { enabled = value; paint(); if (value) ensure(); else { producer.reset(); consumer?.dispose(); consumer = undefined; terminal = undefined; scrollbackLimited = false; latest = { masked: true }; } },
    snapshot(state: PodLogState) { if (!enabled) return; ensure(); try { const frame = producer.snapshot(state); if (frame) consumer?.accept(frame); else consumer?.clear(); } catch (error) { failure(error); } },
    follow(state: LogFollowState) { if (!enabled) return; ensure(); try { const frame = producer.follow(state); if (frame) consumer?.accept(frame); else consumer?.clear(); } catch (error) { failure(error); } },
    paint, dispose() { disposed = true; producer.reset(); consumer?.dispose(); consumer = undefined; terminal = undefined; bottom.dispose(); section.remove(); },
  };
}
