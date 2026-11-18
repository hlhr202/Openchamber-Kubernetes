import { mountButton, mountSelect } from './controls.ts';
import { phaseLabel } from './presentation.ts';
import { mountTaskTabs } from './task-tabs.ts';
import { bindScene } from './workspace-scene.ts';
import type { ClusterState } from '../host/cluster-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { sessionOpenTarget } from '../shared/session-target.ts';
export function mountClusterView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Minikube and debug'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  section.append(note, actions, status); container.append(section);
  const tasks = mountTaskTabs(document, actions, [{ id: 'minikube', label: 'Minikube', zh: 'Minikube' }, { id: 'debug', label: 'Attach debugger', zh: '连接调试器' }, { id: 'providers', label: 'Cluster providers', zh: '集群提供方' }], locale);
  const lifecycle = tasks.slots.minikube!, debug = tasks.slots.debug!, integrations = tasks.slots.providers!;
  let state: ClusterState = { phase: 'idle' };
  let action: 'start' | 'stop' = 'start', language = 'node';
  let choosing = false, providerMessage = '';
  const providerOutput = document.createElement('pre'); providerOutput.style.whiteSpace = 'pre-wrap'; providerOutput.style.overflowWrap = 'anywhere'; section.append(providerOutput);
  const actionField = mountSelect(lifecycle, { label: 'Minikube action', value: action, options: [{ id: 'start', label: 'start' }, { id: 'stop', label: 'stop' }], onChange: value => { if (value === 'start' || value === 'stop') { action = value; bridge()?.invalidateClusterDraft(); paint(); } } });
  const languageField = mountSelect(debug, { label: 'Debug language', value: language, options: [{ id: 'node', label: 'node' }, { id: 'python', label: 'python' }, { id: 'go', label: 'go' }, { id: 'dotnet', label: '.NET' }, { id: 'java', label: 'java' }], onChange: value => { language = value; bridge()?.invalidateClusterDraft(); paint(); } });
  const containerSlot = document.createElement('div'); containerSlot.setAttribute('data-scene-runtime-value', ''); debug.append(containerSlot);
  const containerField = mountSelect(containerSlot, { label: 'Debug container', value: '', options: [], onChange: value => {
    choosing = true; bridge()?.invalidateClusterDraft(); paint();
    void Promise.resolve(bridge()?.sessionContainer(value)).finally(() => { choosing = false; paint(); });
  } });
  const debugTarget = document.createElement('p'); debug.append(debugTarget);
  const statusButton = mountButton(lifecycle, { label: 'Minikube status', onClick: () => { void bridge()?.minikubeStatus(); } });
  const prepareMinikube = mountButton(lifecycle, { label: 'Prepare minikube change', onClick: () => { void bridge()?.minikubePrepare(action); } });
  const prepareDebug = mountButton(debug, { label: 'Prepare debugger attachment', onClick: () => { void bridge()?.debugPrepare('attach', language, undefined); } });
  const submit = mountButton(actions, { label: 'Confirm exact lifecycle/debug (single dispatch)', onClick: () => { void bridge()?.clusterSubmit(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted intent', variant: 'ghost', onClick: () => bridge()?.clusterCancel() });
  const poll = mountButton(actions, { label: 'Read original operation status', variant: 'outline', onClick: () => { void bridge()?.clusterStatus(); } });
  const remove = mountButton(debug, { label: 'Close debugger & forwards', variant: 'outline', onClick: () => { void bridge()?.debugRemove(); } });
  const tunnel = mountButton(debug, { label: 'Start local tunnel debug', variant: 'ghost', onClick: () => { void bridge()?.localTunnelStart(); } });
  const marketplace = mountButton(integrations, { label: 'Find providers', variant: 'ghost', onClick: () => { void bridge()?.openMarketplaceProviderSearch(); } });
  const providers = mountButton(integrations, { label: 'List providers', variant: 'ghost', onClick: () => { void bridge()?.clusterProviders('create'); } });
  const configure = mountButton(lifecycle, { label: 'Read Minikube configuration', variant: 'ghost', onClick: () => { void bridge()?.minikubeConfigView(); } });
  const tpStatus = mountButton(debug, { label: 'Telepresence status', variant: 'ghost', onClick: () => { void bridge()?.telepresenceStatus(); } });
  bindScene(section, 'cluster', () => ({ action, language }), value => { action = value.action; language = value.language; paint(); });
  function paint() {
    tasks.paint();
    const zh = locale().startsWith('zh'), busy = state.phase === 'preparing' || state.phase === 'submitting' || ['queued', 'checking', 'dispatching'].includes(state.outcome?.phase ?? '');
    const selected = bridge()?.sessionTargetState(), reference = selected?.reference;
    debugTarget.textContent = reference ? `${reference.type.kind} ${reference.namespace}/${reference.name}` : (zh ? '请先从资源树选择 Pod 与容器。' : 'Choose a Pod and container in the resource tree first.');
    containerField.update({ label: zh ? '调试容器' : 'Debug container', value: selected?.container ?? '', disabled: busy || choosing || selected?.phase !== 'ready',
      options: [{ id: '', label: zh ? '请选择容器' : 'Choose a container' }, ...(selected?.containers ?? []).map(name => ({ id: name, label: name }))] });
    actionField.update({ disabled: busy }); languageField.update({ disabled: busy });
    note.textContent = zh ? '检查或管理 Minikube，并连接调试工具。启动、停止和调试连接须先确认，不自动安装软件。' : 'Inspect or manage Minikube and connect debugging tools. Starting, stopping and attaching require confirmation; software is not installed automatically.';
    statusButton.update({ label: zh ? '读取 Minikube 状态' : 'Read Minikube status', disabled: busy });
    prepareMinikube.update({ label: zh ? '检查 Minikube 变更' : 'Review Minikube change', disabled: busy });
    prepareDebug.update({ label: zh ? '检查调试连接' : 'Review debugger attachment', disabled: busy || choosing || !selected || !sessionOpenTarget(selected, true) });
    submit.update({ label: zh ? '确认执行' : 'Confirm operation', disabled: busy || state.phase !== 'confirm' });
    cancel.update({ label: zh ? '取消未提交操作' : 'Cancel before submit', disabled: state.phase !== 'confirm' });
    poll.update({ label: zh ? '查询原操作状态（不重新执行）' : 'Read original operation status (no rerun)', disabled: !state.outcome });
    for (const control of [tunnel, marketplace, providers, configure, tpStatus]) control.update({ disabled: busy });
    status.textContent = `${phaseLabel(state.phase, zh)}${state.error ? ` · ${state.error === 'DEBUG_ADAPTER_REQUIRED' ? (zh ? '调试协议适配器尚未接通；Node Inspector 不能直接当作 DAP 使用。' : 'Debug protocol adapter is not connected; Node Inspector is not DAP.') : state.error}` : ''}${state.statusOutput ? `\n${state.statusOutput.slice(0, 1_024)}` : ''}${state.outcome ? `\n${phaseLabel(state.outcome.phase, zh)} ${state.outcome.code ?? ''}${state.outcome.details?.stage ? ` · ${state.outcome.details.stage}` : ''}${state.outcome.details?.port ? ` · port ${state.outcome.details.port}` : ''}` : ''}`;
    providerOutput.hidden = !providerMessage; providerOutput.textContent = providerMessage;
  }
  return { show(value: ClusterState) { state = value; paint(); }, selectTask: tasks.show,
    minikubeAction(value: 'start' | 'stop') { action = value; actionField.update({ value }); bridge()?.invalidateClusterDraft(); paint(); },
    providerResult(method: string, value: unknown) { providerMessage = `${method}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`; if (providerMessage.length > 8192) providerMessage = `${providerMessage.slice(0, 8192)}\n[… truncated]`; paint(); },
    paint, dispose() { tasks.dispose(); for (const control of [actionField, languageField, containerField, statusButton, prepareMinikube, prepareDebug, submit, cancel, poll, remove, tunnel, marketplace, providers, configure, tpStatus]) control.dispose(); section.remove(); } };
}
