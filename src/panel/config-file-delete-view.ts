import { mountButton, mountTextField } from './controls.ts';
import { mountOperationSummary } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { ConfigFileDeleteState } from '../host/config-file-delete-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import type { DocumentReference } from '../shared/document-protocol.ts';
export function mountConfigFileDeleteView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Delete configuration data key'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  section.append(note, actions, status); container.append(section);
  let state: ConfigFileDeleteState = { phase: 'idle', history: [] }, reference: DocumentReference | undefined, key = '';
  const origin = mountTextField(actions, { label: 'Parent ConfigMap/Secret namespace/name (from selected row)', value: '', onChange: () => {} });
  const input = mountTextField(actions, { label: 'Data key to delete (exactly one; other keys are preserved)', value: '', onChange: value => { key = value; } });
  const prepare = mountButton(actions, { label: 'Prepare Delete File (fresh proof + limited confirmation)', onClick: () => { if (reference) void bridge()?.prepareConfigFileDelete(reference, key); } });
  const submit = mountButton(actions, { label: 'Confirm exact-key Delete File (single replace)', onClick: () => { void bridge()?.submitConfigFileDelete(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted intent', variant: 'ghost', onClick: () => bridge()?.cancelConfigFileDelete() });
  const ledger = mountButton(actions, { label: 'Read original ledger', variant: 'outline', onClick: () => { void bridge()?.configFileDeleteOutcomes(); } });
  const next = mountButton(actions, { label: 'Older ledger page', variant: 'ghost', onClick: () => { void bridge()?.configFileDeleteOutcomes(true); } });
  const summary = mountOperationSummary(document, section, status, locale);
  function paint() {
    summary.show(state);
    const zh = locale().startsWith('zh'), value = state.outcome, busy = state.phase === 'preparing' || state.phase === 'submitting';
    note.textContent = zh ? '仅删除 ConfigMap 或 Secret 中的一个数据键，不删除资源本身或服务器文件。请核对键名。' : 'Delete one data key, not the ConfigMap, Secret or any Server file. Check the key name.';
    origin.update({ label: zh ? '父对象 namespace/name' : 'Parent ConfigMap/Secret namespace/name', disabled: true });
    input.update({ label: zh ? '要删除的键名' : 'Key to delete', disabled: busy });
    prepare.update({ label: zh ? '检查删除目标' : 'Review deletion', disabled: busy || !reference });
    submit.update({ label: zh ? '确认删除此键' : 'Confirm deleting key', disabled: busy || state.phase !== 'confirm' });
    cancel.update({ label: zh ? '取消尚未提交意图' : 'Cancel unsubmitted intent', disabled: state.phase !== 'confirm' });
    ledger.update({ label: zh ? '读取原账本' : 'Read original ledger', disabled: busy }); next.update({ label: zh ? '较旧账本页' : 'Older ledger page', disabled: !state.next || busy });
    status.textContent = `${state.phase}${state.error ? ` · ${state.error}` : ''}${reference ? `\nparent ${reference.type.resource} ${reference.namespace ?? ''}/${reference.name}` : ''}${value ? `\nkey ${value.parameters.key} · ${value.phase} ${value.code ?? ''} · r${value.updatedAt}` : ''} · ledger ${state.history.length}`;
  }
  bindScene(section, 'config-file-delete', () => ({ reference, key }), value => { reference = value.reference; key = value.key; paint(); });
  return { show(value: ConfigFileDeleteState) { state = value; paint(); }, target(ref: DocumentReference | undefined) {
    reference = ref; origin.update({ value: ref ? `${ref.type.resource} ${ref.namespace ?? ''}/${ref.name}` : '' }); paint();
  }, paint, dispose() { for (const control of [origin, input, prepare, submit, cancel, ledger, next]) control.dispose(); section.remove(); } };
}
