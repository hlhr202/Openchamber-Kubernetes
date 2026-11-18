import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { HelmFetchState } from '../host/helm-fetch-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountHelmFetchView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), form = document.createElement('div'), actions = document.createElement('div'), output = document.createElement('pre'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Fetch Helm chart'); actions.className = 'configuration-actions'; output.setAttribute('role', 'region'); output.style.overflowWrap = 'anywhere'; output.style.whiteSpace = 'pre-wrap'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  const chartLabel = document.createElement('label'), chartText = document.createElement('span'), chart = document.createElement('input');
  chart.type = 'text'; chart.maxLength = 255; chart.spellcheck = false; chart.autocomplete = 'off'; chart.placeholder = 'repo/chart'; chartLabel.append(chartText, chart);
  const versionLabel = document.createElement('label'), versionText = document.createElement('span'), version = document.createElement('input');
  version.type = 'text'; version.maxLength = 63; version.spellcheck = false; version.autocomplete = 'off'; version.placeholder = '1.2.3 (optional)'; versionLabel.append(versionText, version);
  const rootLabel = document.createElement('label'), rootText = document.createElement('span'), root = document.createElement('input');
  root.type = 'text'; root.maxLength = 4096; root.spellcheck = false; root.autocomplete = 'off'; root.placeholder = '/workspace-root of the destination (canonical absolute)'; rootLabel.append(rootText, root);
  const pathLabel = document.createElement('label'), pathText = document.createElement('span'), path = document.createElement('input');
  path.type = 'text'; path.maxLength = 4096; path.spellcheck = false; path.autocomplete = 'off'; path.placeholder = 'charts (destination relative path, optional)'; pathLabel.append(pathText, path);
  form.append(chartLabel, versionLabel, rootLabel, pathLabel); section.append(note, form, actions, output, status); container.append(section);
  let state: HelmFetchState = { phase: 'idle' };
  const run = mountButton(actions, { label: 'Fetch chart (explicit; untars into the destination)', onClick: () => { bridge()?.runHelmFetch(chart.value.trim(), version.value.trim() || undefined, root.value.trim(), path.value.trim()); } });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => { bridge()?.closeHelmFetch(); } });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'running';
    note.textContent = zh ? '下载并解包 Chart 到指定目录。失败时可能已留下部分文件，请先检查再重试。' : 'Download and extract a chart to the selected directory. A failed download may leave files; inspect them before retrying.';
    chartText.textContent = zh ? 'Chart引用（repo/chart）' : 'Chart reference (repo/chart)';
    versionText.textContent = zh ? '版本（可选）' : 'Version (optional)';
    rootText.textContent = zh ? '目标根（规范绝对路径）' : 'Destination root (canonical absolute)';
    pathText.textContent = zh ? '目标相对路径（可选）' : 'Destination relative path (optional)';
    run.update({ label: zh ? '下载 Chart' : 'Download chart', disabled: busy });
    close.update({ label: zh ? '关闭' : 'Close', disabled: busy });
    output.textContent = state.content ?? '';
    status.textContent = `${phaseLabel(state.phase, zh)}${state.chart ? ` · ${state.chart}` : ''}${state.code ? ` · ${state.code}` : ''}`;
  }
  return { show(value: HelmFetchState) { state = value; paint(); }, paint, dispose() { run.dispose(); close.dispose(); section.remove(); } };
}
