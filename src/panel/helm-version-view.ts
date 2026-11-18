import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { HelmVersionState } from '../host/helm-version-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountHelmVersionView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Helm version'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  section.append(note, actions, status); container.append(section);
  let state: HelmVersionState = { phase: 'idle' };
  const read = mountButton(actions, { label: 'Helm version (read only, re-probes syntax)', onClick: () => { void bridge()?.readHelmVersion(); } });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => bridge()?.closeHelmVersion() });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'reading';
    note.textContent = zh ? '查看服务器上的 Helm 版本，不连接集群或安装软件。' : 'Check the Server’s Helm version without connecting to a cluster or installing software.';
    read.update({ label: zh ? '读取版本' : 'Read version', disabled: busy });
    close.update({ label: zh ? '关闭' : 'Close', disabled: busy });
    status.textContent = `${phaseLabel(state.phase, zh)}${state.code ? ` · ${state.code}` : ''}${state.output ? `\n${state.output}` : ''}`;
  }
  return { show(value: HelmVersionState) { state = value; paint(); }, paint, dispose() { read.dispose(); close.dispose(); section.remove(); } };
}
