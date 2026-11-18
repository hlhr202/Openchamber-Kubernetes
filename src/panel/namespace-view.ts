import { mountButton, mountTextField } from './controls.ts';
import type { NamespaceState } from '../host/namespace-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
import { mountOperationSummary } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';

export function mountNamespaceView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), fieldSlot = document.createElement('div'), target = document.createElement('p'), status = document.createElement('p'), actions = document.createElement('div'), history = document.createElement('div');
  status.setAttribute('role', 'status'); actions.className = 'configuration-actions'; section.append(note, fieldSlot, target, status, actions, history); container.append(section);
  target.style.whiteSpace = 'pre-wrap'; target.style.overflowWrap = 'anywhere';
  let state: NamespaceState = { phase: 'idle', history: [] }, namespace = '', enabled = false;
  const field = mountTextField(fieldSlot, { label: 'Namespace', value: namespace, onChange: value => { namespace = value; bridge()?.closeNamespace(); field.update({ value }); } });
  const prepare = mountButton(actions, { label: 'Use Namespace…', disabled: true, onClick: () => { void bridge()?.prepareNamespace(namespace); } });
  const confirm = mountButton(actions, { label: 'Confirm Server kubeconfig write', disabled: true, variant: 'destructive', onClick: () => { void bridge()?.submitNamespace(); } });
  const cancel = mountButton(actions, { label: 'Cancel uncommitted intent', variant: 'outline', onClick: () => bridge()?.closeNamespace() });
  const outcomes = mountButton(actions, { label: 'Read original outcomes', variant: 'outline', onClick: () => { void bridge()?.readNamespaceOutcomes(); } });
  const older = mountButton(actions, { label: 'Older outcomes', variant: 'outline', disabled: true, onClick: () => { void bridge()?.readNamespaceOutcomes(true); } });
  const reload = mountButton(actions, { label: 'Reload configuration (read only)', variant: 'outline', onClick: () => { void bridge()?.reload(); } });
  const operation = mountOperationSummary(document, section, status, locale);
  operation.identifiers.append(target);
  bindScene(section, 'namespace-draft', () => ({ namespace }), value => { namespace = value.namespace; paint(); });
  const paint = () => {
    operation.show(state);
    const zh = locale().startsWith('zh'), value = state.outcome;
    section.setAttribute('aria-label', zh ? '写入Server kubeconfig的Use Namespace' : 'Use Namespace: Server kubeconfig write');
    note.textContent = zh ? '修改当前 context 的默认命名空间，不切换集群或创建 Namespace。缺少 context 条目时会先明确显示创建内容。' : 'Change the current context’s default namespace without switching clusters or creating a Namespace. A missing context entry is explicitly shown before creation.';
    target.textContent = value ? logDisplayText(`${value.contextAction === 'create' ? (zh ? '创建缺失context（仅namespace）' : 'CREATE missing context (namespace only)') : (zh ? '修改已有context' : 'UPDATE existing context')}\n${value.path} · origin ${value.contextOrigin} · ${value.context} · ${value.previous} → ${value.namespace} · ${value.version} · Server ${value.serviceGeneration}\n${value.sources.map((source, index) => `${index + 1}. ${source.path} · ${source.status} · ${source.version ?? '-'} · current-context ${source.currentContext || '(unset)'} · defines-current:${source.definesContext}`).join('\n')}`) : '';
    status.textContent = `${state.phase}${value ? ` · ${value.phase} · ${value.id} · ${value.cleanup}${value.result ? ` · ${value.result}` : ''}${value.code ? ` · ${value.code}` : ''}` : ''}${state.error ? ` · ${state.error}` : ''}${state.expiresAt ? ` · ${new Date(state.expiresAt).toISOString()}` : ''}`;
    field.update({ label: zh ? '目标namespace（名称，不填写配置正文）' : 'Target namespace (name, never configuration text)', disabled: state.phase === 'submitting' });
    prepare.update({ label: zh ? 'Use Namespace…' : 'Use Namespace…', disabled: !enabled || state.phase === 'preparing' || state.phase === 'submitting' });
    confirm.update({ label: zh ? '确认写入上述Server kubeconfig' : 'Confirm writing the Server kubeconfig above', disabled: state.phase !== 'confirm' || !state.expiresAt || Date.now() >= state.expiresAt });
    cancel.update({ label: zh ? '取消尚未提交的替换' : 'Cancel uncommitted replacement' }); outcomes.update({ label: zh ? '读取原操作结果（不重试）' : 'Read original outcomes (no retry)' });
    older.update({ label: zh ? '更早结果' : 'Older outcomes', disabled: !state.next }); reload.update({ label: zh ? '重新读取配置（只读）' : 'Reload configuration (read only)' });
    history.replaceChildren(...state.history.map(value => { const row = document.createElement('p'); row.textContent = logDisplayText(`${value.contextAction} · ${value.path} · origin ${value.contextOrigin} · sources:${value.sources.length} · ${value.context} · ${value.previous} → ${value.namespace} · ${value.id} · Server ${value.serviceGeneration} · ${value.phase} · ${value.cleanup}${value.code ? ` · ${value.code}` : ''}`); return row; }));
  };
  return { show(value: NamespaceState) { state = value; paint(); }, update(available: boolean) { enabled = available; paint(); }, paint,
    dispose() { field.dispose(); for (const button of [prepare, confirm, cancel, outcomes, older, reload]) button.dispose(); namespace = ''; history.replaceChildren(); section.remove(); } };
}
