import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { HelmConvertState } from '../host/helm-convert-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountHelmConvertView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), form = document.createElement('div'), actions = document.createElement('div'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Convert resource to Helm template'); actions.className = 'configuration-actions'; status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  const rootLabel = document.createElement('label'), rootText = document.createElement('span'), root = document.createElement('input');
  root.type = 'text'; root.maxLength = 4096; root.spellcheck = false; root.autocomplete = 'off'; root.placeholder = '/workspace-root of the chart (canonical absolute)'; rootLabel.append(rootText, root);
  const pathLabel = document.createElement('label'), pathText = document.createElement('span'), path = document.createElement('input');
  path.type = 'text'; path.maxLength = 4096; path.spellcheck = false; path.autocomplete = 'off'; path.placeholder = 'charts/mychart (chart relative path, optional)'; pathLabel.append(pathText, path);
  const nameLabel = document.createElement('label'), nameText = document.createElement('span'), name = document.createElement('input');
  name.type = 'text'; name.maxLength = 128; name.spellcheck = false; name.autocomplete = 'off'; name.placeholder = 'deployment-template'; nameLabel.append(nameText, name);
  const documentLabel = document.createElement('label'), documentText = document.createElement('span'), source = document.createElement('textarea');
  source.maxLength = 46_080; source.spellcheck = false; source.placeholder = 'apiVersion: apps/v1\nkind: Deployment\n…'; source.rows = 10; documentLabel.append(documentText, source);
  form.append(rootLabel, pathLabel, nameLabel, documentLabel); section.append(note, form, actions, status); container.append(section);
  let state: HelmConvertState = { phase: 'idle' };
  const run = mountButton(actions, { label: 'Convert to template (explicit; writes one new file, never overwrites)', onClick: () => { bridge()?.runHelmConvert(root.value.trim(), path.value.trim(), name.value.trim(), source.value); } });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => { bridge()?.closeHelmConvert(); } });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'running';
    note.textContent = zh ? '将单份 YAML 转为 templates/ 下的新文件，移除集群状态字段。不覆盖已有文件，不应用到集群。' : 'Convert one YAML manifest into a new templates/ file, removing cluster state. Existing files are not overwritten; nothing is applied.';
    rootText.textContent = zh ? 'Chart根（规范绝对路径）' : 'Chart root (canonical absolute)';
    pathText.textContent = zh ? 'Chart相对路径（可选）' : 'Chart relative path (optional)';
    nameText.textContent = zh ? '模板名称' : 'Template name';
    documentText.textContent = zh ? '资源YAML（单文档）' : 'Resource YAML (single document)';
    run.update({ label: zh ? '创建模板文件' : 'Create template file', disabled: busy });
    close.update({ label: zh ? '关闭' : 'Close', disabled: busy });
    status.textContent = `${phaseLabel(state.phase, zh)}${state.name ? ` · ${state.name}.yaml` : ''}${state.code ? ` · ${state.code}` : ''}`;
  }
  return { show(value: HelmConvertState) { state = value; paint(); }, paint, dispose() { run.dispose(); close.dispose(); section.remove(); } };
}
