// M5/M7 session management + DAP debug control views. Structured rendering of the session
// registry (id/kind/target/state/lease + event history) with owner-gated stop (only sessions
// whose capability this client holds), and the DAP control surface (pause/continue/step/
// stack/variables/breakpoints) over the fixed debug-send whitelist. No auto-reconnect, no
// replay, no free-form adapter payloads.
import { mountButton, mountTextField } from './controls.ts';
import { bindScene } from './workspace-scene.ts';
import type { SessionClientState } from '../host/session-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export type SessionRow = { id: string; kind: string; target: { namespace: string; podName?: string; podUid?: string; container?: string; original?: { resource: string; namespace: string; name: string } }; detached: boolean; closed: boolean; leaseExpiresAt: number; forwarded?: readonly { local: number; remote: number }[] };
export type SessionEventRow = { id: string; kind: string; reason: string; at: number };
export function mountSessionsView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), table = document.createElement('table'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Sessions'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  table.className = 'configuration-results';
  section.append(note, actions, table, status); container.append(section);
  let rows: readonly SessionRow[] = [], events: readonly SessionEventRow[] = [], gateText = '', listError = '', ownSession: SessionClientState | undefined;
  const refresh = mountButton(actions, { label: 'Refresh session list', onClick: () => { void bridge()?.sessionsOverview(); } });
  const gate = mountButton(actions, { label: 'Read stop-gate status', variant: 'outline', onClick: () => { void bridge()?.stopGateStatus(); } });
  const stopOwn = mountButton(actions, { label: 'Stop own session (owner capability)', variant: 'outline', onClick: () => { void bridge()?.sessionClose(); } });
  function paint() {
    const zh = locale().startsWith('zh');
    note.textContent = zh ? '查看终端、转发和调试会话。只能停止当前面板持有的自有会话。' : 'View terminal, forwarding and debug sessions. Only sessions owned by this panel can be stopped here.';
    refresh.update({ label: zh ? '刷新会话' : 'Refresh sessions', disabled: false });
    gate.update({ label: zh ? '检查运行中操作' : 'Check active operations' });
    stopOwn.update({ label: zh ? '停止自有会话' : 'Stop owned session', disabled: !ownSession?.id });
    const head = document.createElement('tr');
    for (const text of zh ? ['ID', '类型', '目标', '状态', 'Lease'] : ['ID', 'Kind', 'Target', 'State', 'Lease']) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = text; head.append(cell); }
    const body = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      const target = `${row.target.original ? `${row.target.original.resource} ${row.target.original.namespace}/${row.target.original.name} → ` : ''}${row.target.podName ? `${row.target.namespace}/${row.target.podName}${row.target.container ? `:${row.target.container}` : ''}` : row.target.namespace}${row.forwarded?.length ? ` · ${row.forwarded.map(port => `${port.local}:${port.remote}`).join(', ')}` : ''}`;
      for (const text of [row.id.slice(0, 8), row.kind, target, row.closed ? (zh ? '已关闭' : 'Closed') : row.detached ? (zh ? '已断开显示' : 'Detached') : (zh ? '运行中' : 'Live'), new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en', { dateStyle: 'short', timeStyle: 'medium' }).format(row.leaseExpiresAt)]) { const cell = document.createElement('td'); cell.textContent = text; tr.append(cell); }
      body.append(tr);
    }
    table.replaceChildren(document.createElement('caption'), head.parentElement ?? head, body);
    const caption = table.querySelector('caption'); if (caption) caption.textContent = zh ? '会话清单（只读）' : 'Sessions (read-only)';
    status.textContent = `${listError ? `${zh ? '读取失败，保留上次清单' : 'Read failed; showing previous list'} · ${listError}\n` : ''}${rows.length} sessions · ${events.length} events${gateText ? `\nstop-gate: ${gateText}` : ''}${events.length ? `\n${events.slice(-5).map(event => `${event.kind} ${event.reason}`).join('\n')}` : ''}`;
  }
  return { show(value: { sessions: readonly SessionRow[]; events: readonly SessionEventRow[]; error?: string }) { rows = value.sessions; events = value.events; listError = value.error ?? ''; paint(); },
    owned(value: SessionClientState) {
      const changed = !!ownSession?.id !== !!value.id; ownSession = value;
      if (changed) stopOwn.update({ disabled: !value.id });
    },
    setGate(value: { sessions: { live: number; detached: number; closed: number }; writes: Record<string, Record<string, number>> }) {
      const busyWrites = Object.entries(value.writes).filter(([, phases]) => (phases.inFlight ?? 0) > 0 || (phases.unknown ?? 0) > 0);
      gateText = `sessions live ${value.sessions.live} detached ${value.sessions.detached} closed ${value.sessions.closed}${busyWrites.length ? ` · writes in-flight/unknown: ${busyWrites.map(([name, phases]) => `${name} ${phases.inFlight ?? 0}/${phases.unknown ?? 0}`).join(', ')}` : ' · no in-flight/unknown writes'}`;
      paint();
    },
    gateError(code: string) { gateText = `Unavailable: ${code}`; paint(); },
    paint, dispose() { for (const control of [refresh, stopOwn, gate]) control.dispose(); section.remove(); } };
}
export function mountDebugControlView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), output = document.createElement('pre');
  section.setAttribute('aria-label', 'DAP debug control'); actions.className = 'configuration-actions';
  output.setAttribute('role', 'log'); output.style.overflowWrap = 'anywhere'; output.style.maxHeight = '14em'; output.style.overflow = 'auto'; output.style.whiteSpace = 'pre-wrap';
  section.append(note, actions, output); container.append(section);
  let lines: readonly string[] = [], line = '10';
  bindScene(section, 'debug-display', () => ({ line }), value => { line = value.line; paint(); });
  const lineField = mountTextField(actions, { label: 'Breakpoint line (1..100000)', value: line, onChange: value => { line = value; } });
  const breakpoint = mountButton(actions, { label: 'setBreakpoints (line)', onClick: () => { const parsed = /^\d+$/.test(line) ? Number(line) : 0; if (parsed >= 1) void bridge()?.debugSend('setBreakpoints', { lines: [parsed] }); } });
  const pause = mountButton(actions, { label: 'pause', onClick: () => { void bridge()?.debugSend('pause'); } });
  const cont = mountButton(actions, { label: 'continue', onClick: () => { void bridge()?.debugSend('continue'); } });
  const next = mountButton(actions, { label: 'next (step over)', onClick: () => { void bridge()?.debugSend('next'); } });
  const stepIn = mountButton(actions, { label: 'stepIn', onClick: () => { void bridge()?.debugSend('stepIn'); } });
  const stepOut = mountButton(actions, { label: 'stepOut', onClick: () => { void bridge()?.debugSend('stepOut'); } });
  const stack = mountButton(actions, { label: 'stackTrace', onClick: () => { void bridge()?.debugSend('stackTrace'); } });
  const variables = mountButton(actions, { label: 'variables', onClick: () => { void bridge()?.debugSend('variables'); } });
  const poll = mountButton(actions, { label: 'Poll DAP messages', variant: 'outline', onClick: () => { void bridge()?.debugPoll(); } });
  function paint() {
    const zh = locale().startsWith('zh');
    note.textContent = zh ? '控制当前调试会话，查看调用栈和变量。暂停、继续和单步会影响被调试的进程。' : 'Control the current debug session and inspect stacks and variables. Pausing, continuing and stepping affect the debugged process.';
    lineField.update({ label: zh ? '断点行号' : 'Breakpoint line' }); breakpoint.update({ label: zh ? '设置断点' : 'Set breakpoint' });
    pause.update({ label: zh ? '暂停' : 'Pause' }); cont.update({ label: zh ? '继续' : 'Continue' });
    next.update({ label: zh ? '单步跳过' : 'Step over' }); stepIn.update({ label: zh ? '单步进入' : 'Step in' }); stepOut.update({ label: zh ? '单步跳出' : 'Step out' });
    stack.update({ label: zh ? '调用栈' : 'Stack trace' }); variables.update({ label: zh ? '变量' : 'Variables' }); poll.update({ label: zh ? '读取调试输出' : 'Read debug output' });
    output.textContent = lines.slice(-24).join('\n');
  }
  return { show(value: { messages: readonly string[] }) { lines = value.messages; paint(); },
    paint, dispose() { for (const control of [lineField, breakpoint, pause, cont, next, stepIn, stepOut, stack, variables, poll]) control.dispose(); section.remove(); } };
}
