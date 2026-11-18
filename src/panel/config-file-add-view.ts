import { mountButton, mountTextField } from './controls.ts';
import { mountOperationSummary } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { ConfigFileAddState } from '../host/config-file-add-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import type { DocumentReference } from '../shared/document-protocol.ts';
export function mountConfigFileAddView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Add file to configuration data'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  section.append(note, actions, status); container.append(section);
  let state: ConfigFileAddState = { phase: 'idle', history: [] }, reference: DocumentReference | undefined, key = '', filePath = '';
  const origin = mountTextField(actions, { label: 'Parent ConfigMap/Secret namespace/name (from selected row)', value: '', onChange: () => {} });
  const input = mountTextField(actions, { label: 'Data key (file basename; overwrite is decided by the confirm)', value: '', onChange: value => { key = value; } });
  const file = mountTextField(actions, { label: 'Server workspace file path (captured independently; never the dirty editor)', value: '', onChange: value => { filePath = value; } });
  const prepare = mountButton(actions, { label: 'Prepare Add File (file proof + fresh parent proof + limited confirmation)', onClick: () => { if (reference) void bridge()?.prepareConfigFileAdd(reference, key, filePath); } });
  const submit = mountButton(actions, { label: 'Confirm exact-key Add File (single replace; may overwrite this key)', onClick: () => { void bridge()?.submitConfigFileAdd(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted intent', variant: 'ghost', onClick: () => bridge()?.cancelConfigFileAdd() });
  const ledger = mountButton(actions, { label: 'Read original ledger', variant: 'outline', onClick: () => { void bridge()?.configFileAddOutcomes(); } });
  const next = mountButton(actions, { label: 'Older ledger page', variant: 'ghost', onClick: () => { void bridge()?.configFileAddOutcomes(true); } });
  const summary = mountOperationSummary(document, section, status, locale);
  function paint() {
    summary.show(state);
    const zh = locale().startsWith('zh'), value = state.outcome, busy = state.phase === 'preparing' || state.phase === 'submitting';
    note.textContent = zh ? '将一个已保存的服务器文件写入 ConfigMap 或 Secret。键已存在时会覆盖；不会使用未保存的编辑内容。' : 'Add one saved Server file to a ConfigMap or Secret. An existing key will be overwritten; unsaved editor changes are not used.';
    origin.update({ label: zh ? '父对象 namespace/name' : 'Parent ConfigMap/Secret namespace/name', disabled: true });
    input.update({ label: zh ? '数据键名' : 'Data key', disabled: busy });
    file.update({ label: zh ? '已保存的服务器文件路径' : 'Saved Server file path', disabled: busy });
    prepare.update({ label: zh ? '检查添加内容' : 'Review addition', disabled: busy || !reference });
    submit.update({ label: zh ? '确认写入此键（存在则覆盖）' : 'Confirm key write (overwrites if present)', disabled: busy || state.phase !== 'confirm' });
    cancel.update({ label: zh ? '取消尚未提交意图' : 'Cancel unsubmitted intent', disabled: state.phase !== 'confirm' });
    ledger.update({ label: zh ? '读取原账本' : 'Read original ledger', disabled: busy }); next.update({ label: zh ? '较旧账本页' : 'Older ledger page', disabled: !state.next || busy });
    status.textContent = `${state.phase}${state.error ? ` · ${state.error}` : ''}${reference ? `\nparent ${reference.type.resource} ${reference.namespace ?? ''}/${reference.name}` : ''}${value ? `\nkey ${value.parameters.key} · file ${value.parameters.file.path} · ${value.encodedBytes ?? 0}B · ${value.phase} ${value.code ?? ''}` : ''} · ledger ${state.history.length}`;
  }
  bindScene(section, 'config-file-add', () => ({ reference, key, filePath }), value => { reference = value.reference; key = value.key; filePath = value.filePath; paint(); });
  return { show(value: ConfigFileAddState) { state = value; paint(); }, target(ref: DocumentReference | undefined) {
    reference = ref; origin.update({ value: ref ? `${ref.type.resource} ${ref.namespace ?? ''}/${ref.name}` : '' }); paint();
  }, paint, dispose() { for (const control of [origin, input, file, prepare, submit, cancel, ledger, next]) control.dispose(); section.remove(); } };
}
