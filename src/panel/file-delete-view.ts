import { mountButton, mountTextField } from './controls.ts';
import { mountOperationSummary } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { FileDeleteState } from '../host/file-delete-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountFileDeleteView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Delete resource from file'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  section.append(note, actions, status); container.append(section);
  let state: FileDeleteState = { phase: 'idle', history: [] }, filePath = '';
  const file = mountTextField(actions, { label: 'Server workspace file path (single document; captured independently)', value: '', onChange: value => { filePath = value; } });
  const prepare = mountButton(actions, { label: 'Prepare Delete from file (file proof + live pin + limited confirmation)', onClick: () => { void bridge()?.prepareFileDelete(filePath); } });
  const submit = mountButton(actions, { label: 'Confirm exact pinned-object Delete (single DELETE)', onClick: () => { void bridge()?.submitFileDelete(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted intent', variant: 'ghost', onClick: () => bridge()?.cancelFileDelete() });
  const ledger = mountButton(actions, { label: 'Read original ledger', variant: 'outline', onClick: () => { void bridge()?.fileDeleteOutcomes(); } });
  const next = mountButton(actions, { label: 'Older ledger page', variant: 'ghost', onClick: () => { void bridge()?.fileDeleteOutcomes(true); } });
  const summary = mountOperationSummary(document, section, status, locale);
  function paint() {
    summary.show(state);
    const zh = locale().startsWith('zh'), value = state.outcome, busy = state.phase === 'preparing' || state.phase === 'submitting';
    note.textContent = zh ? '删除所选文件对应的集群资源，不删除文件。仅支持单份资源文档；请核对集群、命名空间和对象。' : 'Delete the cluster resource described by the selected file, not the file. One resource document only; verify the cluster, namespace and object.';
    file.update({ label: zh ? '服务器文件路径（单份资源清单）' : 'Server file path (one resource manifest)', disabled: busy });
    prepare.update({ label: zh ? '检查删除目标' : 'Review deletion', disabled: busy });
    submit.update({ label: zh ? '确认删除资源' : 'Confirm deleting resource', disabled: busy || state.phase !== 'confirm' });
    cancel.update({ label: zh ? '取消尚未提交意图' : 'Cancel unsubmitted intent', disabled: state.phase !== 'confirm' });
    ledger.update({ label: zh ? '读取原账本' : 'Read original ledger', disabled: busy }); next.update({ label: zh ? '较旧账本页' : 'Older ledger page', disabled: !state.next || busy });
    status.textContent = `${state.phase}${state.error ? ` · ${state.error}` : ''}${value ? `\nfile ${value.parameters.file.path} · pinned ${value.reference ? `${value.reference.type.resource} ${value.reference.namespace ?? '(cluster)'}/${value.reference.name} r${value.reference.resourceVersion}` : '-'} · ${value.phase} ${value.code ?? ''}` : ''} · ledger ${state.history.length}`;
  }
  bindScene(section, 'file-delete', () => ({ filePath }), value => { filePath = value.filePath; paint(); });
  return { show(value: FileDeleteState) { state = value; paint(); }, paint, dispose() { for (const control of [file, prepare, submit, cancel, ledger, next]) control.dispose(); section.remove(); } };
}
