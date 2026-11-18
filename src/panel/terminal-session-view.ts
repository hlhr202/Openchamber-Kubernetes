import { mountButton, mountSelect, mountTextField } from './controls.ts';
import { phaseLabel } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { SessionClientState } from '../host/session-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import type { SessionTargetState } from '../shared/session-target.ts';
import { sessionActionAvailability } from '../shared/session-target.ts';
import type { DocumentReference } from '../shared/document-protocol.ts';
import { mountSessionTerminalView } from './session-terminal-view.ts';
import { setText, visiblePresentation } from './presentation-update.ts';
export function mountTerminalSessionView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), output = document.createElement('pre');
  section.setAttribute('aria-label', 'Pod terminal'); actions.className = 'configuration-actions'; output.setAttribute('role', 'log');
  output.style.overflowWrap = 'anywhere'; output.style.maxHeight = '16em'; output.style.overflow = 'auto'; output.style.whiteSpace = 'pre-wrap';
  section.append(note, actions, output); container.append(section);
  const targetNote = document.createElement('p'); section.prepend(targetNote);
  const containerSlot = document.createElement('div'); containerSlot.setAttribute('data-scene-runtime-value', ''); actions.append(containerSlot);
  let state: SessionClientState = { phase: 'idle', output: '', dropped: false }, input = '', shell = '/bin/bash';
  let selected: SessionTargetState = { phase: 'idle', containers: [] }, choosing = false;
  let columns = '80', rows = '24';
  const terminal = mountSessionTerminalView(document, section, value => { void bridge()?.terminalWrite(value); });
  const size = () => {
    const width = Number(columns), height = Number(rows);
    return Number.isInteger(width) && width >= 20 && width <= 120 && Number.isInteger(height) && height >= 10 && height <= 40 ? { columns: width, rows: height } : undefined;
  };
  const containerField = mountSelect(containerSlot, { label: 'Container name', value: '', options: [], onChange: value => {
    if (!selected.containers.includes(value)) return;
    choosing = true; paint(); void Promise.resolve(bridge()?.sessionContainer(value)).finally(() => { choosing = false; paint(); });
  } });
  const shellField = mountTextField(actions, { label: 'Container shell executable', value: shell, onChange: value => { shell = value; paint(); } });
  const readContainers = mountButton(actions, { label: 'Read selected Pod containers', variant: 'outline', onClick: () => {
    if (!selected.reference) return; choosing = true; paint();
    void Promise.resolve(bridge()?.sessionTarget(selected.reference, true)).finally(() => { choosing = false; paint(); });
  } });
  const inputField = mountTextField(actions, { label: 'Terminal input (sent to channel 0)', value: '', onChange: value => { input = value; } });
  const columnsField = mountTextField(actions, { label: 'Columns (20–120)', value: columns, onChange: value => { columns = value; paint(); } });
  const rowsField = mountTextField(actions, { label: 'Rows (10–40)', value: rows, onChange: value => { rows = value; paint(); } });
  const resize = mountButton(actions, { label: 'Apply terminal size', variant: 'outline', onClick: () => {
    const value = size(); if (!value) return;
    void bridge()?.terminalWrite('', value).then(accepted => { if (accepted) terminal.resize(value.columns, value.rows); });
  } });
  const open = mountButton(actions, { label: 'Open terminal (pod UID-pinned)', onClick: () => {
    const dimensions = size(); if (selected.container && dimensions) {
      terminal.resize(dimensions.columns, dimensions.rows);
      void bridge()?.openTerminal(selected.container, shell, dimensions);
    }
  } });
  const send = mountButton(actions, { label: 'Send line', onClick: () => { const submitted = input; void bridge()?.terminalWrite(`${submitted}\n`).then(sent => {
    if (sent && input === submitted) { input = ''; inputField.update({ value: '' }); }
  }); } });
  const poll = mountButton(actions, { label: 'Poll output', onClick: () => { void bridge()?.terminalPoll(); } });
  const detach = mountButton(actions, { label: 'Detach (session survives)', variant: 'ghost', onClick: () => { void bridge()?.terminalDetach(); } });
  const reattach = mountButton(actions, { label: 'Reattach existing session', variant: 'outline', onClick: () => { void bridge()?.terminalReattach(); } });
  const close = mountButton(actions, { label: 'Close session', variant: 'outline', onClick: () => { void bridge()?.terminalClose(); } });
  bindScene(section, 'terminal-input', () => ({ input, shell, columns, rows }), value => { input = value.input; shell = value.shell; columns = value.columns ?? '80'; rows = value.rows ?? '24'; paint(); });
  const presentation = visiblePresentation(section, paint);
  function paint() {
    presentation?.painted();
    const zh = locale().startsWith('zh'), busy = state.phase === 'opening';
    setText(note, zh ? '连接所选 Pod 的交互终端。输入会在容器中执行；断开显示不等于停止会话，断线后不自动重连。' : 'Open an interactive terminal in the selected Pod. Input executes in the container. Detaching does not stop the session; disconnections do not reconnect automatically.');
    const reference = selected.reference;
    setText(targetNote, state.id && state.target ? `${state.scope?.context ?? ''} · Pod ${state.target.namespace}/${state.target.podName} · ${state.target.container ?? ''}${state.controlRevoked ? (zh ? ' · 原配置已失效；关闭本地连接不等于撤销容器内命令' : ' · Original scope revoked; local close does not undo remote commands') : ''}`
      : reference ? `${reference.type.kind} ${reference.namespace}/${reference.name}${selected.error ? ` · ${selected.error}` : ''}${selected.phase === 'loading' ? (zh ? ' · 正在读取容器' : ' · Reading containers') : ''}`
      : (zh ? '请从资源树明确选择一个 Pod，再连接终端。' : 'Choose a Pod explicitly from the resource tree first.'));
    containerField.update({ label: zh ? '容器名称' : 'Container name', value: selected.container ?? '', disabled: !!state.id || selected.phase !== 'ready' || choosing,
      options: [{ id: '', label: zh ? '请选择容器' : 'Choose a container' }, ...selected.containers.map(name => ({ id: name, label: name }))] });
    readContainers.update({ label: zh ? '读取所选 Pod 的容器' : 'Read selected Pod containers', disabled: !!state.id || choosing || selected.phase === 'loading' || selected.reference?.type.resource !== 'pods' });
    shellField.update({ label: zh ? '容器内 Shell 路径（不自动探测）' : 'Container shell path (no automatic probe)', disabled: !!state.id || busy });
    columnsField.update({ label: zh ? '列数（20–120）' : 'Columns (20–120)' }); rowsField.update({ label: zh ? '行数（10–40）' : 'Rows (10–40)' });
    inputField.update({ label: zh ? '终端输入' : 'Terminal input' });
    open.update({ label: zh ? '连接终端' : 'Connect terminal', disabled: !size() || !sessionActionAvailability(state, selected, { shell, command: '', ports: '', choosing }).terminal });
    send.update({ label: zh ? '发送此行' : 'Send line', disabled: !state.id || state.kind !== 'terminal' || state.closed === true || state.detached === true || state.controlRevoked === true || state.controlSuspended === true || state.inputBlocked === true });
    resize.update({ label: zh ? '应用终端尺寸' : 'Apply terminal size', disabled: !size() || !state.id || state.kind !== 'terminal' || state.closed === true || state.detached === true || state.controlRevoked === true || state.controlSuspended === true || state.inputBlocked === true });
    poll.update({ label: zh ? '读取原会话输出' : 'Read original session output', disabled: !state.id || state.controlRevoked === true });
    detach.update({ label: zh ? '断开显示（会话继续）' : 'Detach (keep session)', disabled: !state.id || state.closed === true || state.detached === true });
    reattach.update({ label: zh ? '接回原会话（不重新执行）' : 'Reattach existing session (no rerun)', disabled: !state.id || state.closed === true || state.detached !== true || state.controlRevoked === true || state.controlSuspended === true });
    close.update({ label: zh ? '停止会话' : 'Stop session', disabled: !state.id });
    setText(output, `${state.closed ? (zh ? '会话已结束' : 'Session ended') : state.detached ? (zh ? '已断开显示' : 'Detached') : phaseLabel(state.phase, zh)}${state.error ? ` · ${state.error}` : ''}${state.exitCode !== undefined && state.exitCode !== null ? `\n${zh ? '退出码' : 'Exit code'} ${state.exitCode}` : ''}${state.dropped ? (zh ? '\n[输出不完整：缓冲区已满]' : '\n[output dropped: buffer full]') : ''}${state.kind === 'terminal' ? '' : `\n${state.output}`}`);
    terminal.show(state); terminal.paint();
  }
  return { show(value: SessionClientState) {
    state = value;
    // Keep parsing real output even while hidden: the terminal screen/modes
    // must not be reconstructed from a truncated log when the viewer returns.
    terminal.show(value); presentation.changed();
  }, showTarget(value: SessionTargetState) { selected = value; presentation.changed(); }, paint,
    target(reference: DocumentReference | undefined, containers = true) {
      selected = { phase: reference ? 'loading' : 'idle', ...(reference ? { reference } : {}), containers: [] }; paint();
      void bridge()?.sessionTarget(reference, containers);
    },
    dispose() { presentation.dispose(); terminal.dispose(); for (const control of [containerField, readContainers, shellField, inputField, columnsField, rowsField, resize, open, send, poll, detach, reattach, close]) control.dispose(); section.remove(); } };
}
