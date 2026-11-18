import { mountButton, mountTextField } from './controls.ts';
import { phaseLabel } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { WorkspaceState } from '../host/workspace-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountWorkspaceView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), status = document.createElement('p'), fields = document.createElement('div'), actions = document.createElement('div'), editor = document.createElement('div');
  status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere'; actions.className = 'configuration-actions'; section.append(note, fields, actions, status, editor); container.append(section);
  let state: WorkspaceState = { phase: 'idle', stale: false }, rootDraft = '', pathDraft = '', hint: string | null | undefined;
  editor.setAttribute('data-scene-runtime-value', '');
  const root = mountTextField(fields, { label: 'Explicit Server workspace root', value: '', onChange: value => { rootDraft = value; paint(); } });
  const path = mountTextField(fields, { label: 'Relative file path inside that root', value: '', onChange: value => { pathDraft = value; } });
  const content = mountTextField(editor, { label: 'Server file edit buffer — not saved', value: '', multiline: true, mono: true, disabled: true, onChange: value => bridge()?.editWorkspaceFile(value) });
  const connect = mountButton(actions, { label: 'Select read scope', onClick: () => { void bridge()?.openWorkspace(rootDraft); } });
  const read = mountButton(actions, { label: 'Read selected file', onClick: () => { if (rootDraft !== state.scope?.root) return; void bridge()?.readWorkspaceFile(pathDraft); } });
  const reload = mountButton(actions, { label: 'Reload file', variant: 'outline', onClick: () => { if (rootDraft === state.scope?.root && state.file) void bridge()?.readWorkspaceFile(state.file.origin.path, state.file.dirty); } });
  const revert = mountButton(actions, { label: 'Discard edits', variant: 'outline', onClick: () => bridge()?.revertWorkspaceFile() });
  const cancel = mountButton(actions, { label: 'Stop waiting', variant: 'ghost', onClick: () => bridge()?.cancelWorkspaceRead() });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => bridge()?.closeWorkspace(state.file?.dirty ?? false) });
  const rebind = mountButton(actions, { label: 'Re-select original scope; verify file and keep edits', variant: 'outline', onClick: () => { if (rootDraft === state.file?.origin.root) void bridge()?.rebindWorkspace(); } });
  const keepDraft = mountButton(actions, { label: 'Keep conflicted draft; Save As elsewhere only', variant: 'outline', onClick: () => bridge()?.keepWorkspaceDraft() });
  const browser = document.createElement('div'), list = document.createElement('div'); section.insertBefore(browser, editor);
  let browseDraft = '', showHidden = false; const entryButtons: { dispose(): void }[] = [];
  const directoryField = mountTextField(browser, { label: 'Relative directory to browse (empty = root)', value: '', onChange: value => { browseDraft = value; } });
  const browse = mountButton(browser, { label: 'Browse selected scope', variant: 'outline', onClick: () => { if (rootDraft === state.scope?.root) void bridge()?.browseWorkspace(browseDraft, showHidden); } });
  const up = mountButton(browser, { label: 'Parent directory', variant: 'ghost', onClick: () => { if (rootDraft === state.scope?.root && state.listing?.parent !== null && state.listing?.parent !== undefined) { browseDraft = state.listing.parent; directoryField.update({ value: browseDraft }); void bridge()?.browseWorkspace(browseDraft, showHidden); } } });
  const next = mountButton(browser, { label: 'Next file page', variant: 'ghost', onClick: () => { if (rootDraft === state.scope?.root && state.listing) void bridge()?.browseWorkspace(state.listing.path, state.listing.showHidden, true); } });
  const hidden = mountButton(browser, { label: 'Show hidden entries', variant: 'ghost', onClick: () => { if (rootDraft !== state.scope?.root) return; showHidden = !showHidden; void bridge()?.browseWorkspace(state.listing?.path ?? browseDraft, showHidden); } }); browser.append(list);
  bindScene(section, 'workspace-file-view', () => ({ rootDraft, pathDraft, hint, browseDraft, showHidden }), value => {
    rootDraft = value.rootDraft; pathDraft = value.pathDraft; hint = value.hint; browseDraft = value.browseDraft; showHidden = value.showHidden; paint();
  });
  function paint() {
    const zh = locale().startsWith('zh'), loading = state.phase === 'opening' || state.phase === 'loading', currentHint = bridge()?.workspaceDirectory() ?? null;
    if (hint !== currentHint) { hint = currentHint; rootDraft = currentHint ?? ''; pathDraft = ''; root.update({ value: rootDraft }); path.update({ value: '' }); }
    section.setAttribute('aria-label', zh ? 'Server工作区文件读取与独立编辑缓冲' : 'Server workspace file reader and detached buffer'); section.setAttribute('aria-busy', String(loading));
    note.textContent = zh ? '打开服务器文件并编辑。修改仅保留在当前面板，保存和应用到集群是独立操作。' : 'Open and edit Server files. Edits stay in this panel until separately saved or applied to the cluster.';
    root.update({ label: zh ? '明确选择的Server目录（非客户端磁盘）' : 'Explicit Server directory (not client disk)', disabled: loading });
    path.update({ label: zh ? '该目录内的相对文件路径' : 'Relative file path inside that directory', disabled: loading });
    connect.update({ label: zh ? '选择只读目录范围' : 'Select read scope', disabled: loading || !!state.file?.dirty });
    const rootMatches = rootDraft === state.scope?.root;
    rebind.update({ label: zh ? '重选原范围并核原文件，保留编辑' : 'Re-select original scope; verify file and keep edits', disabled: loading || !state.file || rootDraft !== state.file.origin.root });
    keepDraft.update({ label: zh ? '保留冲突草稿继续编辑（仅独立Save As）' : 'Keep conflicted draft; Save As elsewhere only', disabled: loading || !state.file || !state.stale || state.phase !== 'error' });
    browser.hidden = !state.scope; directoryField.update({ label: zh ? '范围内相对目录（空=根）' : 'Relative directory (empty = root)', disabled: loading || !rootMatches });
    browse.update({ label: zh ? '浏览所选范围' : 'Browse selected scope', disabled: loading || !rootMatches });
    up.update({ label: zh ? '上级目录' : 'Parent directory', disabled: loading || !rootMatches || state.listing?.parent === null || state.listing?.parent === undefined });
    next.update({ label: zh ? '下一文件页' : 'Next file page', disabled: loading || !rootMatches || !state.listing?.nextOffset });
    hidden.update({ label: showHidden ? (zh ? '隐藏点文件' : 'Hide hidden entries') : (zh ? '显示点文件' : 'Show hidden entries'), disabled: loading || !rootMatches });
    for (const button of entryButtons.splice(0)) button.dispose(); list.replaceChildren();
    if (state.listing) {
      const info = document.createElement('p'); info.style.overflowWrap = 'anywhere'; info.textContent = `${state.listing.root} / ${state.listing.path || '.'} · ${state.listing.offset + state.listing.entries.length}/${state.listing.total}`; list.append(info);
      for (const entry of state.listing.entries) entryButtons.push(mountButton(list, { label: `${entry.kind} · ${entry.name}`, variant: 'ghost', disabled: loading || !rootMatches || entry.kind === 'blocked', onClick: () => { if (rootDraft === state.scope?.root) void bridge()?.pickWorkspaceEntry(entry.name); } }));
    }
    read.update({ label: zh ? '读取所选文件' : 'Read selected file', disabled: loading || !state.scope || !rootMatches || !!state.file?.dirty });
    reload.update({ label: state.file?.dirty ? (zh ? '丢弃修改并重新读取' : 'Discard edits and reload') : (zh ? '重新读取原文件' : 'Reload original file'), disabled: loading || !rootMatches || !state.file });
    revert.update({ label: zh ? '丢弃修改，恢复原文' : 'Discard edits; restore loaded text', disabled: loading || state.stale || !state.file?.dirty });
    close.update({ label: state.file?.dirty ? (zh ? '丢弃修改并关闭' : 'Discard edits and close') : (zh ? '关闭文件范围' : 'Close file scope'), disabled: state.phase === 'idle' });
    cancel.update({ label: zh ? '停止等待' : 'Stop waiting', disabled: !loading });
    editor.hidden = !state.file; content.update({ label: zh ? '文件内容' : 'File contents', value: state.file?.text ?? '', disabled: loading || state.stale || state.phase !== 'ready' });
    const file = state.file; status.textContent = `${phaseLabel(state.phase, zh)}${state.scope ? ` · ${state.scope.root}${!rootMatches ? (zh ? ' · 请先打开新目录' : ' · Open the new directory first') : ''}` : ''}${state.error ? ` · ${state.error}` : ''}${state.stale ? (zh ? ' · 已过期，请重新核对文件' : ' · Expired; revalidate the file') : ''}${file ? ` · ${file.origin.path} · ${file.dirty ? (zh ? '有未保存修改' : 'Unsaved edits') : (zh ? '未修改' : 'No edits')}` : ''}`;
    if (file?.savedFile) status.textContent += ` · ${zh ? '上次成功Save' : 'Last successful Save'}: ${file.savedFile.root} / ${file.savedFile.path}`;
    if (file?.detached) status.textContent += zh ? ' · 原文件未重新核实：仅能Save As到独立位置，不准覆盖原文件' : ' · original file not revalidated: Save As to a different location only; original replacement blocked';
  }
  return { show(value: WorkspaceState) { state = value; paint(); }, paint, dispose() { for (const button of entryButtons) button.dispose(); directoryField.dispose(); browse.dispose(); up.dispose(); next.dispose(); hidden.dispose(); rebind.dispose(); keepDraft.dispose(); root.dispose(); path.dispose(); content.update({ value: '' }); content.dispose(); connect.dispose(); read.dispose(); reload.dispose(); revert.dispose(); cancel.dispose(); close.dispose(); section.remove(); } };
}
