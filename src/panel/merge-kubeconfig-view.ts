import { mountButton, mountSelect, mountTextField } from './controls.ts';
import { mountOperationSummary } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { MergeKubeconfigState } from '../host/merge-kubeconfig-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountMergeKubeconfigView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Merge into kubeconfig'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  section.append(note, actions, status); container.append(section);
  let state: MergeKubeconfigState = { phase: 'idle', history: [] }, incoming = '';
  let strategy: 'keep-both' | 'overwrite' = 'keep-both';
  const incomingField = mountTextField(actions, { label: 'Incoming kubeconfig', value: '', multiline: true, mono: true, onChange: value => { incoming = value; } });
  const strategyField = mountSelect(actions, { label: 'Collision strategy', value: strategy, options: [{ id: 'keep-both', label: 'Keep Both' }, { id: 'overwrite', label: 'Overwrite' }], onChange: value => { if (value === 'keep-both' || value === 'overwrite') strategy = value; } });
  const prepare = mountButton(actions, { label: 'Prepare merge (first-path preview + 60s confirmation)', onClick: () => { void bridge()?.prepareMergeKubeconfig(strategy, incoming); } });
  const submit = mountButton(actions, { label: 'Confirm exact merge (one staged replace)', onClick: () => { void bridge()?.submitMergeKubeconfig(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted intent', variant: 'ghost', onClick: () => bridge()?.cancelMergeKubeconfig() });
  const ledger = mountButton(actions, { label: 'Read original ledger', variant: 'outline', onClick: () => { void bridge()?.mergeKubeconfigOutcomes(); } });
  const summary = mountOperationSummary(document, section, status, locale);
  function paint() {
    summary.show(state);
    const zh = locale().startsWith('zh'), busy = state.phase === 'preparing' || state.phase === 'submitting';
    note.textContent = zh ? '将输入配置合并到所选 kubeconfig。请先核对目标文件和重名处理方式；确认后会写入服务器文件。' : 'Merge the supplied configuration into the selected kubeconfig. Check the destination and duplicate-name strategy before confirming a Server file change.';
    incomingField.update({ label: zh ? '要合并的 kubeconfig 内容' : 'Incoming kubeconfig' }); strategyField.update({ label: zh ? '重名处理' : 'Duplicate names', options: [{ id: 'keep-both', label: zh ? '保留两者' : 'Keep both' }, { id: 'overwrite', label: zh ? '覆盖原条目' : 'Overwrite entries' }] });
    prepare.update({ label: zh ? '检查合并内容' : 'Review merge', disabled: busy || !incoming.trim() });
    submit.update({ label: zh ? '确认合并配置' : 'Confirm merge', disabled: busy || state.phase !== 'confirm' });
    cancel.update({ label: zh ? '取消未提交操作' : 'Cancel before submit', disabled: state.phase !== 'confirm' });
    ledger.update({ label: zh ? '操作记录' : 'Operation history', disabled: busy });
    status.textContent = `${state.phase}${state.error ? ` · ${state.error}` : ''}${state.outcome ? `\n${state.outcome.strategy} · ${state.outcome.phase} ${state.outcome.code ?? ''} · r${state.outcome.updatedAt}` : ''} · ledger ${state.history.length}`;
  }
  bindScene(section, 'merge-kubeconfig', () => ({ incoming, strategy }), value => { incoming = value.incoming; strategy = value.strategy; paint(); });
  return { show(value: MergeKubeconfigState) { state = value; paint(); }, paint, dispose() { for (const control of [incomingField, strategyField, prepare, submit, cancel, ledger]) control.dispose(); section.remove(); } };
}
