import { mountButton } from './controls.ts';
import type { DeleteState } from '../host/delete-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
import { mountOperationSummary } from './presentation.ts';

export function mountDeleteView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), status = document.createElement('p'), target = document.createElement('p'), actions = document.createElement('div'), list = document.createElement('div');
  actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); section.append(note, target, status, actions, list); container.append(section);
  let state: DeleteState = { phase: 'idle', history: [] };
  const confirm = mountButton(actions, { label: 'Confirm delete', variant: 'destructive', disabled: true, onClick: () => { void bridge()?.submitDelete(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted / close view', variant: 'outline', onClick: () => bridge()?.closeDelete() });
  const outcomes = mountButton(actions, { label: 'Read original operation outcomes', variant: 'outline', onClick: () => { void bridge()?.readDeleteOutcomes(); } });
  const older = mountButton(actions, { label: 'Older outcomes', variant: 'outline', disabled: true, onClick: () => { void bridge()?.readDeleteOutcomes(true); } });
  const summary = mountOperationSummary(document, section, status, locale);
  const paint = () => {
    summary.show(state);
    const zh = locale().startsWith('zh'), value = state.outcome;
    section.setAttribute('aria-label', zh ? '单资源删除及原操作结果' : 'Single-resource deletion and original outcomes');
    note.textContent = zh ? '删除下方指定资源。Delete Now 会缩短 Pod 的退出等待时间，不是强制删除。提交后关闭面板不会撤销；已受理不代表已消失。' : 'Delete the resource below. Delete Now shortens Pod shutdown waiting; it is not force deletion. Closing after submission does not undo it. Accepted does not mean gone.';
    target.textContent = value ? logDisplayText(`${value.target.context} / ${value.parameters.reference.namespace ?? '(cluster)'} / ${value.parameters.reference.type.group || 'core'}/${value.parameters.reference.type.version} ${value.parameters.reference.type.kind} ${value.parameters.reference.name} · UID ${value.parameters.reference.uid} · RV ${value.parameters.reference.resourceVersion} · ${value.parameters.mode} · Server ${value.target.serviceGeneration} · ${value.step}`) : '';
    status.textContent = `${state.phase}${value ? ` · ${value.phase} · ${value.id}${value.code ? ` · ${value.code}` : ''}` : ''}${state.error ? ` · ${state.error}` : ''}${state.expiresAt && state.phase === 'confirm' ? ` · ${new Date(state.expiresAt).toISOString()}` : ''}`;
    confirm.update({ label: zh ? '确认删除此原目标' : 'Confirm deletion of this original target', disabled: state.phase !== 'confirm' || !state.expiresAt || Date.now() >= state.expiresAt });
    cancel.update({ label: zh ? '取消未提交意图 / 关闭当前视图' : 'Cancel unsubmitted intent / close current view' });
    outcomes.update({ label: zh ? '读取原操作结果（不重试）' : 'Read original outcomes (no retry)' }); older.update({ label: zh ? '更早的操作结果' : 'Older outcomes', disabled: !state.next });
    list.replaceChildren(...state.history.map(value => { const row = document.createElement('p'); row.textContent = logDisplayText(`${value.target.context} / ${value.parameters.reference.namespace ?? '(cluster)'} / ${value.parameters.reference.type.kind} ${value.parameters.reference.name} · UID ${value.parameters.reference.uid} · ${value.id} · Server ${value.target.serviceGeneration} · ${value.step} · ${value.phase}${value.code ? ` · ${value.code}` : ''}`); return row; }));
  };
  return { show(value: DeleteState) { state = value; paint(); }, paint, dispose() { confirm.dispose(); cancel.dispose(); outcomes.dispose(); older.dispose(); state = { phase: 'idle', history: [] }; list.replaceChildren(); section.remove(); } };
}
