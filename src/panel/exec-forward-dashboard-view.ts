import { mountButton, mountSelect, mountTextField } from './controls.ts';
import { phaseLabel } from './presentation.ts';
import { mountTaskTabs } from './task-tabs.ts';
import { bindScene } from './workspace-scene.ts';
import type { SessionClientState } from '../host/session-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { forwardSelectionKey, parseSessionPorts, parseSessionCommand, sessionActionAvailability } from '../shared/session-target.ts';
import type { SessionTargetState } from '../shared/session-target.ts';
import { documentReferenceId } from '../shared/document-protocol.ts';
import type { DocumentReference } from '../shared/document-protocol.ts';
import { suggestedForwardMapping } from '../shared/forward-port-hints.ts';
import { setText, visiblePresentation } from './presentation-update.ts';
export function mountExecForwardDashboardView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), output = document.createElement('pre');
  section.setAttribute('aria-label', 'Exec, port forward and dashboard'); actions.className = 'configuration-actions';
  output.setAttribute('role', 'log'); output.style.overflowWrap = 'anywhere'; output.style.maxHeight = '16em'; output.style.overflow = 'auto'; output.style.whiteSpace = 'pre-wrap';
  section.append(note, actions, output); container.append(section);
  const tasks = mountTaskTabs(document, actions, [{ id: 'exec', label: 'Run command', zh: '执行命令' }, { id: 'forward', label: 'Port forwarding', zh: '端口转发' }, { id: 'preview', label: 'Preview forwarded service', zh: '预览转发服务' }], locale);
  const execControls = tasks.slots.exec!, forwardControls = tasks.slots.forward!, previewControls = tasks.slots.preview!;
  let state: SessionClientState = { phase: 'idle', output: '', dropped: false }, command = 'env', proxyPath = '/';
  let selected: SessionTargetState = { phase: 'idle', containers: [] }, choosing = false;
  let pending: { expected: string } | undefined;
  const drafts = new Map<string, string>();
  const activeForwardKey = () => !pending ? forwardSelectionKey(selected) : undefined;
  const portsValue = (key = activeForwardKey()) => {
    if (!key) return '';
    const remote = selected.forwardPorts?.[0];
    return drafts.get(key) ?? (remote !== undefined ? suggestedForwardMapping(remote) : selected.reference?.type.resource === 'deployments' ? '8080:80' : '');
  };
  const editPorts = (value: string) => {
    const key = activeForwardKey();
    if (key) drafts.set(key, value);
    paint();
  };
  const targetNote = document.createElement('p'); section.prepend(targetNote);
  const containerSlot = document.createElement('div'); containerSlot.setAttribute('data-scene-runtime-value', ''); execControls.append(containerSlot);
  const containerField = mountSelect(containerSlot, { label: 'Container name', value: '', options: [], onChange: value => {
    choosing = true; paint(); void Promise.resolve(bridge()?.sessionContainer(value)).finally(() => { choosing = false; paint(); });
  } });
  const readContainers = mountButton(execControls, { label: 'Read selected Pod containers', variant: 'outline', onClick: () => {
    if (!selected.reference) return; choosing = true; paint();
    void Promise.resolve(bridge()?.sessionTarget(selected.reference, true)).finally(() => { choosing = false; paint(); });
  } });
  const commandField = mountTextField(execControls, { label: 'Command & arguments', value: command, onChange: value => { command = value; paint(); } });
  const portsSlot = document.createElement('div'), portsNote = document.createElement('p');
  portsSlot.setAttribute('data-scene-runtime-value', '');
  forwardControls.append(portsSlot, portsNote);
  const portsField = mountTextField(portsSlot, { label: 'Ports (local:remote)', value: '', onChange: editPorts });
  portsSlot.querySelector('input')?.setAttribute('maxlength', '256');
  const candidatesSlot = document.createElement('div');
  candidatesSlot.setAttribute('data-scene-runtime-value', ''); forwardControls.append(candidatesSlot);
  const candidates = mountSelect(candidatesSlot, { label: 'Add a declared TCP port', value: '', options: [], onChange: value => {
    const remote = Number(value), text = portsValue(), current = text.trim() ? parseSessionPorts(text) : [];
    if (!activeForwardKey() || !current || current.length >= 8 || !selected.forwardPorts?.includes(remote) || current.some(port => port.remote === remote)) return;
    editPorts(`${text.trim() ? `${text.trim()}, ` : ''}${suggestedForwardMapping(remote, new Set(current.map(port => port.local)))}`);
  } });
  const proxyField = mountTextField(previewControls, { label: 'Preview path', value: proxyPath, onChange: value => { proxyPath = value; } });
  const exec = mountButton(execControls, { label: 'Run command', onClick: () => { const parsed = parseSessionCommand(command); if (parsed) void bridge()?.openSession('exec', parsed); } });
  const forward = mountButton(forwardControls, { label: 'Start forwarding', onClick: () => {
    const key = activeForwardKey(), parsed = parseSessionPorts(portsValue(key));
    if (key && parsed) void bridge()?.openSession('port-forward', [], parsed, key);
  } });
  const proxy = mountButton(previewControls, { label: 'Read preview', onClick: () => { void bridge()?.sessionDashboardProxy(proxyPath); } });
  const poll = mountButton(actions, { label: 'Poll output', onClick: () => { void bridge()?.sessionPoll(); } });
  const close = mountButton(actions, { label: 'Close session', variant: 'outline', onClick: () => { void bridge()?.sessionClose(); } });
  const sessions = mountButton(actions, { label: 'List sessions', variant: 'ghost', onClick: () => { void bridge()?.listSessions(); } });
  bindScene(section, 'exec-forward', () => ({ command, drafts: [...drafts], proxyPath }), value => {
    command = value.command; proxyPath = value.proxyPath;
    drafts.clear(); for (const [key, text] of value.drafts ?? []) drafts.set(key, text);
    paint();
  });
  const presentation = visiblePresentation(section, paint);
  function paint() {
    presentation?.painted();
    tasks.paint();
    const zh = locale().startsWith('zh');
    const reference = selected.reference;
    targetNote.textContent = state.id && state.target ? `${state.scope?.context ?? ''} · ${state.target.original ? `${state.target.original.resource} ${state.target.original.namespace}/${state.target.original.name} → ` : ''}Pod ${state.target.namespace}/${state.target.podName}${state.target.container ? ` · ${state.target.container}` : ''}${state.controlRevoked ? (zh ? ' · 原配置已失效' : ' · Original scope revoked') : ''}`
      : reference ? `${reference.type.kind} ${reference.namespace}/${reference.name}${selected.error ? ` · ${selected.error}` : ''}`
      : selected.error ?? (zh ? '请从资源树明确选择转发或执行目标。' : 'Choose the operation target explicitly in the resource tree.');
    note.textContent = zh ? '在所选容器执行命令或建立服务器本机端口转发。命令会实际执行；转发保持到关闭会话或到期。' : 'Execute a command in the selected container or forward a Server loopback port. Commands execute for real; forwarding lasts until the session closes or expires.';
    const forwardKey = activeForwardKey(), ports = portsValue(forwardKey), mappings = ports.trim() ? parseSessionPorts(ports) : [];
    commandField.update({ label: zh ? '命令与参数' : 'Command & arguments' });
    portsField.update({ label: zh ? '端口（本地:远端）' : 'Ports (local:remote)', value: ports, disabled: !forwardKey });
    proxyField.update({ label: zh ? '预览路径' : 'Preview path' });
    const hints = forwardKey ? selected.forwardPorts : undefined;
    const remaining = (hints ?? []).filter(remote => !mappings?.some(port => port.remote === remote));
    candidatesSlot.hidden = !remaining.length;
    const addPortLabel = zh ? '添加声明的 TCP 端口' : 'Add a declared TCP port';
    candidates.update({ label: addPortLabel, value: '', disabled: !mappings || mappings.length >= 8,
      options: [{ id: '', label: addPortLabel }, ...remaining.map(remote => ({ id: String(remote), label: String(remote) }))] });
    setText(portsNote, pending ? (zh ? '正在选择转发目标…' : 'Selecting forwarding target…') : hints?.length
      ? (zh ? '端口来自资源声明，不代表应用正在监听。可修改本地和远端端口。' : 'These ports are declared on the resource; they may not be listening. Both ports are editable.')
      : forwardKey && reference?.type.resource !== 'deployments' ? (zh ? '没有可用的 TCP 端口声明，请手动填写。' : 'No declared TCP ports available. Enter a mapping manually.') : '');
    containerField.update({ label: zh ? '容器名称' : 'Container name', value: selected.container ?? '', disabled: !!state.id || choosing || selected.phase !== 'ready',
      options: [{ id: '', label: zh ? '请选择容器' : 'Choose a container' }, ...selected.containers.map(name => ({ id: name, label: name }))] });
    readContainers.update({ label: zh ? '读取所选 Pod 的容器' : 'Read selected Pod containers', disabled: !!state.id || choosing || selected.phase === 'loading' || selected.reference?.type.resource !== 'pods' });
    const available = sessionActionAvailability(state, selected, { shell: '', command, ports, choosing });
    exec.update({ label: zh ? '执行命令' : 'Run command', disabled: !available.exec });
    forward.update({ label: zh ? '开始转发' : 'Start forwarding', disabled: !forwardKey || !available.forward });
    proxy.update({ label: zh ? '读取预览' : 'Read preview', disabled: !state.id || state.kind !== 'port-forward' || state.closed === true || state.detached === true || state.controlRevoked === true || state.controlSuspended === true });
    poll.update({ disabled: !state.id || state.closed === true });
    close.update({ disabled: !state.id });
    setText(output, `${state.closed ? (zh ? '会话已结束' : 'Session ended') : state.detached ? (zh ? '已断开显示' : 'Detached') : phaseLabel(state.phase, zh)}${state.error ? ` · ${state.error}` : ''}${state.forwarded ? `\n${state.forwarded.map(port => `${port.local} → ${port.remote}`).join(', ')}` : ''}${state.exitCode !== undefined && state.exitCode !== null ? `\n${zh ? '退出码' : 'Exit code'} ${state.exitCode}` : ''}\n${state.preview ?? state.output}`);
  }
  return { show(value: SessionClientState) { state = value; presentation.changed(); }, showTarget(value: SessionTargetState) {
    if (pending && value.reference && documentReferenceId(value.reference) !== pending.expected) return;
    selected = value; presentation.changed();
  }, target(rowId: string, generation: number, reference: DocumentReference) {
    const request = { expected: documentReferenceId(reference) };
    pending = request; selected = { phase: 'loading', reference, containers: [] }; presentation.changed();
    void Promise.resolve(bridge()?.sessionForwardTarget(rowId, generation, request.expected)).then(accepted => {
      if (pending !== request) return;
      const current = accepted ? bridge()?.sessionTargetState() : undefined;
      selected = current?.reference && documentReferenceId(current.reference) === request.expected
        ? current : { phase: 'error', reference, containers: [], error: 'STALE_TARGET' };
      pending = undefined; presentation.changed();
    });
  }, selectTask: tasks.show, paint, dispose() { presentation.dispose(); tasks.dispose(); for (const control of [containerField, readContainers, commandField, portsField, candidates, proxyField, exec, forward, proxy, poll, close, sessions]) control.dispose(); section.remove(); } };
}
