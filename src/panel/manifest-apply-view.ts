import { mountButton } from './controls.ts';
import { mountOperationSummary } from './presentation.ts';
import type { ManifestApplyState } from '../host/manifest-apply-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountManifestApplyView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p'), history = document.createElement('div');
  section.setAttribute('aria-label', 'Apply loaded CRD instance'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere'; section.append(note, actions, status, history); container.append(section);
  let state: ManifestApplyState = { phase: 'idle', history: [], next: null, canCancel: false }; const historyButtons: ReturnType<typeof mountButton>[] = [];
  const prepare = mountButton(actions, { label: 'Prepare Apply of loaded CRD instance', onClick: () => { void bridge()?.prepareManifestApply(); } });
  const submit = mountButton(actions, { label: 'Confirm exact version/content Apply', onClick: () => { void bridge()?.submitManifestApply(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted intent', variant: 'ghost', onClick: () => { void bridge()?.cancelManifestApply(); } });
  const poll = mountButton(actions, { label: 'Read original result (no replay)', variant: 'outline', onClick: () => { void bridge()?.manifestApplyStatus(); } });
  const ledger = mountButton(actions, { label: 'Read original ledger', variant: 'ghost', onClick: () => { void bridge()?.manifestApplyOutcomes(); } });
  const next = mountButton(actions, { label: 'Older ledger page', variant: 'ghost', onClick: () => { void bridge()?.manifestApplyOutcomes(true); } });
  const summary = mountOperationSummary(document, section, status, locale);
  function paint() {
    summary.show(state);
    const zh = locale().startsWith('zh'), value = state.outcome, busy = state.phase === 'preparing' || state.phase === 'submitting';
    note.textContent = zh ? '将已加载的单个自定义资源编辑内容提交到集群。对象缺失时另行确认创建；结果未知时只查询原操作，不要重复提交。' : 'Apply edits to one loaded custom resource. Creating a missing object requires confirmation. If the outcome is unknown, check the original operation instead of resubmitting.';
    prepare.update({ label: zh ? '检查应用内容' : 'Review Apply', disabled: busy });
    submit.update({ label: value?.missing
      ? zh ? '确认创建缺失对象' : 'Confirm creating missing object'
      : zh ? '确认应用变更' : 'Confirm Apply', disabled: busy || state.phase !== 'confirm' });
    cancel.update({ label: zh ? '取消尚未提交意图' : 'Cancel unsubmitted intent', disabled: busy || !state.canCancel });
    poll.update({ label: zh ? '手动查原结果（不重放）' : 'Read original result (no replay)', disabled: !value || busy }); ledger.update({ label: zh ? '读取原账本' : 'Read original ledger', disabled: busy }); next.update({ label: zh ? '较旧账本页' : 'Older ledger page', disabled: !state.next || busy });
    status.textContent = `${state.phase}${state.error ? ` · ${state.error}` : ''}${value ? `\n${value.target.context}/${value.reference.namespace ?? '(cluster)'} · ${value.reference.type.group}/${value.reference.type.version}/${value.reference.type.kind}/${value.reference.name}\nUID ${value.reference.uid} RV ${value.reference.resourceVersion} · CRD ${value.reference.definition.name} UID ${value.reference.definition.uid} RV ${value.reference.definition.resourceVersion}\nsource r${value.source.revision} SHA ${value.source.identity} · ${value.received}/${value.bytes} bytes\n${value.missing ? 'MISSING → explicit single-POST Create branch' : `patch SHA ${value.patchDigest ?? '-'} · ${value.patchBytes ?? 0} bytes · baseline ${value.baseline ?? '-'} · unchanged ${String(value.unchanged ?? false)}`}\n${value.phase} ${value.code ?? ''} · RV after ${value.resourceVersionAfter ?? '-'}${value.uidAfter ? ` · new UID ${value.uidAfter}` : ''} · expires ${new Date(value.expiresAt).toISOString()}` : ''}`;
    for (const button of historyButtons) button.dispose(); historyButtons.length = 0; history.replaceChildren();
    for (const item of state.history) {
      const row = document.createElement('p'); row.textContent = `${item.id} · ${item.target.context}/${item.target.namespace} · ${item.phase} · ${item.code ?? '-'}`; history.append(row);
      if (bridge()?.canQueryManifestApply(item.id)) historyButtons.push(mountButton(row, { label: zh ? '查询此原意图' : 'Query this original intent', variant: 'ghost', onClick: () => { void bridge()?.manifestApplyStatus(item.id); } }));
    }
  }
  return { show(value: ManifestApplyState) { state = value; paint(); }, paint, dispose() { for (const button of historyButtons) button.dispose(); for (const button of [prepare, submit, cancel, poll, ledger, next]) button.dispose(); section.remove(); } };
}
