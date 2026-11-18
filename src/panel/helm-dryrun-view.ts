import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { HelmDryRunState } from '../host/helm-dryrun-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountHelmDryRunView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), form = document.createElement('div'), actions = document.createElement('div'), output = document.createElement('pre'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Helm install dry run'); actions.className = 'configuration-actions'; output.setAttribute('role', 'region'); output.style.overflowWrap = 'anywhere'; output.style.whiteSpace = 'pre-wrap'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  const rootLabel = document.createElement('label'), rootText = document.createElement('span'), root = document.createElement('input');
  root.type = 'text'; root.maxLength = 4096; root.spellcheck = false; root.autocomplete = 'off'; root.placeholder = '/workspace-root (canonical absolute)'; rootLabel.append(rootText, root);
  const pathLabel = document.createElement('label'), pathText = document.createElement('span'), path = document.createElement('input');
  path.type = 'text'; path.maxLength = 4096; path.spellcheck = false; path.autocomplete = 'off'; path.placeholder = 'charts/mychart (relative, optional)'; pathLabel.append(pathText, path);
  form.append(rootLabel, pathLabel); section.append(note, form, actions, output, status); container.append(section);
  let state: HelmDryRunState = { phase: 'idle' };
  const run = mountButton(actions, { label: 'Dry run (explicit; install branch, no cluster write)', onClick: () => { bridge()?.runHelmDryRun(root.value.trim(), path.value.trim()); } });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => { bridge()?.closeHelmDryRun(); } });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'reading';
    note.textContent = zh ? '预览安装过程和生成结果，不实际安装资源。' : 'Preview installation and generated output without installing resources.';
    rootText.textContent = zh ? 'Chart根（规范绝对路径）' : 'Chart root (canonical absolute)';
    pathText.textContent = zh ? '相对路径（可选）' : 'Relative path (optional)';
    run.update({ label: zh ? '试运行' : 'Dry run', disabled: busy });
    close.update({ label: zh ? '关闭' : 'Close', disabled: busy });
    output.textContent = state.content ?? '';
    status.textContent = `${phaseLabel(state.phase, zh)}${state.code ? ` · ${state.code}` : ''}`;
  }
  return { show(value: HelmDryRunState) { state = value; paint(); }, paint, dispose() { run.dispose(); close.dispose(); section.remove(); } };
}
