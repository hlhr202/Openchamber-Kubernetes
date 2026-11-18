import { mountButton, mountTextField } from './controls.ts';
import { phaseLabel } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { SourcePickerState } from '../host/source-picker-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { sourceChildPath } from '../shared/source-picker-protocol.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';

export function mountSourcePickerView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), slot = document.createElement('div'), label = document.createElement('label'), hidden = document.createElement('input'), hiddenText = document.createElement('span');
  hidden.type = 'checkbox'; label.append(hidden, hiddenText);
  const actions = document.createElement('div'), status = document.createElement('p'), rows = document.createElement('div'); status.setAttribute('role', 'status'); actions.className = 'configuration-actions';
  section.append(note, slot, label, actions, status, rows); container.append(section);
  let directory = '', state: SourcePickerState = { phase: 'idle' }; const buttons: (() => void)[] = [];
  const field = mountTextField(slot, { label: 'Server directory (explicit read)', value: directory, onChange: value => { directory = value; field.update({ value }); bridge()?.closeSourcePicker(); } });
  const open = (path: string) => { directory = path; field.update({ value: path }); void bridge()?.readSourceDirectory(path, hidden.checked); };
  const read = mountButton(actions, { label: 'List directory names', onClick: () => open(directory) });
  const parent = mountButton(actions, { label: 'Parent directory', variant: 'outline', disabled: true, onClick: () => { if (state.page?.parent) open(state.page.parent); } });
  const next = mountButton(actions, { label: 'Next files', variant: 'outline', disabled: true, onClick: () => { void bridge()?.nextSourceFiles(); } });
  const close = mountButton(actions, { label: 'Close file choices', variant: 'outline', onClick: () => bridge()?.closeSourcePicker() });
  const invalidate = () => bridge()?.closeSourcePicker(); hidden.addEventListener('change', invalidate);
  bindScene(section, 'source-picker', () => ({ directory }), value => { directory = value.directory; paint(); });
  const paint = () => {
    const zh = locale().startsWith('zh'), ready = state.phase === 'ready'; for (const dispose of buttons.splice(0)) dispose();
    section.setAttribute('aria-label', zh ? '显式Server配置文件选择（仅读目录名称）' : 'Explicit Server kubeconfig file choices (directory names only)');
    note.textContent = zh ? '浏览服务器上的配置文件，不是上传本机文件。选择后填入路径，再点击“读取配置”；不会自动保存或写入。' : 'Browse Server configuration files, not local uploads. Choose a path, then Read configuration. Nothing is saved or written automatically.';
    field.update({ label: zh ? 'Server目录绝对路径（明确读取）' : 'Absolute Server directory (explicit read)', disabled: state.phase === 'loading' });
    hiddenText.textContent = zh ? '显示隐藏名称（只在下次明确读取时）' : 'Show hidden names (on the next explicit read)';
    read.update({ label: zh ? '列出目录名称（只读）' : 'List directory names (read only)', disabled: state.phase === 'loading' });
    parent.update({ label: zh ? '读取父目录' : 'Read parent directory', disabled: !ready || !state.page?.parent }); next.update({ label: zh ? '下一页名称' : 'Next names', disabled: !ready || state.page?.nextOffset == null });
    close.update({ label: zh ? '关闭目录选择' : 'Close file choices' }); status.textContent = logDisplayText(`${phaseLabel(state.phase, zh)}${state.page ? ` · ${state.page.directory} · ${state.page.offset + state.page.entries.length}/${state.page.total}` : ''}${state.error ? ` · ${state.error}` : ''}`);
    rows.replaceChildren(...(state.page?.entries ?? []).map(entry => {
      const row = document.createElement('div'), text = document.createElement('span'); text.textContent = logDisplayText(`${entry.name} · ${entry.kind} `); row.append(text);
      const add = (label: string, click: () => void) => { const button = mountButton(row, { label, variant: 'outline', disabled: !ready, onClick: click }); buttons.push(() => button.dispose()); };
      if (entry.kind === 'directory') add(zh ? '读取此目录' : 'Read directory', () => { if (state.page) open(sourceChildPath(state.page.directory, entry.name)); });
      if (entry.kind === 'file') { add(zh ? '填为单文件来源' : 'Fill single-file source', () => bridge()?.pickSourceFile(entry.name, false)); add(zh ? '追加到有序来源草稿' : 'Append to ordered draft', () => bridge()?.pickSourceFile(entry.name, true)); }
      return row;
    }));
  };
  return { show(value: SourcePickerState) { state = value; paint(); }, paint, reset() { directory = ''; hidden.checked = false; field.update({ value: '' }); state = { phase: 'idle' }; paint(); },
    dispose() { hidden.removeEventListener('change', invalidate); for (const dispose of buttons.splice(0)) dispose(); for (const button of [read, parent, next, close]) button.dispose(); field.dispose(); rows.replaceChildren(); section.remove(); } };
}
