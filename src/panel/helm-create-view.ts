import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { HelmCreateState } from '../host/helm-create-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountHelmCreateView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), form = document.createElement('div'), actions = document.createElement('div'), output = document.createElement('pre'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Create Helm chart'); actions.className = 'configuration-actions'; output.setAttribute('role', 'region'); output.style.overflowWrap = 'anywhere'; output.style.whiteSpace = 'pre-wrap'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  const rootLabel = document.createElement('label'), rootText = document.createElement('span'), root = document.createElement('input');
  root.type = 'text'; root.maxLength = 4096; root.spellcheck = false; root.autocomplete = 'off'; root.placeholder = '/workspace-root (canonical absolute)'; rootLabel.append(rootText, root);
  const pathLabel = document.createElement('label'), pathText = document.createElement('span'), path = document.createElement('input');
  path.type = 'text'; path.maxLength = 4096; path.spellcheck = false; path.autocomplete = 'off'; path.placeholder = 'charts (parent relative path, optional)'; pathLabel.append(pathText, path);
  const nameLabel = document.createElement('label'), nameText = document.createElement('span'), name = document.createElement('input');
  name.type = 'text'; name.maxLength = 128; name.spellcheck = false; name.autocomplete = 'off'; name.placeholder = 'mychart'; nameLabel.append(nameText, name);
  form.append(rootLabel, pathLabel, nameLabel); section.append(note, form, actions, output, status); container.append(section);
  let state: HelmCreateState = { phase: 'idle' };
  const create = mountButton(actions, { label: 'Create chart (explicit; scaffolds a new chart directory)', onClick: () => { bridge()?.runHelmCreate(root.value.trim(), path.value.trim(), name.value.trim()); } });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => { bridge()?.closeHelmCreate(); } });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'running';
    note.textContent = zh ? '在指定目录创建新的 Chart 文件夹，不自动安装。' : 'Create a new chart folder in the selected directory without installing it.';
    rootText.textContent = zh ? '父目录根（规范绝对路径）' : 'Parent root (canonical absolute)';
    pathText.textContent = zh ? '父目录相对路径（可选）' : 'Parent relative path (optional)';
    nameText.textContent = zh ? 'Chart名称' : 'Chart name';
    create.update({ label: zh ? '创建 Chart' : 'Create chart', disabled: busy });
    close.update({ label: zh ? '关闭' : 'Close', disabled: busy });
    output.textContent = state.content ?? '';
    status.textContent = `${phaseLabel(state.phase, zh)}${state.name ? ` · ${state.name}` : ''}${state.code ? ` · ${state.code}` : ''}`;
  }
  return { show(value: HelmCreateState) { state = value; paint(); }, paint, dispose() { create.dispose(); close.dispose(); section.remove(); } };
}
