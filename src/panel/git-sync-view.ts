import { mountButton, mountTextField } from './controls.ts';
import { mountOperationSummary } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { GitSyncState } from '../host/git-sync-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountGitSyncView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Sync from image'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  section.append(note, actions, status); container.append(section);
  let state: GitSyncState = { phase: 'idle', history: [] }, image = '';
  const imageField = mountTextField(actions, { label: 'Container image (tag must be the Git commit ID)', value: '', onChange: value => { image = value; } });
  const prepare = mountButton(actions, { label: 'Prepare Sync (fresh git log probe + confirmation)', onClick: () => { void bridge()?.prepareGitSync(image); } });
  const submit = mountButton(actions, { label: 'Confirm exact checkout (single git checkout)', onClick: () => { void bridge()?.submitGitSync(); } });
  const cancel = mountButton(actions, { label: 'Cancel unsubmitted intent', variant: 'ghost', onClick: () => bridge()?.cancelGitSync() });
  const ledger = mountButton(actions, { label: 'Read original ledger', variant: 'outline', onClick: () => { void bridge()?.gitSyncOutcomes(); } });
  const summary = mountOperationSummary(document, section, status, locale);
  function paint() {
    summary.show(state);
    const zh = locale().startsWith('zh'), value = state.outcome, busy = state.phase === 'preparing' || state.phase === 'submitting';
    note.textContent = zh ? '将工作区切换到镜像标签对应的 Git 提交。这会改变检出的文件，不会强制丢弃本地修改。' : 'Check out the Git commit identified by the image tag. This changes checked-out files without forcibly discarding local edits.';
    prepare.update({ label: zh ? '检查 Git 提交' : 'Review Git revision', disabled: busy || !image });
    submit.update({ label: zh ? '确认切换到此提交' : 'Confirm checkout', disabled: busy || state.phase !== 'confirm' });
    cancel.update({ label: zh ? '取消尚未提交意图' : 'Cancel unsubmitted intent', disabled: state.phase !== 'confirm' });
    ledger.update({ label: zh ? '读取原账本' : 'Read original ledger', disabled: busy });
    status.textContent = `${state.phase}${state.error ? ` · ${state.error}` : ''}${value ? `\n${value.parameters.commitId} · ${value.phase} ${value.code ?? ''} · r${value.updatedAt}` : ''} · ledger ${state.history.length}`;
  }
  bindScene(section, 'git-sync', () => ({ image }), value => { image = value.image; paint(); });
  return { show(value: GitSyncState) { state = value; paint(); }, paint, dispose() { for (const control of [imageField, prepare, submit, cancel, ledger]) control.dispose(); section.remove(); } };
}
