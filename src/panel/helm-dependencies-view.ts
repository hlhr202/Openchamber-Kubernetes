import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { HelmDependenciesState } from '../host/helm-dependencies-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountHelmDependenciesView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), form = document.createElement('div'), actions = document.createElement('div'), output = document.createElement('pre'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Show Helm chart dependencies'); actions.className = 'configuration-actions'; output.setAttribute('role', 'region'); output.style.overflowWrap = 'anywhere'; output.style.whiteSpace = 'pre-wrap'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  const chartLabel = document.createElement('label'), chartText = document.createElement('span'), chart = document.createElement('input');
  chart.type = 'text'; chart.maxLength = 255; chart.spellcheck = false; chart.autocomplete = 'off'; chart.placeholder = 'repo/chart'; chartLabel.append(chartText, chart);
  const versionLabel = document.createElement('label'), versionText = document.createElement('span'), version = document.createElement('input');
  version.type = 'text'; version.maxLength = 63; version.spellcheck = false; version.autocomplete = 'off'; version.placeholder = '1.2.3 (optional)'; versionLabel.append(versionText, version);
  form.append(chartLabel, versionLabel); section.append(note, form, actions, output, status); container.append(section);
  let state: HelmDependenciesState = { phase: 'idle' };
  const list = mountButton(actions, { label: 'Show dependencies (explicit; fetch to plugin-owned temp)', onClick: () => { bridge()?.listHelmDependencies(chart.value.trim(), version.value.trim() || undefined); } });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => { bridge()?.closeHelmDependencies(); } });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'reading';
    note.textContent = zh ? '下载 Chart 到插件临时目录并列出依赖，不修改工作区。' : 'Download the chart to plugin temporary storage and list its dependencies; workspace is unchanged.';
    chartText.textContent = zh ? 'Chart引用（repo/chart）' : 'Chart reference (repo/chart)';
    versionText.textContent = zh ? '版本（可选）' : 'Version (optional)';
    list.update({ label: zh ? '查看依赖' : 'Show dependencies', disabled: busy });
    close.update({ label: zh ? '关闭' : 'Close', disabled: busy });
    if (state.phase === 'ready' && state.headers) output.textContent = state.rows && state.rows.length ? [state.headers, ...state.rows].map(row => row.join('\t')).join('\n') : `${state.headers.join('\t')}\n(no dependencies)`;
    else output.textContent = '';
    status.textContent = `${phaseLabel(state.phase, zh)}${state.chart ? ` · ${state.chart}` : ''}${state.code ? ` · ${state.code}` : ''}`;
  }
  return { show(value: HelmDependenciesState) { state = value; paint(); }, paint, dispose() { list.dispose(); close.dispose(); section.remove(); } };
}
