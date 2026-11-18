import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { HelmValuesState } from '../host/helm-values-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountHelmValuesView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), form = document.createElement('div'), actions = document.createElement('div'), output = document.createElement('pre'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Fetch Helm chart values'); actions.className = 'configuration-actions'; output.setAttribute('role', 'region'); output.style.overflowWrap = 'anywhere'; output.style.whiteSpace = 'pre-wrap'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  const chartLabel = document.createElement('label'), chartText = document.createElement('span'), chart = document.createElement('input');
  chart.type = 'text'; chart.maxLength = 255; chart.spellcheck = false; chart.autocomplete = 'off'; chart.placeholder = 'repo/chart'; chartLabel.append(chartText, chart);
  const versionLabel = document.createElement('label'), versionText = document.createElement('span'), version = document.createElement('input');
  version.type = 'text'; version.maxLength = 63; version.spellcheck = false; version.autocomplete = 'off'; version.placeholder = '1.2.3 (optional)'; versionLabel.append(versionText, version);
  form.append(chartLabel, versionLabel); section.append(note, form, actions, output, status); container.append(section);
  let state: HelmValuesState = { phase: 'idle' };
  const fetchValues = mountButton(actions, { label: 'Fetch values (explicit; preview only, plugin-isolated cache)', onClick: () => { bridge()?.fetchHelmValues(chart.value.trim(), version.value.trim() || undefined); } });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => { bridge()?.closeHelmValues(); } });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'reading';
    note.textContent = zh ? '预览 Chart 默认 values，不自动保存文件或安装。' : 'Preview chart defaults without saving files or installing.';
    chartText.textContent = zh ? 'Chart引用（repo/chart）' : 'Chart reference (repo/chart)';
    versionText.textContent = zh ? '版本（可选）' : 'Version (optional)';
    fetchValues.update({ label: zh ? '读取 Values' : 'Read values', disabled: busy });
    close.update({ label: zh ? '关闭' : 'Close', disabled: busy });
    output.textContent = state.content ?? '';
    status.textContent = `${phaseLabel(state.phase, zh)}${state.chart ? ` · ${state.chart}` : ''}${state.code ? ` · ${state.code}` : ''}`;
  }
  return { show(value: HelmValuesState) { state = value; paint(); }, paint, dispose() { fetchValues.dispose(); close.dispose(); section.remove(); } };
}
