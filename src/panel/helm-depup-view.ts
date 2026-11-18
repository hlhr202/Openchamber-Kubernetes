import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { HelmDepUpState } from '../host/helm-depup-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountHelmDepUpView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), form = document.createElement('div'), actions = document.createElement('div'), output = document.createElement('pre'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Update Helm chart dependencies'); actions.className = 'configuration-actions'; output.setAttribute('role', 'region'); output.style.overflowWrap = 'anywhere'; output.style.whiteSpace = 'pre-wrap'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  const rootLabel = document.createElement('label'), rootText = document.createElement('span'), root = document.createElement('input');
  root.type = 'text'; root.maxLength = 4096; root.spellcheck = false; root.autocomplete = 'off'; root.placeholder = '/workspace-root (canonical absolute)'; rootLabel.append(rootText, root);
  const pathLabel = document.createElement('label'), pathText = document.createElement('span'), path = document.createElement('input');
  path.type = 'text'; path.maxLength = 4096; path.spellcheck = false; path.autocomplete = 'off'; path.placeholder = 'charts/mychart (relative, optional)'; pathLabel.append(pathText, path);
  form.append(rootLabel, pathLabel); section.append(note, form, actions, output, status); container.append(section);
  let state: HelmDepUpState = { phase: 'idle' };
  const update = mountButton(actions, { label: 'Update dependencies (explicit; writes Chart.lock and charts/ in the chart directory)', onClick: () => { bridge()?.runHelmDepUp(root.value.trim(), path.value.trim()); } });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => { bridge()?.closeHelmDepUp(); } });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'running';
    note.textContent = zh ? '更新此 Chart 的 Chart.lock 和 charts/。失败时可能已更新部分依赖，不自动回滚。' : 'Update this chart’s Chart.lock and charts/. A failure may leave partial changes; there is no automatic rollback.';
    rootText.textContent = zh ? 'Chart根（规范绝对路径）' : 'Chart root (canonical absolute)';
    pathText.textContent = zh ? '相对路径（可选）' : 'Relative path (optional)';
    update.update({ label: zh ? '更新依赖' : 'Update dependencies', disabled: busy });
    close.update({ label: zh ? '关闭' : 'Close', disabled: busy });
    output.textContent = state.content ?? '';
    status.textContent = `${phaseLabel(state.phase, zh)}${state.code ? ` · ${state.code}` : ''}`;
  }
  return { show(value: HelmDepUpState) { state = value; paint(); }, paint, dispose() { update.dispose(); close.dispose(); section.remove(); } };
}
