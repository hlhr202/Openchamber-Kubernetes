import { mountButton, mountSelect, mountTextField } from './controls.ts';
import { mountOperationSummary } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { FileSaveState } from '../host/file-save-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountFileSaveView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), fields = document.createElement('div'), actions = document.createElement('div'), status = document.createElement('pre'), history = document.createElement('div');
  status.style.whiteSpace = 'pre-wrap'; status.style.overflowWrap = 'anywhere'; status.setAttribute('role', 'status'); actions.className = 'configuration-actions'; section.append(note, fields, actions, status, history); container.append(section);
  let state: FileSaveState = { phase: 'idle', history: [] }, kind: 'live' | 'file' = 'live', root = '', path = ''; const historyButtons: { dispose(): void }[] = [];
  function changed() { bridge()?.invalidateFileSave(); }
  const source = mountSelect(fields, { label: 'Save source', value: kind, options: [{ id: 'live', label: 'Complete loaded resource buffer' }, { id: 'file', label: 'Complete Server file buffer' }], onChange: value => { if (value !== 'file' && value !== 'live') return; kind = value; changed(); } });
  const rootField = mountTextField(fields, { label: 'Explicit destination Server root', value: root, onChange: value => { root = value; changed(); } });
  const pathField = mountTextField(fields, { label: 'Destination relative file path', value: path, onChange: value => { path = value; changed(); } });
  const previous = mountButton(actions, { label: 'Use original / last saved path', variant: 'outline', onClick: () => {
    const value = bridge()?.fileSaveDefault(kind); if (!value) return; changed(); root = value.root; path = value.path; rootField.update({ value: root }); pathField.update({ value: path });
  } });
  const directory = mountButton(actions, { label: 'Use browsed destination directory', variant: 'outline', onClick: () => {
    const value = bridge()?.workspaceDestinationDirectory(); if (!value) return; changed(); root = value.root;
    const name = path.split('/').at(-1) ?? ''; path = value.path ? `${value.path}/${name}` : name; rootField.update({ value: root }); pathField.update({ value: path });
  } });
  const prepare = mountButton(actions, { label: 'Prepare Save / Save As', onClick: () => { void bridge()?.prepareFileSave(kind, root, path); } });
  const compare = mountButton(actions, { label: 'Compare draft vs current file (external modification)', variant: 'outline', onClick: () => { void compareExternal(); } });
  let comparison: Awaited<ReturnType<NonNullable<ReturnType<typeof bridge>>['compareFileConflict']>> | undefined;
  const compareExternal = async () => {
    comparison = undefined;
    comparison = await bridge()?.compareFileConflict();
    paint();
  };
  const submit = mountButton(actions, { label: 'Confirm exact file Save', onClick: () => { void bridge()?.submitFileSave(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted Save', variant: 'outline', onClick: () => { void bridge()?.cancelFileSave(); } });
  const poll = mountButton(actions, { label: 'Query original result (no retry)', variant: 'outline', onClick: () => { void bridge()?.fileSaveStatus(); } });
  const ledger = mountButton(actions, { label: 'Read service Save ledger', variant: 'ghost', onClick: () => { void bridge()?.fileSaveOutcomes(); } });
  const nextLedger = mountButton(actions, { label: 'Read next ledger page', variant: 'ghost', onClick: () => { void bridge()?.fileSaveOutcomes(true); } });
  const summary = mountOperationSummary(document, section, status, locale);
  function paint() {
    summary.show(state);
    const zh = locale().startsWith('zh'), busy = state.phase === 'preparing' || state.phase === 'submitting', outcome = state.outcome;
    section.setAttribute('aria-label', zh ? '保存到Server文件（不Apply）' : 'Save to Server file (never Apply)'); section.setAttribute('aria-busy', String(busy));
    note.textContent = zh ? '保存到指定服务器文件，不更新集群。覆盖前请核对路径；ACL 和扩展属性可能无法保留，结果未知时不要重复保存。' : 'Save to the selected Server file, not the cluster. Check the path before replacing a file; ACLs and extended attributes may not survive. Do not repeat an unknown save.';
    source.update({ label: zh ? '完整缓冲来源' : 'Complete buffer source', disabled: busy, options: [{ id: 'live', label: zh ? 'Load资源的完整缓冲' : 'Complete loaded resource buffer' }, { id: 'file', label: zh ? 'Server文件的完整缓冲' : 'Complete Server file buffer' }] });
    rootField.update({ label: zh ? '明确的目标Server根目录' : 'Explicit destination Server root', disabled: busy }); pathField.update({ label: zh ? '目标相对文件路径' : 'Destination relative file path', disabled: busy });
    previous.update({ label: zh ? '使用原文件路径' : 'Use original path', disabled: busy });
    directory.update({ label: zh ? '使用已浏览目录' : 'Use browsed directory', disabled: busy });
    prepare.update({ label: zh ? '准备Save / Save As' : 'Prepare Save / Save As', disabled: busy || !!outcome && !['succeeded', 'failed', 'cancelled', 'unknown'].includes(outcome.phase) });
    submit.update({ label: outcome?.action === 'replace' ? (zh ? '确认覆盖此文件与此快照' : 'Confirm replacing this file with this snapshot') : (zh ? '确认新建此文件与此快照' : 'Confirm creating this file with this snapshot'), disabled: busy || !!state.submitted || state.phase !== 'confirm' || outcome?.phase !== 'prepared' });
    cancel.update({ label: zh ? '取消尚未提交的Save' : 'Cancel unsubmitted Save', disabled: busy || !!state.submitted || !outcome || !['uploading', 'prepared'].includes(outcome.phase) });
    poll.update({ label: zh ? '查询原结果（不重试写）' : 'Query original result (no retry)', disabled: busy || !outcome }); ledger.update({ label: zh ? '读取Save原账本' : 'Read service Save ledger', disabled: busy });
    nextLedger.update({ label: zh ? '读取下一账本页' : 'Read next ledger page', disabled: busy || !state.next });
    status.textContent = `${state.phase}${state.error ? ` · ${state.error}` : ''}${outcome ? `\n${outcome.target.root} / ${outcome.target.path}\n${outcome.action} · ${outcome.phase} · ${outcome.result ?? '-'} · ${outcome.code ?? '-'}\n${outcome.received}/${outcome.bytes} bytes · SHA-256 ${outcome.digest}\nmode ${outcome.mode.toString(8)} · version ${outcome.version ?? 'missing'}\nexpires ${new Date(outcome.expiresAt).toISOString()} · cleanup ${outcome.cleanup}${outcome.stagingName ? ` · ${outcome.stagingName}` : ''}` : ''}${comparison ? `\ncompare: ${comparison.equal ? 'identical' : `${comparison.alignment} · local-only ${comparison.localOnly} · file-only ${comparison.liveOnly}`}\nlocal ${comparison.localVersion.slice(0, 12)} vs current ${comparison.currentVersion.slice(0, 12)} → Save As keeps both` : ''}`;
    if (state.submitted) status.textContent += zh ? '\n已尝试提交；不重发或伪装取消，仅查询原结果。' : '\nSubmission attempted; never resend or pretend to revoke it. Query only the original result.';
    for (const button of historyButtons.splice(0)) button.dispose(); history.replaceChildren();
    for (const row of state.history) {
      const text = document.createElement('p'); text.style.overflowWrap = 'anywhere'; text.textContent = `${row.target.root} / ${row.target.path} · ${row.phase} · ${row.code ?? row.result ?? '-'} · ${row.cleanup}`; history.append(text);
      historyButtons.push(mountButton(history, { label: zh ? '查询此原操作（须本视图grant）' : 'Query original operation (requires this view’s grant)', variant: 'ghost', disabled: busy || !state.queryable?.includes(row.id), onClick: () => { void bridge()?.fileSaveStatus(row.id); } }));
    }
  }
  bindScene(section, 'file-save', () => ({ kind, root, path }), value => { kind = value.kind; root = value.root; path = value.path; paint(); });
  return { show(value: FileSaveState) { state = value; paint(); }, showComparison(value: typeof comparison) { comparison = value; paint(); }, paint, dispose() { for (const button of historyButtons) button.dispose(); source.dispose(); rootField.dispose(); pathField.dispose(); previous.dispose(); directory.dispose(); prepare.dispose(); compare.dispose(); submit.dispose(); cancel.dispose(); poll.dispose(); ledger.dispose(); nextLedger.dispose(); section.remove(); } };
}
