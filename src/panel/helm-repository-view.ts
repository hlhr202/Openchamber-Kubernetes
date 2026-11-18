import { mountButton, mountSelect, mountTextField } from './controls.ts';
import { phaseLabel } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import type { HelmRepositoryState } from '../host/helm-repository-client.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
// Explicit cache diagnostics, NOT the final measured Helm Repos tree. Mount never reads a file or downloads.
export function mountHelmRepositoryView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), modeSlot = document.createElement('div'), fields = document.createElement('div'), actions = document.createElement('div'), status = document.createElement('p'), source = document.createElement('p'), list = document.createElement('div');
  actions.className = 'configuration-actions'; list.className = 'configuration-results'; status.setAttribute('role', 'status'); section.append(note, modeSlot, fields, actions, status, source, list); container.append(section);
  let mode: 'default' | 'explicit' = 'default', repositoryFile = '', indexDirectory = '', state: HelmRepositoryState = { phase: 'idle', stale: false }; const rows: Array<() => void> = [];
  const modeSelect = mountSelect(modeSlot, { label: 'Helm source (not saved)', value: mode, options: [{ id: 'default', label: 'Service defaults' }, { id: 'explicit', label: 'Explicit Server paths' }],
    onChange: value => { if (value !== 'default' && value !== 'explicit') return; mode = value; modeSelect.update({ value }); fields.hidden = mode === 'default'; bridge()?.closeHelmRepositories(); } });
  const configField = mountTextField(fields, { label: 'Absolute Server repositories.yaml path (not saved)', value: '', mono: true, onChange: value => { repositoryFile = value; configField.update({ value }); bridge()?.closeHelmRepositories(); } });
  const cacheField = mountTextField(fields, { label: 'Absolute Server existing index directory (not saved)', value: '', mono: true, onChange: value => { indexDirectory = value; cacheField.update({ value }); bridge()?.closeHelmRepositories(); } });
  fields.hidden = true;
  const read = mountButton(actions, { label: 'Read existing Helm repository files', onClick: () => { void bridge()?.readHelmRepositories(mode === 'default' ? { mode: 'default' } : { repositoryFile, indexDirectory }); } });
  const back = mountButton(actions, { label: 'Back', variant: 'outline', disabled: true, onClick: () => { void bridge()?.backHelmRepositories(); } });
  const next = mountButton(actions, { label: 'Next page', variant: 'outline', disabled: true, onClick: () => { void bridge()?.nextHelmRepositories(); } });
  const stop = mountButton(actions, { label: 'Stop waiting', variant: 'ghost', onClick: () => bridge()?.cancelHelmRepositories() });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => bridge()?.closeHelmRepositories() });
  bindScene(section, 'helm-repository-files', () => ({ mode, repositoryFile, indexDirectory }), value => { mode = value.mode; repositoryFile = value.repositoryFile; indexDirectory = value.indexDirectory; paint(); });
  function paint() {
    const zh = locale().toLowerCase().startsWith('zh'), page = state.page, ready = state.phase === 'ready' && !state.stale;
    note.textContent = zh ? '读取服务器已有的仓库配置和缓存索引。找不到时可指定路径；更新索引请使用“刷新仓库索引”任务。' : 'Read existing Server repository configuration and cached indexes. Specify paths if needed; use Refresh repository indexes to update them.';
    modeSelect.update({ label: zh ? 'Helm来源（不保存）' : 'Helm source (not saved)', value: mode,
      options: [{ id: 'default', label: zh ? 'Service默认路径' : 'Service defaults' }, { id: 'explicit', label: zh ? '显式Server路径' : 'Explicit Server paths' }] });
    read.update({ label: zh ? '读取已有Helm文件' : 'Read existing Helm files', disabled: state.phase === 'loading' }); back.update({ label: zh ? '返回' : 'Back', disabled: !ready || page?.branch.kind === 'repositories' });
    next.update({ label: zh ? '下一页' : 'Next page', disabled: !ready || !page?.nextOffset }); stop.update({ label: zh ? '停止等待' : 'Stop waiting', disabled: state.phase !== 'loading' }); close.update({ label: zh ? '关闭' : 'Close' });
    status.textContent = `${phaseLabel(state.phase, zh)}${state.error ? ` · ${state.error}` : ''}${state.stale ? (zh ? ' · 旧结果' : ' · Previous result') : ''}${page ? ` · ${page.offset + page.nodes.length}/${page.total}` : ''}`;
    source.textContent = page ? logDisplayText(`${page.sourceOrigins.repositoryFile}: ${page.resolvedSelection.repositoryFile}\n${page.sourceOrigins.indexDirectory}: ${page.resolvedSelection.indexDirectory}`) : '';
    for (const dispose of rows.splice(0)) dispose(); list.replaceChildren();
    for (const node of page?.nodes ?? []) {
      const row = document.createElement('div'), label = document.createElement('span'); label.textContent = logDisplayText(node.label); row.append(label); list.append(row);
      if (node.kind === 'version') row.title = logDisplayText(node.tooltip);
      else { const action = mountButton(row, { label: zh ? '读取子项' : 'Read children', variant: 'ghost', disabled: !ready, onClick: () => { void bridge()?.openHelmRepositoryNode(node.id); } }); rows.push(() => action.dispose()); }
    }
  }
  return { update(value: HelmRepositoryState) { state = value; paint(); }, paint,
    dispose() { for (const dispose of rows.splice(0)) dispose(); modeSelect.dispose(); configField.dispose(); cacheField.dispose(); read.dispose(); back.dispose(); next.dispose(); stop.dispose(); close.dispose(); section.remove(); } };
}
