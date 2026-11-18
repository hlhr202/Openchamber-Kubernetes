import { mountButton, mountTextField } from './controls.ts';
import { mountOperationSummary } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { ScaleState } from '../host/scale-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import type { DocumentReference } from '../shared/document-protocol.ts';
export function mountScaleView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Scale resource'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  section.append(note, actions, status); container.append(section);
  let state: ScaleState = { phase: 'idle', history: [] }, reference: DocumentReference | undefined, replicas = '';
  const kind = mountTextField(actions, { label: 'Target group/version/resource (from selected tree node)', value: '', onChange: () => {} });
  const name = mountTextField(actions, { label: 'Target name/namespace (read-only)', value: '', onChange: () => {} });
  const input = mountTextField(actions, { label: 'Replicas (non-negative integer)', value: '', onChange: value => { replicas = value; } });
  const prepare = mountButton(actions, { label: 'Prepare Scale (fresh proof + limited confirmation)', onClick: () => { if (reference) void bridge()?.prepareScale(reference, replicas); } });
  const submit = mountButton(actions, { label: 'Confirm exact target/replicas Scale', onClick: () => { void bridge()?.submitScale(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted intent', variant: 'ghost', onClick: () => bridge()?.cancelScale() });
  const ledger = mountButton(actions, { label: 'Read original ledger', variant: 'outline', onClick: () => { void bridge()?.scaleOutcomes(); } });
  const next = mountButton(actions, { label: 'Older ledger page', variant: 'ghost', onClick: () => { void bridge()?.scaleOutcomes(true); } });
  const summary = mountOperationSummary(document, section, status, locale);
  function paint() {
    summary.show(state);
    const zh = locale().startsWith('zh'), value = state.outcome, busy = state.phase === 'preparing' || state.phase === 'submitting';
    note.textContent = zh ? '调整副本数，0 表示缩容到零。确认后立即修改集群；GitOps 管理的资源应先更新仓库。' : 'Change replicas; 0 scales to zero. Confirmation modifies the cluster. For GitOps-managed resources, update the repository first.';
    kind.update({ label: zh ? '目标 group/version/resource' : 'Target group/version/resource', disabled: true });
    name.update({ label: zh ? '目标 namespace/name（只读）' : 'Target namespace/name (read-only)', disabled: true });
    input.update({ label: zh ? 'replicas（非负整数）' : 'Replicas (non-negative integer)', disabled: busy });
    prepare.update({ label: zh ? '检查变更' : 'Review change', disabled: busy || !reference });
    submit.update({ label: zh ? '确认调整副本数' : 'Confirm scaling', disabled: busy || state.phase !== 'confirm' });
    cancel.update({ label: zh ? '取消尚未提交意图' : 'Cancel unsubmitted intent', disabled: state.phase !== 'confirm' });
    ledger.update({ label: zh ? '读取原账本' : 'Read original ledger', disabled: busy }); next.update({ label: zh ? '较旧账本页' : 'Older ledger page', disabled: !state.next || busy });
    status.textContent = `${state.phase}${state.error ? ` · ${state.error}` : ''}${reference ? `\ntarget ${reference.type.group || 'core'}/${reference.type.version}/${reference.type.resource} ${reference.namespace ?? '(cluster)'}/${reference.name}` : ''}${value ? `\nreplicas → ${value.parameters.replicas} · ${value.phase} ${value.code ?? ''} · r${value.updatedAt}` : ''} · ledger ${state.history.length}`;
  }
  bindScene(section, 'scale', () => ({ reference, replicas }), value => { reference = value.reference; replicas = value.replicas; paint(); });
  return { show(value: ScaleState) { state = value; paint(); }, target(ref: DocumentReference | undefined) {
    reference = ref; kind.update({ value: ref ? `${ref.type.group || 'core'}/${ref.type.version}/${ref.type.resource}` : '' }); name.update({ value: ref ? `${ref.namespace ?? '(cluster)'}/${ref.name}` : '' }); paint();
  }, paint, dispose() { for (const control of [kind, name, input, prepare, submit, cancel, ledger, next]) control.dispose(); section.remove(); } };
}
