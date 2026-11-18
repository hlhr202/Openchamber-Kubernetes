import { mountButton } from './controls.ts';
import { mountOperationSummary } from './presentation.ts';
import type { ApplyFileState } from '../host/apply-file-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountApplyFileView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Apply file'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  section.append(note, actions, status); container.append(section);
  let state: ApplyFileState = { phase: 'idle', history: [] };
  const prepare = mountButton(actions, { label: 'Prepare Apply file (stream ≤16 documents + fresh probes)', onClick: () => { void bridge()?.prepareApplyFile(); } });
  const submit = mountButton(actions, { label: 'Confirm exact documents (one request per document)', onClick: () => { void bridge()?.submitApplyFile(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted intent', variant: 'ghost', onClick: () => bridge()?.cancelApplyFile() });
  const ledger = mountButton(actions, { label: 'Read original ledger', variant: 'outline', onClick: () => { void bridge()?.applyFileOutcomes(); } });
  const next = mountButton(actions, { label: 'Older ledger page', variant: 'ghost', onClick: () => { void bridge()?.applyFileOutcomes(true); } });
  const summary = mountOperationSummary(document, section, status, locale);
  function paint() {
    summary.show(state);
    const zh = locale().startsWith('zh'), value = state.outcome, busy = state.phase === 'preparing' || state.phase === 'submitting';
    note.textContent = zh ? '将已保存文件中的资源依次应用到集群，缺失资源会创建。失败会停止后续资源，已完成的修改不会回滚。' : 'Apply resources from a saved file in order, creating missing resources. Failure stops later resources without rolling back completed changes.';
    prepare.update({ label: zh ? '检查文件变更' : 'Review file changes', disabled: busy });
    submit.update({ label: zh ? '确认应用所列资源' : 'Confirm applying listed resources', disabled: busy || state.phase !== 'confirm' });
    cancel.update({ label: zh ? '取消尚未提交意图' : 'Cancel unsubmitted intent', disabled: state.phase !== 'confirm' });
    ledger.update({ label: zh ? '读取原账本' : 'Read original ledger', disabled: busy }); next.update({ label: zh ? '较旧账本页' : 'Older ledger page', disabled: !state.next || busy });
    const documents = value?.parameters.documents ?? [];
    const results = value?.results;
    status.textContent = `${state.phase}${state.error ? ` · ${state.error}` : ''}${documents.length ? `\nfile ${value?.parameters.file.path ?? ''} · documents ${documents.length} (${documents.map(plan => `${plan.action[0]}:${plan.locator.kind}/${plan.locator.name}`).join(', ')})` : ''}${value ? `\n${value.phase} ${value.code ?? ''} · r${value.updatedAt}` : ''}${results ? `\nresults ${results.map(result => `${result.index}:${result.outcome}`).join(', ')}` : ''} · ledger ${state.history.length}`;
  }
  return { show(value: ApplyFileState) { state = value; paint(); }, paint, dispose() { for (const control of [prepare, submit, cancel, ledger, next]) control.dispose(); section.remove(); } };
}
