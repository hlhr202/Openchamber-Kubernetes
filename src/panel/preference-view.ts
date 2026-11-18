import { mountButton } from './controls.ts';
import type { PreferenceState } from '../host/preference-client.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
import { mountOperationSummary } from './presentation.ts';

const label = (value: ConfigSelection) => value.mode === 'default' ? 'Default' : value.mode === 'file' ? value.path : value.paths.join(' → ');
export function mountPreferenceView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, selection: () => ConfigSelection, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), status = document.createElement('p'), target = document.createElement('p'), actions = document.createElement('div'), known = document.createElement('div'), conflicts = document.createElement('div'), history = document.createElement('div');
  status.setAttribute('role', 'status'); actions.className = 'configuration-actions'; section.append(note, status, target, actions, known, conflicts, history); container.append(section);
  let state: PreferenceState = { phase: 'idle', history: [] }; const rows: (() => void)[] = [];
  const read = mountButton(actions, { label: 'Read saved sources', variant: 'outline', onClick: () => { void bridge()?.readPreferences(); } });
  const restore = mountButton(actions, { label: 'Load saved active source (read only)', variant: 'outline', onClick: () => { void bridge()?.readPreferences(true); } });
  const add = mountButton(actions, { label: 'Remember and use source above…', onClick: () => { try { void bridge()?.preparePreference('add-use', selection()); } catch { status.textContent = 'INVALID_INPUT'; } } });
  const submit = mountButton(actions, { label: 'Confirm saved-source changes', variant: 'destructive', disabled: true, onClick: () => { void bridge()?.submitPreference(); } });
  const cancel = mountButton(actions, { label: 'Cancel unstarted steps', variant: 'outline', onClick: () => bridge()?.closePreference() });
  const operation = mountOperationSummary(document, section, status, locale);
  const paint = () => {
    operation.show(state);
    const zh = locale().startsWith('zh'), busy = state.phase === 'reading' || state.phase === 'running', value = state.outcome;
    for (const dispose of rows.splice(0)) dispose();
    section.setAttribute('aria-label', zh ? 'Server已知配置与active来源偏好' : 'Server known kubeconfigs and active source preferences');
    note.textContent = zh ? '记住所选配置路径，不保存凭证正文。同一服务器用户共享这些偏好；移除记录不会删除文件或更改当前来源。' : 'Remember configuration paths, not credential contents. Preferences are shared by the same Server user; removing a record does not delete files or change the active source.';
    status.textContent = `${state.phase}${state.ledger ? ` · revisions:${state.ledger.revisions.length} · heads:${state.ledger.heads.length}${state.ledger.conflict ? ' · CONFLICT' : ''}` : ''}${value ? ` · ${value.serviceGeneration} · ${value.id} · ${value.phase} · known:${value.known} → active:${value.active}${value.code ? ` · ${value.code}` : ''}` : ''}${state.error ? ` · ${state.error}` : ''}`;
    target.textContent = logDisplayText(value ? `${value.kind} · ${label(value.selection)}${state.expiresAt ? ` · ${new Date(state.expiresAt).toISOString()}` : ''}` : state.ledger?.preferences ? `saved active: ${label(state.ledger.preferences.active)}` : '');
    read.update({ label: zh ? '读取已保存来源' : 'Read saved sources', disabled: busy }); restore.update({ label: zh ? '加载已保存active（只读）' : 'Load saved active (read only)', disabled: busy || !!state.ledger?.conflict });
    add.update({ label: zh ? '记住并使用上方来源…' : 'Remember and use source above…', disabled: busy || !!state.ledger?.conflict });
    submit.update({ label: zh ? '确认上述来源偏好变更' : 'Confirm source preference changes above', disabled: state.phase !== 'confirm' || !state.expiresAt || Date.now() >= state.expiresAt });
    cancel.update({ label: zh ? '取消未开始步骤' : 'Cancel unstarted steps' });
    known.replaceChildren(...(state.ledger?.preferences?.known ?? []).map(value => {
      const row = document.createElement('div'), text = document.createElement('span'), slot = document.createElement('span'); text.textContent = logDisplayText(label(value)); row.append(text, slot);
      const use = mountButton(slot, { label: zh ? '使用…' : 'Use…', variant: 'outline', disabled: busy, onClick: () => { void bridge()?.preparePreference('use', value); } });
      const remove = mountButton(slot, { label: zh ? '移除known…' : 'Remove known…', variant: 'outline', disabled: busy, onClick: () => { void bridge()?.preparePreference('remove', value); } }); rows.push(() => { use.dispose(); remove.dispose(); }); return row;
    }));
    conflicts.replaceChildren(...(state.ledger?.conflict ? state.ledger.heads : []).map(head => {
      const row = document.createElement('div'), text = document.createElement('span'); text.textContent = logDisplayText(`${head.id} · active ${label(head.preferences.active)} · known [${head.preferences.known.map(label).join(' ; ')}]`); row.append(text);
      const choose = mountButton(row, { label: zh ? '选择此完整偏好分支…' : 'Choose this complete preference branch…', variant: 'outline', disabled: busy, onClick: () => { void bridge()?.preparePreference('resolve', undefined, head.id); } }); rows.push(() => choose.dispose()); return row;
    }));
    history.replaceChildren(...state.history.map(value => { const row = document.createElement('p'); row.textContent = logDisplayText(`${value.serviceGeneration} · ${value.id} · ${value.kind} · ${label(value.selection)} · ${value.phase} · known:${value.known} → active:${value.active} · ${value.revisions.join(',')}${value.code ? ` · ${value.code}` : ''}`); return row; }));
  };
  return { show(value: PreferenceState) { state = value; paint(); }, paint,
    dispose() { for (const dispose of rows.splice(0)) dispose(); for (const button of [read, restore, add, submit, cancel]) button.dispose(); history.replaceChildren(); section.remove(); } };
}
