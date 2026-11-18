import { mountButton, mountSelect, mountTextField } from './controls.ts';
import { mountOperationSummary } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { ManifestCreateState } from '../host/manifest-create-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountManifestCreateView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), fields = document.createElement('div'), actions = document.createElement('div'), status = document.createElement('pre'), history = document.createElement('div');
  section.append(note, fields, actions, status, history); actions.className = 'configuration-actions'; status.style.whiteSpace = 'pre-wrap'; status.style.overflowWrap = 'anywhere'; status.setAttribute('role', 'status'); container.append(section);
  let kind: 'scratch' | 'live' | 'file' | 'disk' = 'scratch', format: 'yaml' | 'json' = 'yaml', text = '', revision = 0, start = '', end = '', path = '', state: ManifestCreateState = { phase: 'idle', history: [], queryable: [], next: null };
  const historyButtons: { dispose(): void }[] = [], changed = () => { revision++; bridge()?.invalidateManifestCreate(); };
  const source = mountSelect(fields, { label: 'Create source', value: kind, options: [], onChange: value => { if (value === 'scratch' || value === 'live' || value === 'file' || value === 'disk') { kind = value; changed(); paint(); } } });
  const language = mountSelect(fields, { label: 'Format', value: format, options: [{ id: 'yaml', label: 'YAML' }, { id: 'json', label: 'JSON' }], onChange: value => { if (value === 'yaml' || value === 'json') { format = value; changed(); } } });
  const input = mountTextField(fields, { label: 'Explicit untitled manifest (memory only)', value: '', multiline: true, mono: true, onChange: value => { text = value; changed(); } });
  const from = mountTextField(fields, { label: 'Optional selection start UTF-16', value: '', onChange: value => { start = value; changed(); } });
  const to = mountTextField(fields, { label: 'Optional selection end UTF-16', value: '', onChange: value => { end = value; changed(); } });
  const diskPath = mountTextField(fields, { label: 'Create File: explicit root-relative Server path', value: '', onChange: value => { path = value; changed(); } });
  const opened = mountButton(actions, { label: 'Use opened file path (no read/write)', variant: 'ghost', onClick: () => {
    path = bridge()?.manifestCreateFileLocation().path ?? ''; diskPath.update({ value: path }); changed();
  } });
  const save = mountButton(actions, { label: 'Prepare separate Save for ordinary dirty file', variant: 'outline', onClick: () => { void bridge()?.prepareFileSaveForCreate(); } });
  const prepare = mountButton(actions, { label: 'Prepare Create (uploads explicit snapshot)', onClick: () => {
    if (kind === 'disk') { void bridge()?.prepareManifestCreateFile(path, format); return; }
    if ((start || end) && (!/^\d+$/.test(start) || !/^\d+$/.test(end))) { status.textContent = 'INVALID_INPUT'; return; }
    void bridge()?.prepareManifestCreate(kind, text, format, revision, start || end ? { start: Number(start), end: Number(end) } : undefined);
  } });
  const submit = mountButton(actions, { label: 'Confirm exact Create', onClick: () => { void bridge()?.submitManifestCreate(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted Create', variant: 'outline', onClick: () => { void bridge()?.cancelManifestCreate(); } });
  const poll = mountButton(actions, { label: 'Query original result (no retry)', variant: 'outline', onClick: () => { void bridge()?.manifestCreateStatus(); } });
  const ledger = mountButton(actions, { label: 'Read original Create ledger', variant: 'ghost', onClick: () => { void bridge()?.manifestCreateOutcomes(); } });
  const next = mountButton(actions, { label: 'Next ledger page', variant: 'ghost', onClick: () => { void bridge()?.manifestCreateOutcomes(true); } });
  const summary = mountOperationSummary(document, section, status, locale);
  bindScene(section, 'manifest-create', () => ({ kind, format, text, revision, start, end, path }), value => {
    kind = value.kind; format = value.format; text = value.text; revision = value.revision; start = value.start; end = value.end; path = value.path; paint();
  });
  function paint() {
    summary.show(state);
    const zh = locale().startsWith('zh'), busy = state.phase === 'preparing' || state.phase === 'submitting', value = state.outcome;
    section.setAttribute('aria-label', zh ? '明确清单Create（非Apply）' : 'Explicit manifest Create (not Apply)'); section.setAttribute('aria-busy', String(busy));
    note.textContent = zh ? '在集群创建所列资源，不是预览。完整文件须先保存成功；逐项创建，失败或结果未知即停止，已创建资源不会回滚。' : 'Create the listed resources in the cluster, not a preview. Save whole files first. Failure or an unknown outcome stops later items without rolling back created resources.';
    source.update({ label: zh ? 'Create明确来源' : 'Explicit Create source', disabled: busy, options: [{ id: 'scratch', label: zh ? '明确untitled内存草稿' : 'Explicit untitled memory draft' }, { id: 'live', label: zh ? '非file Load完整缓冲/选区' : 'Non-file Load buffer / selection' }, { id: 'file', label: zh ? '普通文件Create（dirty先Save）/选区' : 'Ordinary file Create (Save dirty first) / selection' }, { id: 'disk', label: zh ? 'Create File（独立磁盘来源）' : 'Create File (independent disk source)' }] });
    language.update({ label: zh ? '草稿/文件选区格式（Load沿原格式）' : 'Draft/file selection format (Load retains original)', disabled: busy }); input.update({ label: zh ? '明确untitled清单（只驻内存）' : 'Explicit untitled manifest (memory only)', disabled: busy || kind !== 'scratch' });
    from.update({ label: zh ? '选区开始UTF-16（可空）' : 'Selection start UTF-16 (optional)', disabled: busy || kind === 'disk' }); to.update({ label: zh ? '选区结束UTF-16（可空）' : 'Selection end UTF-16 (optional)', disabled: busy || kind === 'disk' });
    diskPath.update({ label: `${zh ? 'Create File相对路径；选定Server根' : 'Create File relative path; pinned Server root'}: ${bridge()?.manifestCreateFileLocation().root ?? '-'}`, disabled: busy || kind !== 'disk' });
    opened.update({ label: zh ? '仅填入已打开文件路径' : 'Fill opened file path only', disabled: busy || kind !== 'disk' });
    save.update({ label: zh ? '为普通文件先准备独立Save确认（不Create）' : 'Prepare separate Save confirmation for ordinary file (no Create)', disabled: busy || kind !== 'file' || !!start || !!end });
    prepare.update({ label: zh ? '检查创建内容' : 'Review resources', disabled: busy || !!value && !['succeeded', 'failed', 'cancelled', 'unknown'].includes(value.phase) });
    submit.update({ label: zh ? '确认创建所列资源' : 'Confirm creating listed resources', disabled: busy || state.phase !== 'confirm' || !!state.submitted || value?.phase !== 'prepared' || !!value && Date.now() >= value.expiresAt });
    cancel.update({ label: zh ? '取消未提交Create' : 'Cancel unsubmitted Create', disabled: busy || !!state.submitted || !value || !['uploading', 'prepared'].includes(value.phase) });
    poll.update({ label: zh ? '查询原结果（不重试）' : 'Query original result (no retry)', disabled: busy || !value }); ledger.update({ label: zh ? '读取Create原账本' : 'Read original Create ledger', disabled: busy }); next.update({ label: zh ? '下一账本页' : 'Next ledger page', disabled: busy || !state.next });
    status.textContent = `${state.phase}${state.error ? ` · ${state.error}` : ''}${value ? `\n${value.target.context}/${value.target.namespace} · ${value.phase} · ${value.code ?? '-'} · cleanup ${value.cleanup}\nsource ${value.source.kind} r${value.source.revision} SHA-256 ${value.source.identity}${value.source.file ? `\nServer file ${value.source.file.root}/${value.source.file.path} · ${value.source.file.receipt ? 'original Save receipt' : 'original read proof'} · version ${value.source.file.version}` : ''}\npayload ${value.received}/${value.bytes} bytes SHA-256 ${value.digest}\nexpires ${new Date(value.expiresAt).toISOString()}\n${value.steps.map(item => `${item.index + 1} · ${item.locator.group}/${item.locator.version}/${item.locator.kind} · ${item.reference?.namespace ?? item.locator.namespace ?? '(cluster/default pending)'} / ${item.locator.name} · ${item.phase} · ${item.code ?? '-'}`).join('\n')}` : ''}`;
    if (state.submitted) status.textContent += zh ? '\n提交已尝试：仅查原结果，不重发/回滚。' : '\nSubmission attempted: query original result only, never replay/rollback.';
    for (const button of historyButtons.splice(0)) button.dispose(); history.replaceChildren();
    for (const row of state.history) { const label = document.createElement('p'); label.textContent = `${row.target.context}/${row.target.namespace} · ${row.phase} · ${row.steps.filter(item => item.phase === 'succeeded').length}/${row.steps.length} · ${row.code ?? '-'} · ${row.cleanup}`; history.append(label);
      historyButtons.push(mountButton(history, { label: zh ? '查询此原操作' : 'Query original operation', variant: 'ghost', disabled: busy || !state.queryable.includes(row.id), onClick: () => { void bridge()?.manifestCreateStatus(row.id); } })); }
  }
  return { show(value: ManifestCreateState) { state = value; paint(); }, paint, resetDraft() { text = ''; start = ''; end = ''; path = ''; revision++; input.update({ value: '' }); from.update({ value: '' }); to.update({ value: '' }); diskPath.update({ value: '' }); },
    dispose() { for (const button of historyButtons) button.dispose(); for (const control of [source, language, input, from, to, diskPath, opened, save, prepare, submit, cancel, poll, ledger, next]) control.dispose(); text = ''; section.remove(); } };
}
