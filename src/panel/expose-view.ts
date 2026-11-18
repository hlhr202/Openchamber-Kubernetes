import { mountButton, mountSelect, mountTextField } from './controls.ts';
import { mountOperationSummary } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { ExposeState } from '../host/expose-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import type { DocumentReference } from '../shared/document-protocol.ts';
export function mountExposeView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Expose resource'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  section.append(note, actions, status); container.append(section);
  let state: ExposeState = { phase: 'idle', history: [] }, reference: DocumentReference | undefined;
  let name = '', port = '', targetPort = '', typeValue = 'ClusterIP', protocolValue = 'TCP';
  const origin = mountTextField(actions, { label: 'Exposed target namespace/name (from selected row)', value: '', onChange: () => {} });
  const nameField = mountTextField(actions, { label: 'Service name (default target name)', value: '', onChange: value => { name = value; } });
  const portField = mountTextField(actions, { label: 'Port 1-65535 (optional: single derived port when omitted)', value: '', onChange: value => { port = value; } });
  const targetPortField = mountTextField(actions, { label: 'Target port 1-65535 (optional, defaults to port)', value: '', onChange: value => { targetPort = value; } });
  const type = mountSelect(actions, { label: 'Service type (default ClusterIP)', value: 'ClusterIP', options: [{ id: 'ClusterIP', label: 'ClusterIP' }, { id: 'NodePort', label: 'NodePort' }, { id: 'LoadBalancer', label: 'LoadBalancer' }], onChange: value => { if (value === 'ClusterIP' || value === 'NodePort' || value === 'LoadBalancer') typeValue = value; } });
  const protocol = mountSelect(actions, { label: 'Protocol (default TCP)', value: 'TCP', options: [{ id: 'TCP', label: 'TCP' }, { id: 'UDP', label: 'UDP' }, { id: 'SCTP', label: 'SCTP' }], onChange: value => { if (value === 'TCP' || value === 'UDP' || value === 'SCTP') protocolValue = value; } });
  const prepare = mountButton(actions, { label: 'Prepare Expose (fresh proof + limited confirmation)', onClick: () => { if (reference) void bridge()?.prepareExpose(reference, { name, port, targetPort, type: typeValue, protocol: protocolValue }); } });
  const submit = mountButton(actions, { label: 'Confirm exact-origin Expose (single Service POST)', onClick: () => { void bridge()?.submitExpose(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted intent', variant: 'ghost', onClick: () => bridge()?.cancelExpose() });
  const ledger = mountButton(actions, { label: 'Read original ledger', variant: 'outline', onClick: () => { void bridge()?.exposeOutcomes(); } });
  const next = mountButton(actions, { label: 'Older ledger page', variant: 'ghost', onClick: () => { void bridge()?.exposeOutcomes(true); } });
  const summary = mountOperationSummary(document, section, status, locale);
  function paint() { summary.show(state); const zh = locale().startsWith('zh'), value = state.outcome, busy = state.phase === 'preparing' || state.phase === 'submitting';
    note.textContent = zh ? '为所选资源创建 Service。请核对服务名、端口与暴露类型；确认后会修改集群。' : 'Create a Service for the selected resource. Check its name, ports and exposure type before confirming a cluster change.';
    origin.update({ label: zh ? '目标 namespace/name' : 'Exposed target namespace/name', disabled: true });
    nameField.update({ label: zh ? 'Service名（默认目标名）' : 'Service name (default target name)', disabled: busy });
    portField.update({ label: zh ? '端口1-65535（可空=唯一推导端口）' : 'Port 1-65535 (optional: single derived port when omitted)', disabled: busy });
    targetPortField.update({ label: zh ? 'targetPort1-65535（可空=同port）' : 'Target port 1-65535 (optional, defaults to port)', disabled: busy });
    type.update({ label: zh ? 'Service类型（默认ClusterIP）' : 'Service type (default ClusterIP)', disabled: busy }); protocol.update({ label: zh ? '协议（默认TCP）' : 'Protocol (default TCP)', disabled: busy });
    prepare.update({ label: zh ? '检查 Service 配置' : 'Review Service', disabled: busy || !reference });
    submit.update({ label: zh ? '确认创建 Service' : 'Confirm creating Service', disabled: busy || state.phase !== 'confirm' });
    cancel.update({ label: zh ? '取消尚未提交意图' : 'Cancel unsubmitted intent', disabled: state.phase !== 'confirm' });
    ledger.update({ label: zh ? '读取原账本' : 'Read original ledger', disabled: busy }); next.update({ label: zh ? '较旧账本页' : 'Older ledger page', disabled: !state.next || busy });
    status.textContent = `${state.phase}${state.error ? ` · ${state.error}` : ''}${reference ? `\ntarget ${reference.type.resource} ${reference.namespace ?? ''}/${reference.name}` : ''}${value ? `\nservice ${value.parameters.name} · port ${value.parameters.port ?? '(derived)'} → ${value.parameters.targetPort ?? '(=port)'} · ${value.parameters.type ?? 'ClusterIP'}/${value.parameters.protocol ?? 'TCP'} · ${value.phase} ${value.code ?? ''}` : ''} · ledger ${state.history.length}`;
  }
  bindScene(section, 'expose', () => ({ reference, name, port, targetPort, typeValue, protocolValue }), value => {
    reference = value.reference; name = value.name; port = value.port; targetPort = value.targetPort; typeValue = value.typeValue; protocolValue = value.protocolValue; paint();
  });
  return { show(value: ExposeState) { state = value; paint(); }, target(ref: DocumentReference | undefined) {
    reference = ref; origin.update({ value: ref ? `${ref.namespace ?? ''}/${ref.name}` : '' }); paint();
  }, paint,
    dispose() { for (const control of [origin, nameField, portField, targetPortField, type, protocol, prepare, submit, cancel, ledger, next]) control.dispose(); section.remove(); } };
}
