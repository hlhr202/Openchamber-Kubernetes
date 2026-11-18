import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { WatchState } from '../host/watch-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';

export function mountWatchView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), status = document.createElement('p'), note = document.createElement('p'); status.setAttribute('role', 'status');
  section.append(note, status); container.append(section); let state: WatchState = { phase: 'idle', changed: false };
  const stop = mountButton(section, { label: 'Stop Watching', variant: 'outline', onClick: () => bridge()?.stopWatch() });
  function paint() {
    const zh = locale().startsWith('zh');
    note.textContent = zh ? '观察资源变化，不改动编辑内容。重新同步或丢失事件时会明确标记。' : 'Observe resource changes without editing drafts. Resynchronization and lost events are marked.';
    const page = state.page; status.textContent = `${phaseLabel(state.phase, zh)}${state.recovery ? ` · ${zh ? state.recovery === 'relisting' ? '正在重新同步' : '已重同步，可能缺少事件' : state.recovery}` : ''}${state.error ? ` · ${state.error}` : ''}${page ? ` · ${page.source.resource}${page.lost ? (zh ? ' · 事件不完整' : ' · Incomplete events') : ''}` : ''}`;
    stop.update({ label: zh ? '停止观察' : 'Stop Watching', disabled: !['opening', 'starting', 'running'].includes(state.phase) });
  }
  return { show(value: WatchState) { state = value; paint(); }, paint, dispose() { stop.dispose(); state = { phase: 'idle', changed: false }; section.remove(); } };
}
