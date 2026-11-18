import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { HelmRequirementState } from '../host/helm-requirement-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountHelmRequirementView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), form = document.createElement('div'), actions = document.createElement('div'), output = document.createElement('pre'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Insert Helm dependency requirement'); actions.className = 'configuration-actions'; output.setAttribute('role', 'region'); output.style.overflowWrap = 'anywhere'; output.style.whiteSpace = 'pre-wrap'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  const repositoryLabel = document.createElement('label'), repositoryText = document.createElement('span'), repository = document.createElement('input');
  repository.type = 'text'; repository.maxLength = 128; repository.spellcheck = false; repository.autocomplete = 'off'; repository.placeholder = 'bitnami (repository name)'; repositoryLabel.append(repositoryText, repository);
  const chartLabel = document.createElement('label'), chartText = document.createElement('span'), chart = document.createElement('input');
  chart.type = 'text'; chart.maxLength = 128; chart.spellcheck = false; chart.autocomplete = 'off'; chart.placeholder = 'nginx (chart name)'; chartLabel.append(chartText, chart);
  form.append(repositoryLabel, chartLabel); section.append(note, form, actions, output, status); container.append(section);
  let state: HelmRequirementState = { phase: 'idle' };
  const lookup = mountButton(actions, { label: 'Look up requirement (read-only; displays the text, no auto-insert)', onClick: () => { bridge()?.lookupHelmRequirement(repository.value.trim(), chart.value.trim()); } });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => { bridge()?.closeHelmRequirement(); } });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'reading';
    note.textContent = zh ? '从已有仓库索引生成依赖条目，仅预览文本，不自动插入文件。' : 'Generate a dependency entry from the existing repository index. Preview only; files are not edited.';
    repositoryText.textContent = zh ? '仓库名' : 'Repository name';
    chartText.textContent = zh ? 'Chart名' : 'Chart name';
    lookup.update({ label: zh ? '生成依赖条目' : 'Generate dependency entry', disabled: busy });
    close.update({ label: zh ? '关闭' : 'Close', disabled: busy });
    output.textContent = state.text ?? '';
    status.textContent = `${phaseLabel(state.phase, zh)}${state.code ? ` · ${state.code}` : ''}`;
  }
  return { show(value: HelmRequirementState) { state = value; paint(); }, paint, dispose() { lookup.dispose(); close.dispose(); section.remove(); } };
}
