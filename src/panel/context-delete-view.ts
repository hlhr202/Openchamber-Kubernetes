import { mountButton } from './controls.ts';
import type { ContextDeleteState } from '../host/context-delete-client.ts';
import type { ContextDeleteOutcome } from '../shared/context-delete-protocol.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
import { mountOperationSummary } from './presentation.ts';

const description = (value: ContextDeleteOutcome) => `${value.path} · ${value.context} · version ${value.version} · Server ${value.serviceGeneration} · ${value.id} · ${value.phase} · current-context retained: ${value.currentContextRetained || '(unset)'}${value.removesCurrent ? value.contextRemains ? ' · WARNING: active context resolves to the newly exposed shadow' : ' · WARNING: dangling current-context after removal' : ''}${value.contextAfter ? `\nAfter removal: context still exists at ${value.contextAfter.origin} · cluster ${value.contextAfter.cluster || '(empty)'} · user ${value.contextAfter.user || '(empty)'} · namespace ${value.contextAfter.namespace}` : '\nAfter removal: target context absent'}\n${value.steps.map(step => `${step.id}:${step.name || '(empty)'} ${step.phase}/${step.reason} · origin:${step.path ?? '(none)'} · next:${step.nextOrigin ?? '(none)'} · shadow:${step.shadowDefinitions} shared:${step.sharedReferences} cleanup:${step.cleanup}${step.code ? ` ${step.code}` : ''}`).join('\n')}${value.code ? ` · ${value.code}` : ''}\n${value.sources.map((source, index) => `${index + 1}. ${source.path} · ${source.status} · ${source.version ?? '-'} · current-context ${source.currentContext || '(unset)'} · context:${source.definesContext} cluster:${source.definesCluster} user:${source.definesUser}`).join('\n')}`;
export function mountContextDeleteView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), target = document.createElement('p'), status = document.createElement('p'), actions = document.createElement('div'), history = document.createElement('div');
  status.setAttribute('role', 'status'); actions.className = 'configuration-actions'; section.append(note, target, status, actions, history); container.append(section);
  target.style.whiteSpace = 'pre-wrap'; target.style.overflowWrap = 'anywhere';
  let state: ContextDeleteState = { phase: 'idle', history: [] };
  const submit = mountButton(actions, { label: 'Confirm kubeconfig entry deletion', variant: 'destructive', disabled: true, onClick: () => { void bridge()?.submitContextDelete(); } });
  const cancel = mountButton(actions, { label: 'Cancel unstarted steps', variant: 'outline', onClick: () => bridge()?.closeContextDelete() });
  const outcomes = mountButton(actions, { label: 'Read original results', variant: 'outline', onClick: () => { void bridge()?.readContextDeleteOutcomes(); } });
  const older = mountButton(actions, { label: 'Older results', variant: 'outline', disabled: true, onClick: () => { void bridge()?.readContextDeleteOutcomes(true); } });
  const reload = mountButton(actions, { label: 'Reload configuration (read only)', variant: 'outline', onClick: () => { void bridge()?.reload(); } });
  const operation = mountOperationSummary(document, section, status, locale);
  operation.identifiers.append(target);
  const paint = () => {
    operation.show(state);
    const zh = locale().startsWith('zh'), value = state.outcome;
    section.setAttribute('aria-label', zh ? '从Server kubeconfig删除关联条目：确认与原结果' : 'Delete Server kubeconfig entries: confirmation and original results');
    note.textContent = zh ? '仅删除 kubeconfig 条目，不删除集群。当前条目删除后可能失效，或显露同名配置并指向另一集群；已完成步骤不回滚。' : 'Delete kubeconfig entries, not the cluster. Removing an active entry may leave it unresolved or expose a same-name entry for another cluster. Completed steps are not rolled back.';
    target.textContent = value ? logDisplayText(description(value)) : '';
    status.textContent = `${state.phase}${state.error ? ` · ${state.error}` : ''}${state.expiresAt ? ` · ${new Date(state.expiresAt).toISOString()}` : ''}`;
    submit.update({ label: zh ? '确认删除上述Server配置条目' : 'Confirm Server kubeconfig entry deletion above', disabled: state.phase !== 'confirm' || !state.expiresAt || Date.now() >= state.expiresAt });
    cancel.update({ label: zh ? '取消尚未开始的步骤' : 'Cancel unstarted steps' }); outcomes.update({ label: zh ? '读取原结果（不重试）' : 'Read original results (no retry)' });
    older.update({ label: zh ? '更早结果' : 'Older results', disabled: !state.next }); reload.update({ label: zh ? '重新读取配置（只读）' : 'Reload configuration (read only)' });
    history.replaceChildren(...state.history.map(value => { const row = document.createElement('p'); row.textContent = logDisplayText(description(value)); return row; }));
  };
  return { show(value: ContextDeleteState) { state = value; paint(); }, paint, dispose() { for (const button of [submit, cancel, outcomes, older, reload]) button.dispose(); section.remove(); } };
}
