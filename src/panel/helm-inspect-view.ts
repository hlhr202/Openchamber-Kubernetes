import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { HelmInspectState } from '../host/helm-inspect-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountHelmInspectView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), form = document.createElement('div'), actions = document.createElement('div'), output = document.createElement('pre'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Inspect Helm chart'); actions.className = 'configuration-actions'; output.setAttribute('role', 'region'); output.style.overflowWrap = 'anywhere'; output.style.whiteSpace = 'pre-wrap'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  const chartLabel = document.createElement('label'), chartText = document.createElement('span'), chart = document.createElement('input');
  chart.type = 'text'; chart.maxLength = 255; chart.spellcheck = false; chart.autocomplete = 'off'; chart.placeholder = 'repo/chart'; chartLabel.append(chartText, chart);
  const versionLabel = document.createElement('label'), versionText = document.createElement('span'), version = document.createElement('input');
  version.type = 'text'; version.maxLength = 63; version.spellcheck = false; version.autocomplete = 'off'; version.placeholder = '1.2.3 (optional)'; versionLabel.append(versionText, version);
  form.append(chartLabel, versionLabel); section.append(note, form, actions, output, status); container.append(section);
  let state: HelmInspectState = { phase: 'idle' };
  const inspect = mountButton(actions, { label: 'Inspect chart (explicit; plugin-isolated cache only)', onClick: () => { bridge()?.inspectHelmChart(chart.value.trim(), version.value.trim() || undefined); } });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => { bridge()?.closeHelmInspect(); } });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'reading';
    note.textContent = zh ? '查看 Chart 信息。可能下载到插件缓存，不修改工作区或集群。' : 'View chart information. Downloads may use the plugin cache; workspace and cluster are unchanged.';
    chartText.textContent = zh ? 'Chart引用（repo/chart）' : 'Chart reference (repo/chart)';
    versionText.textContent = zh ? '版本（可选）' : 'Version (optional)';
    inspect.update({ label: zh ? '查看 Chart' : 'Inspect chart', disabled: busy });
    close.update({ label: zh ? '关闭' : 'Close', disabled: busy });
    output.textContent = state.content ?? '';
    status.textContent = `${phaseLabel(state.phase, zh)}${state.chart ? ` · ${state.chart}` : ''}${state.code ? ` · ${state.code}` : ''}`;
  }
  return { show(value: HelmInspectState) { state = value; paint(); }, paint, dispose() { inspect.dispose(); close.dispose(); section.remove(); } };
}
