import { mountButton } from './controls.ts';
import type { ContextState } from '../host/context-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
import { mountOperationSummary } from './presentation.ts';

export function mountContextView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), details = document.createElement('details'), summary = document.createElement('summary'), note = document.createElement('p'), target = document.createElement('p'), status = document.createElement('p'), actions = document.createElement('div'), history = document.createElement('div');
  status.setAttribute('role', 'status'); actions.className = 'configuration-actions'; details.append(summary, note); section.append(target, status, actions, details, history); container.append(section);
  target.style.whiteSpace = 'pre-wrap'; target.style.overflowWrap = 'anywhere';
  let state: ContextState = { phase: 'idle', history: [] };
  const submit = mountButton(actions, { label: 'Confirm Server current-context write', disabled: true, variant: 'destructive', onClick: () => { void bridge()?.submitContext(); } });
  const cancel = mountButton(actions, { label: 'Cancel uncommitted intent', variant: 'outline', onClick: () => bridge()?.closeContext() });
  const outcomes = mountButton(actions, { label: 'Read original outcomes', variant: 'outline', onClick: () => { void bridge()?.readContextOutcomes(); } });
  const older = mountButton(actions, { label: 'Older outcomes', variant: 'outline', disabled: true, onClick: () => { void bridge()?.readContextOutcomes(true); } });
  const reload = mountButton(actions, { label: 'Reload configuration (read only)', variant: 'outline', onClick: () => { void bridge()?.reload(); } });
  const operation = mountOperationSummary(document, section, status, locale);
  operation.identifiers.append(target);
  const paint = () => {
    operation.show(state);
    const zh = locale().startsWith('zh'), value = state.outcome;
    section.setAttribute('aria-label', zh ? 'Server Use Context确认与原结果' : 'Server Use Context confirmation and original outcomes');
    summary.textContent = zh ? '写入说明' : 'About this change';
    note.textContent = zh ? '修改 kubeconfig 的 current-context，不创建或删除集群。结果未知时请查询原操作，不要重复提交。' : 'Change kubeconfig current-context without creating or deleting a cluster. Check an unknown operation instead of submitting it again.';
    target.textContent = value ? logDisplayText(`${value.path} · effective ${value.previous || '(unset)'} → ${value.context} · file previous ${value.writePrevious || '(unset)'} · origin ${value.contextOrigin} · ${value.version} · Server ${value.serviceGeneration}\n${value.sources.map((source, index) => `${index + 1}. ${source.path} · ${source.status} · ${source.version ?? '-'} · current-context ${source.currentContext || '(unset)'} · defines-target:${source.definesContext}`).join('\n')}`) : '';
    status.textContent = `${state.phase}${value ? ` · ${value.phase} · ${value.id} · ${value.cleanup}${value.result ? ` · ${value.result}` : ''}${value.code ? ` · ${value.code}` : ''}` : ''}${state.error ? ` · ${state.error}` : ''}${state.expiresAt ? ` · ${new Date(state.expiresAt).toISOString()}` : ''}`;
    submit.update({ label: zh ? '确认写入上述Server current-context' : 'Confirm Server current-context write above', disabled: state.phase !== 'confirm' || !state.expiresAt || Date.now() >= state.expiresAt });
    cancel.update({ label: zh ? '取消未提交的替换' : 'Cancel uncommitted replacement' }); outcomes.update({ label: zh ? '读取原操作结果（不重试）' : 'Read original outcomes (no retry)' });
    older.update({ label: zh ? '更早结果' : 'Older outcomes', disabled: !state.next }); reload.update({ label: zh ? '重新读取配置（只读）' : 'Reload configuration (read only)' });
    history.replaceChildren(...state.history.map(value => { const row = document.createElement('p'); row.textContent = logDisplayText(`${value.path} · ${value.previous || '(unset)'} → ${value.context} · origin ${value.contextOrigin} · sources:${value.sources.length} · ${value.id} · Server ${value.serviceGeneration} · ${value.phase}/${value.cleanup}${value.code ? ` · ${value.code}` : ''}`); return row; }));
  };
  return { show(value: ContextState) { state = value; paint(); }, paint,
    dispose() { for (const button of [submit, cancel, outcomes, older, reload]) button.dispose(); history.replaceChildren(); section.remove(); } };
}
