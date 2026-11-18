import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { HelmRefreshState } from '../host/helm-refresh-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountHelmRefreshView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Refresh Helm repositories'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  section.append(note, actions, status); container.append(section);
  let state: HelmRefreshState = { phase: 'idle' };
  const run = mountButton(actions, { label: 'Refresh Helm repo index (explicit; plugin-isolated cache only)', onClick: () => { void bridge()?.runHelmRepoRefresh(); } });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => { bridge()?.closeHelmRefresh(); } });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'running';
    note.textContent = zh ? '下载最新仓库索引到插件缓存，不修改你的 Helm 仓库配置。' : 'Download current repository indexes to the plugin cache without changing your Helm repository configuration.';
    run.update({ label: zh ? '刷新索引' : 'Refresh indexes', disabled: busy });
    close.update({ label: zh ? '关闭' : 'Close', disabled: busy });
    status.textContent = `${phaseLabel(state.phase, zh)}${state.code ? ` · ${state.code}` : ''}`;
  }
  return { show(value: HelmRefreshState) { state = value; paint(); }, paint, dispose() { run.dispose(); close.dispose(); section.remove(); } };
}
