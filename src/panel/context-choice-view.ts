import { mountButton, mountSelect, mountTextField } from './controls.ts';
import { phaseLabel } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { ContextChoiceState } from '../host/context-choice-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';

export function mountContextChoiceView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), searchSlot = document.createElement('div'), choices = document.createElement('div'), actions = document.createElement('div'), status = document.createElement('p');
  status.setAttribute('role', 'status'); actions.className = 'configuration-actions'; section.append(note, searchSlot, choices, actions, status); container.append(section);
  let search = '', selected = '', available = false, state: ContextChoiceState = { phase: 'idle' };
  const field = mountTextField(searchSlot, { label: 'Inactive context name filter', value: search, onChange: value => { search = value; selected = ''; field.update({ value }); bridge()?.closeContextChoices(); bridge()?.closeContext(); } });
  const select = mountSelect(choices, { label: 'Inactive context (no automatic switch)', value: '', options: [{ id: '', label: 'Choose…' }], onChange: value => { selected = value; bridge()?.closeContext(); select.update({ value }); paint(); } });
  const read = mountButton(actions, { label: 'Read matching inactive contexts', onClick: () => { selected = ''; void bridge()?.readContextChoices(search); } });
  const next = mountButton(actions, { label: 'Next matching contexts', variant: 'outline', disabled: true, onClick: () => { selected = ''; void bridge()?.nextContextChoices(); } });
  const prepare = mountButton(actions, { label: 'Use selected context…', disabled: true, onClick: () => { void bridge()?.chooseContext(selected); } });
  const close = mountButton(actions, { label: 'Close choices', variant: 'outline', onClick: () => bridge()?.closeContextChoices() });
  bindScene(section, 'context-choices', () => ({ search, selected }), value => { search = value.search; selected = value.selected; paint(); });
  const paint = () => {
    const zh = locale().startsWith('zh'), ready = state.phase === 'ready';
    section.setAttribute('aria-label', zh ? 'Use Context非当前条目选择' : 'Use Context inactive context choices');
    note.textContent = zh ? '按名称查找其他 context。选择条目不会切换；使用所选项会修改 kubeconfig，需单独确认。' : 'Find other contexts by name. Selection alone does not switch; using a context changes kubeconfig after separate confirmation.';
    field.update({ label: zh ? '非当前context名称筛选（区分大小写）' : 'Inactive context name filter (case sensitive)', disabled: state.phase === 'loading' });
    select.update({ label: zh ? '选择非当前context（不会自动切换）' : 'Choose inactive context (never auto-switch)', value: selected, disabled: !ready,
      options: [{ id: '', label: zh ? '请选择…' : 'Choose…' }, ...(state.page?.contexts ?? []).map(entry => ({ id: entry.name, label: logDisplayText(`${entry.name} · ${entry.clusterName || '(empty)'} · ${entry.namespace}${entry.available ? '' : ' · missing references'}`) }))] });
    read.update({ label: zh ? '读取匹配的非当前context（只读）' : 'Read matching inactive contexts (read only)', disabled: !available || state.phase === 'loading' });
    next.update({ label: zh ? '下一页匹配项' : 'Next matching choices', disabled: !ready || state.page?.nextOffset == null });
    prepare.update({ label: zh ? '使用所选context…' : 'Use selected context…', disabled: !ready || !state.page?.contexts.some(entry => entry.name === selected) });
    close.update({ label: zh ? '关闭选择' : 'Close choices' }); status.textContent = logDisplayText(`${phaseLabel(state.phase, zh)}${state.page ? ` · ${state.page.contexts.length}/${state.page.total} · ${state.page.currentContext || '—'}` : ''}${state.error ? ` · ${state.error}` : ''}`);
  };
  return { show(value: ContextChoiceState) { state = value; selected = ''; paint(); }, update(value: boolean) { available = value; paint(); }, reset() { search = ''; selected = ''; field.update({ value: '' }); state = { phase: 'idle' }; paint(); },
    dispose() { for (const button of [read, next, prepare, close]) button.dispose(); field.dispose(); select.dispose(); section.remove(); } };
}
