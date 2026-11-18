import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { HelmLintState } from '../host/helm-lint-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountHelmLintView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), form = document.createElement('div'), actions = document.createElement('div'), output = document.createElement('pre'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Lint Helm chart'); actions.className = 'configuration-actions'; output.setAttribute('role', 'region'); output.style.overflowWrap = 'anywhere'; output.style.whiteSpace = 'pre-wrap'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  const rootLabel = document.createElement('label'), rootText = document.createElement('span'), root = document.createElement('input');
  root.type = 'text'; root.maxLength = 4096; root.spellcheck = false; root.autocomplete = 'off'; root.placeholder = '/workspace-root (canonical absolute)'; rootLabel.append(rootText, root);
  const pathLabel = document.createElement('label'), pathText = document.createElement('span'), path = document.createElement('input');
  path.type = 'text'; path.maxLength = 4096; path.spellcheck = false; path.autocomplete = 'off'; path.placeholder = 'charts/mychart (relative, optional)'; pathLabel.append(pathText, path);
  form.append(rootLabel, pathLabel); section.append(note, form, actions, output, status); container.append(section);
  let state: HelmLintState = { phase: 'idle' };
  const lint = mountButton(actions, { label: 'Lint chart (explicit; canonical workspace directory)', onClick: () => { bridge()?.lintHelmChart(root.value.trim(), path.value.trim()); } });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => { bridge()?.closeHelmLint(); } });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'reading';
    note.textContent = zh ? '检查所选 Chart，问题详情显示在下方，不安装到集群。' : 'Check the selected chart. Findings appear below; nothing is installed.';
    rootText.textContent = zh ? 'Chart根（规范绝对路径）' : 'Chart root (canonical absolute)';
    pathText.textContent = zh ? '相对路径（可选）' : 'Relative path (optional)';
    lint.update({ label: zh ? '检查 Chart' : 'Lint chart', disabled: busy });
    close.update({ label: zh ? '关闭' : 'Close', disabled: busy });
    output.textContent = state.content ?? '';
    status.textContent = `${phaseLabel(state.phase, zh)}${state.failed === true ? (zh ? ' · 发现问题' : ' · Findings') : ''}${state.code ? ` · ${state.code}` : ''}`;
  }
  return { show(value: HelmLintState) { state = value; paint(); }, paint, dispose() { lint.dispose(); close.dispose(); section.remove(); } };
}
