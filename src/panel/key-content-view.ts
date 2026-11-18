import { mountButton } from '@openchamber/sdk/ui';
import type { KeyContentState } from '../host/key-content-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';

export function mountKeyContentView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), heading = document.createElement('p'), status = document.createElement('p'), note = document.createElement('p');
  const actions = document.createElement('div'), output = document.createElement('div'), pre = document.createElement('pre');
  actions.className = 'configuration-actions'; output.className = 'configuration-results'; output.append(pre); status.setAttribute('role', 'status');
  section.append(heading, note, actions, status, output); container.append(section);
  let state: KeyContentState = { phase: 'idle', stale: false, complete: false, text: '' };
  const next = mountButton(actions, { label: 'Read next chunk', disabled: true, onClick: () => { void bridge()?.nextKeyContent(); } });
  const refresh = mountButton(actions, { label: 'Read again', disabled: true, variant: 'outline', onClick: () => { void bridge()?.reloadKeyContent(); } });
  const cancel = mountButton(actions, { label: 'Stop waiting', disabled: true, variant: 'ghost', onClick: () => bridge()?.cancelKeyContent() });
  const clear = mountButton(actions, { label: 'Clear content', variant: 'ghost', onClick: () => bridge()?.clearKeyContent() });
  const paint = () => {
    const zh = locale().startsWith('zh'), loading = state.phase === 'loading';
    section.hidden = state.phase === 'idle'; section.setAttribute('aria-label', zh ? '配置键内容（只读）' : 'Configuration key content (read only)'); section.setAttribute('aria-busy', String(loading));
    const reference = state.reference;
    heading.textContent = reference ? `${reference.parent.resource} / ${reference.parent.namespace} / ${reference.parent.name} / ${reference.key}` : '';
    note.textContent = zh ? '内容仅在当前面板查看，不自动保存或发送聊天。二进制以 Base64 显示；未读完时不是完整内容。' : 'View contents in this panel without automatic saving or chat sharing. Binary data is shown as Base64; partial reads are not complete content.';
    const stale = state.stale ? (zh ? '（过期内容）' : ' (stale content)') : '';
    status.textContent = loading ? `${zh ? '正在读取…' : 'Reading…'}${stale}` : state.phase === 'error' ? `${state.error ?? 'STATE_UNAVAILABLE'}${stale}`
      : `${state.encoding ?? ''} · ${state.text.length}/${state.totalCharacters ?? 0} · ${state.totalBytes ?? 0} bytes · ${state.complete ? (zh ? '完整' : 'complete') : (zh ? '部分内容' : 'partial')}`;
    pre.textContent = state.text; // Never HTML, URI, clipboard, storage, log, terminal or a default tree DTO.
    next.update({ label: zh ? '读取下一块' : 'Read next chunk', disabled: state.phase !== 'ready' || state.complete });
    refresh.update({ label: zh ? '重新读取' : 'Read again', disabled: loading || !reference }); cancel.update({ label: zh ? '停止等待' : 'Stop waiting', disabled: !loading });
    clear.update({ label: zh ? '清除内容' : 'Clear content' });
  };
  return { show(value: KeyContentState) { state = value; paint(); }, paint,
    dispose() { state = { phase: 'idle', stale: false, complete: false, text: '' }; pre.textContent = ''; next.dispose(); refresh.dispose(); cancel.dispose(); clear.dispose(); section.remove(); } };
}
