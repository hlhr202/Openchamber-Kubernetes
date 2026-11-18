import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { HelmPackageState } from '../host/helm-package-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountHelmPackageView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), form = document.createElement('div'), actions = document.createElement('div'), output = document.createElement('pre'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Package Helm chart'); actions.className = 'configuration-actions'; output.setAttribute('role', 'region'); output.style.overflowWrap = 'anywhere'; output.style.whiteSpace = 'pre-wrap'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  const field = (placeholder: string, maxLength: number) => { const label = document.createElement('label'), text = document.createElement('span'), input = document.createElement('input'); input.type = 'text'; input.maxLength = maxLength; input.spellcheck = false; input.autocomplete = 'off'; input.placeholder = placeholder; label.append(text, input); form.append(label); return { text, input }; };
  const chartRoot = field('/workspace-root of the chart (canonical absolute)', 4096);
  const chartPath = field('charts/mychart (chart relative path, optional)', 4096);
  const destinationRoot = field('/workspace-root for the package (canonical absolute)', 4096);
  const destinationPath = field('packages (destination relative path, optional)', 4096);
  section.append(note, form, actions, output, status); container.append(section);
  let state: HelmPackageState = { phase: 'idle' };
  const run = mountButton(actions, { label: 'Package chart (explicit; writes the archive into the destination)', onClick: () => { bridge()?.runHelmPackage(chartRoot.input.value.trim(), chartPath.input.value.trim(), destinationRoot.input.value.trim(), destinationPath.input.value.trim()); } });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => { bridge()?.closeHelmPackage(); } });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'running';
    note.textContent = zh ? '将 Chart 打包为 .tgz，写入指定目录，不发布到仓库或集群。' : 'Package the chart as a .tgz in the selected directory without publishing or installing.';
    chartRoot.text.textContent = zh ? 'Chart根（规范绝对路径）' : 'Chart root (canonical absolute)';
    chartPath.text.textContent = zh ? 'Chart相对路径（可选）' : 'Chart relative path (optional)';
    destinationRoot.text.textContent = zh ? '打包目标根（规范绝对路径）' : 'Destination root (canonical absolute)';
    destinationPath.text.textContent = zh ? '目标相对路径（可选）' : 'Destination relative path (optional)';
    run.update({ label: zh ? '打包 Chart' : 'Package chart', disabled: busy });
    close.update({ label: zh ? '关闭' : 'Close', disabled: busy });
    output.textContent = state.content ?? '';
    status.textContent = `${phaseLabel(state.phase, zh)}${state.code ? ` · ${state.code}` : ''}`;
  }
  return { show(value: HelmPackageState) { state = value; paint(); }, paint, dispose() { run.dispose(); close.dispose(); section.remove(); } };
}
