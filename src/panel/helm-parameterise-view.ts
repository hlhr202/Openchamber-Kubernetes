import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { HelmParameteriseState } from '../host/helm-parameterise-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountHelmParameteriseView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), form = document.createElement('div'), actions = document.createElement('div'), templateOutput = document.createElement('pre'), entryOutput = document.createElement('pre'), status = document.createElement('p');
  section.setAttribute('aria-label', 'Parameterise Helm template field'); actions.className = 'configuration-actions';
  for (const output of [templateOutput, entryOutput]) { output.setAttribute('role', 'region'); output.style.overflowWrap = 'anywhere'; output.style.whiteSpace = 'pre-wrap'; }
  status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
  const field = (placeholder: string, maxLength: number) => { const label = document.createElement('label'), text = document.createElement('span'), input = document.createElement('input'); input.type = 'text'; input.maxLength = maxLength; input.spellcheck = false; input.autocomplete = 'off'; input.placeholder = placeholder; label.append(text, input); form.append(label); return { text, input }; };
  const template = field('mychart (template/chart name)', 128);
  const fieldName = field('replicas (YAML field name)', 128);
  const value = field('3 (the literal field value)', 1024);
  const documentLabel = document.createElement('label'), documentText = document.createElement('span'), source = document.createElement('textarea');
  source.maxLength = 46_080; source.spellcheck = false; source.placeholder = 'apiVersion: apps/v1\n...replicas: 3\n'; source.rows = 8; documentLabel.append(documentText, source);
  form.append(documentLabel); section.append(note, form, actions, templateOutput, entryOutput, status); container.append(section);
  let state: HelmParameteriseState = { phase: 'idle' };
  const run = mountButton(actions, { label: 'Parameterise (pure transform; displays both texts, no auto-edit)', onClick: () => { bridge()?.runHelmParameterise(template.input.value.trim(), fieldName.input.value.trim(), value.input.value.trim(), source.value); } });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => { bridge()?.closeHelmParameterise(); } });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'reading';
    note.textContent = zh ? '将唯一匹配的字段提取为 Values 参数。下方显示模板和 values 文本，不自动保存。' : 'Extract the uniquely matching field into a Values parameter. Preview both texts below; nothing is saved automatically.';
    template.text.textContent = zh ? '模板/Chart名' : 'Template/chart name';
    fieldName.text.textContent = zh ? 'YAML字段名' : 'YAML field name';
    value.text.textContent = zh ? '字面值' : 'Literal value';
    documentText.textContent = zh ? '模板YAML文本' : 'Template YAML text';
    run.update({ label: zh ? '提取参数' : 'Extract parameter', disabled: busy });
    close.update({ label: zh ? '关闭' : 'Close', disabled: busy });
    templateOutput.textContent = state.document ?? '';
    entryOutput.textContent = state.entry ?? '';
    status.textContent = `${phaseLabel(state.phase, zh)}${state.code ? ` · ${state.code}` : ''}`;
  }
  return { show(value: HelmParameteriseState) { state = value; paint(); }, paint, dispose() { run.dispose(); close.dispose(); section.remove(); } };
}
