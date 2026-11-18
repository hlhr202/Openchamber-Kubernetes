import { mountTextField as mountSdkTextField, mountSelect as mountSdkSelect, mountButton as mountSdkButton } from '@openchamber/sdk/ui';
import { bindScene } from './workspace-scene.ts';
import { changedPresentationProps } from '../shared/presentation-state.ts';

const labels: Readonly<Record<string, string>> = {
  'Read original ledger': 'Operation history', '读取原账本': '操作记录',
  'Older ledger page': 'Older operations', '较旧账本页': '更早记录',
  'Cancel unsubmitted intent': 'Cancel before submit', '取消尚未提交意图': '取消未提交操作',
  'Read original result (no replay)': 'Check original operation', '手动查原结果（不重放）': '查询原操作',
};
export function mountButton(root: Element, props: Parameters<typeof mountSdkButton>[1]) {
  let current = { ...props, label: labels[props.label] ?? props.label };
  const control = mountSdkButton(root, current);
  const element = root.lastElementChild as HTMLElement | null;
  const action = /^Confirm\b/.test(props.label) ? 'confirm' : /^Cancel\b/.test(props.label) ? 'cancel'
    : /ledger|original outcomes|Older outcomes/i.test(props.label) ? 'history' : /^Prepare\b/.test(props.label) ? 'prepare' : '';
  if (element && action) element.dataset.operationAction = action;
  let disabled = props.disabled ?? false;
  const optional = action === 'confirm' || action === 'cancel' || /^(?:Older|Previous|Next|Read next)\b/.test(props.label);
  const paint = () => { if (element && optional && element.hidden !== disabled) element.hidden = disabled; };
  paint();
  return { dispose: control.dispose, update(next: Parameters<typeof control.update>[0]) {
    if (next.disabled !== undefined) disabled = next.disabled;
    const changed = changedPresentationProps(current, { ...next, ...(next.label === undefined ? {} : { label: labels[next.label] ?? next.label }) });
    if (changed) { current = { ...current, ...changed }; control.update(changed); } paint();
  } };
}

// Commit the proposed input before any caller-triggered repaint. Several task
// views keep drafts in closure variables; SDK updates must not restore old props.
export function mountTextField(root: Element, props: Parameters<typeof mountSdkTextField>[1]) {
  let current = { ...props };
  const update = (next: Parameters<typeof field.update>[0]) => {
    const changed = changedPresentationProps(current, next);
    if (changed) { current = { ...current, ...changed }; field.update(changed); }
  };
  let currentValue = props.value;
  const field = mountSdkTextField(root, { ...props, onChange(value) {
    currentValue = value; update({ value }); props.onChange(value);
  } });
  bindScene(root, 'text-field', () => ({ value: currentValue }), value => { currentValue = value.value; update({ value: currentValue }); }, 'control');
  const input = root.lastElementChild?.querySelector('input, textarea');
  if (input) {
    input.setAttribute('autocomplete', 'off');
    if (props.mono) input.setAttribute('spellcheck', 'false');
    if (props.label) input.setAttribute('aria-label', props.label);
  }
  return { dispose: field.dispose, update(next: Parameters<typeof field.update>[0]) {
    update(next);
    if (next.value !== undefined) currentValue = next.value;
    if (next.label !== undefined && input?.getAttribute('aria-label') !== next.label) input?.setAttribute('aria-label', next.label);
  } };
}
export function mountSelect(root: Element, props: Parameters<typeof mountSdkSelect>[1]) {
  let current = { ...props };
  const update = (next: Parameters<typeof field.update>[0]) => {
    const changed = changedPresentationProps(current, next);
    if (changed) { current = { ...current, ...changed }; field.update(changed); }
  };
  let currentValue = props.value;
  const field = mountSdkSelect(root, { ...props, onChange(value) {
    currentValue = value; update({ value }); props.onChange(value);
  } });
  bindScene(root, 'select-field', () => ({ value: currentValue }), value => { currentValue = value.value; update({ value: currentValue }); }, 'control');
  return { dispose: field.dispose, update(next: Parameters<typeof field.update>[0]) { if (next.value !== undefined) currentValue = next.value; update(next); } };
}
