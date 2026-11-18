import { mountButton } from './controls.ts';
import type { NamespaceDeleteState } from '../host/namespace-delete-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
import { mountOperationSummary } from './presentation.ts';

export function mountNamespaceDeleteView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), target = document.createElement('p'), status = document.createElement('p'), initial = document.createElement('div'), contents = document.createElement('div'), actions = document.createElement('div'), history = document.createElement('div');
  status.setAttribute('role', 'status'); actions.className = 'configuration-actions'; section.append(note, target, status, initial, contents, actions, history); container.append(section);
  target.style.whiteSpace = 'pre-wrap'; target.style.overflowWrap = 'anywhere';
  const consent = (parent: HTMLElement) => { const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span'); input.type = 'checkbox'; label.append(input, text); parent.append(label); return { label, input, text }; };
  const general = consent(initial), dangerous = consent(initial), content = consent(contents);
  let state: NamespaceDeleteState = { phase: 'idle', history: [] };
  const prepare = mountButton(actions, { label: 'Confirm risks and check contents', variant: 'destructive', disabled: true, onClick: () => { void bridge()?.prepareNamespaceDelete(general.input.checked, dangerous.input.checked); } });
  const submit = mountButton(actions, { label: 'Confirm original Namespace deletion', variant: 'destructive', disabled: true, onClick: () => { void bridge()?.submitNamespaceDelete(content.input.checked); } });
  const cancel = mountButton(actions, { label: 'Cancel unstarted steps / close view', variant: 'outline', onClick: () => bridge()?.closeNamespaceDelete() });
  const outcomes = mountButton(actions, { label: 'Read original step outcomes', variant: 'outline', onClick: () => { void bridge()?.readNamespaceDeleteOutcomes(); } });
  const older = mountButton(actions, { label: 'Older outcomes', variant: 'outline', disabled: true, onClick: () => { void bridge()?.readNamespaceDeleteOutcomes(true); } });
  const reload = mountButton(actions, { label: 'Reload configuration (read only)', variant: 'outline', onClick: () => { void bridge()?.reload(); } });
  const operation = mountOperationSummary(document, section, status, locale);
  const paint = () => {
    operation.show(state);
    const zh = locale().startsWith('zh'), ref = state.outcome?.reference ?? state.intent?.reference, value = state.outcome, scope = state.outcome?.target ?? state.intent?.target;
    section.setAttribute('aria-label', zh ? 'Namespace删除逐步骤确认及原结果' : 'Namespace deletion: per-step confirmation and original outcomes');
    note.textContent = zh ? '危险操作：删除 Namespace 及其中资源。内容检查失败不代表为空。删除当前命名空间前会先将配置切回 default；已成功步骤不回滚。' : 'Danger: delete the Namespace and its resources. Failed inventory does not mean empty. Deleting the current namespace first switches configuration to default; completed steps are not rolled back.';
    target.textContent = ref && scope ? logDisplayText(`${scope.context} / Namespace ${ref.name} · UID ${ref.uid} · RV ${ref.resourceVersion} · Server ${scope.serviceGeneration}${value ? ` · write ${value.path ?? '(none)'} · origin ${value.contextOrigin} · ${value.version}\n${value.sources.map((source, index) => `${index + 1}. ${source.path} · ${source.status} · ${source.version ?? '-'} · current-context ${source.currentContext || '(unset)'} · defines-current:${source.definesContext}`).join('\n')}` : ''}`) : '';
    initial.hidden = state.phase !== 'initial'; dangerous.label.hidden = ref?.name !== 'default'; contents.hidden = state.phase !== 'confirm';
    general.text.textContent = zh ? '我确认删除上述原Namespace及其资源。' : 'I confirm deletion of the original Namespace and its resources above.';
    dangerous.text.textContent = zh ? '我知道删除default不被建议，仍选择继续。' : 'Deleting default is inadvisable; I understand and still choose to continue.';
    const requiresContents = value?.inventory.status === 'unknown' || value?.inventory.count !== 0;
    content.label.hidden = !requiresContents;
    content.text.textContent = value?.inventory.status === 'unknown' ? (zh ? `无法确定内容（${value.inventory.code}），不是空；我仍确认可以删除。` : `Contents could not be determined (${value.inventory.code}), not empty; I still confirm deletion is safe.`)
      : zh ? `本次preferred资源枚举${value?.inventory.count ?? 0}项（${value?.inventory.types ?? 0}种），我不需要它们并确认删除。` : `This preferred-resource inventory found ${value?.inventory.count ?? 0} entries (${value?.inventory.types ?? 0} types); I do not need them and confirm deletion.`;
    status.textContent = `${state.phase}${value ? ` · ${value.phase} · ${value.id} · switch-default:${value.switchDefault.phase}/${value.switchDefault.cleanup} → delete-namespace:${value.deleteNamespace.phase}${value.code ? ` · ${value.code}` : ''}` : ''}${state.error ? ` · ${state.error}` : ''}${state.expiresAt ? ` · ${new Date(state.expiresAt).toISOString()}` : ''}`;
    prepare.update({ label: zh ? '确认上述风险并检查内容' : 'Confirm risks above and check contents', disabled: state.phase !== 'initial' || !general.input.checked || (ref?.name === 'default' && !dangerous.input.checked) });
    submit.update({ label: zh ? '确认删除此原Namespace' : 'Confirm deletion of this original Namespace', disabled: state.phase !== 'confirm' || !state.expiresAt || Date.now() >= state.expiresAt || (requiresContents && !content.input.checked) });
    cancel.update({ label: zh ? '取消未开始步骤 / 关闭视图' : 'Cancel unstarted steps / close view' }); outcomes.update({ label: zh ? '读取原操作逐步骤结果（不重试）' : 'Read original step outcomes (no retry)' });
    older.update({ label: zh ? '更早结果' : 'Older outcomes', disabled: !state.next }); reload.update({ label: zh ? '重新读取配置（只读，会关闭当前意图）' : 'Reload configuration (read only; closes current intent)' });
    history.replaceChildren(...state.history.map(value => { const row = document.createElement('p'); row.textContent = logDisplayText(`${value.target.context} / Namespace ${value.reference.name} · UID ${value.reference.uid} · ${value.id} · Server ${value.serviceGeneration} · origin ${value.contextOrigin} · sources:${value.sources.length} · ${value.phase} · switch-default:${value.switchDefault.phase}/${value.switchDefault.cleanup} → delete-namespace:${value.deleteNamespace.phase}${value.code ? ` · ${value.code}` : ''}`); return row; }));
  };
  for (const control of [general, dangerous, content]) control.input.addEventListener('change', paint);
  return { show(value: NamespaceDeleteState) { if (value.phase === 'initial' || value.phase === 'idle') for (const control of [general, dangerous, content]) control.input.checked = false; state = value; paint(); }, paint,
    dispose() { for (const control of [general, dangerous, content]) control.input.removeEventListener('change', paint); for (const button of [prepare, submit, cancel, outcomes, older, reload]) button.dispose(); history.replaceChildren(); section.remove(); } };
}
