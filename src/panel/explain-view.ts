import { mountButton, mountSelect } from './controls.ts';
import { phaseLabel } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import { BoundaryError } from '../shared/errors.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
import { documentFields } from '../host/document-fields.ts';
import type { DocumentField } from '../host/document-fields.ts';
import type { DocumentState } from '../host/document-client.ts';
import type { ExplainState } from '../host/explain-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { bufferDocumentText } from '../shared/document-buffer.ts';
import { loadDocumentReferenceSchema } from '../shared/document-protocol.ts';

export function mountExplainView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), controls = document.createElement('div'), slot = document.createElement('div'), note = document.createElement('p'), status = document.createElement('p'), pre = document.createElement('pre');
  controls.className = 'configuration-actions'; status.setAttribute('role', 'status'); section.append(note, controls, slot, status, pre); container.append(section);
  let doc: DocumentState = { phase: 'idle', stale: false, text: '', complete: false }, state: ExplainState = { phase: 'idle' }, enabled = false, selected = '0', fields: DocumentField[] = [], invalid = '';
  const toggle = mountButton(controls, { label: 'Enable field Explain', variant: 'outline', onClick: () => { enabled = !enabled; bridge()?.clearExplanation(); paint(); } });
  const picker = mountSelect(slot, { label: 'Actual document field', value: selected, options: [], onChange: id => { selected = id; bridge()?.clearExplanation(); paint(); } });
  const run = mountButton(controls, { label: 'Explain selected field', onClick: () => { if (doc.editor) void bridge()?.readExplanation(selected, doc.editor.revision); } });
  const stop = mountButton(controls, { label: 'Stop waiting', variant: 'ghost', onClick: () => bridge()?.clearExplanation() });
  bindScene(section, 'explain', () => ({ enabled, selected, invalid }), value => { enabled = value.enabled; selected = value.selected; invalid = value.invalid; paint(); });
  function paint() {
    const zh = locale().startsWith('zh'), ready = doc.phase === 'ready' && !doc.stale && doc.complete && !!doc.editor && !!fields.length, loading = state.phase === 'loading';
    section.hidden = !doc.editor; section.setAttribute('aria-label', zh ? '文档字段Explain' : 'Document field Explain'); section.setAttribute('aria-busy', String(loading));
    note.textContent = zh ? '选择清单中的字段，读取集群发布的字段说明。编辑内容改变后请重新读取。' : 'Select a manifest field to read its published schema description. Read again after changing the document.';
    toggle.update({ label: enabled ? (zh ? '停用Explain' : 'Disable Explain') : (zh ? '启用字段Explain' : 'Enable field Explain'), disabled: !ready && !enabled });
    picker.update({ label: zh ? '当前文档中的字段' : 'Field in current document', value: selected, options: fields.map(field => ({ id: field.id, label: field.label })), disabled: !ready || !enabled || loading });
    run.update({ label: zh ? '读取所选字段说明' : 'Read selected field explanation', disabled: !ready || !enabled || loading || !fields.some(field => field.id === selected) });
    stop.update({ label: zh ? '停止等待' : 'Stop waiting', disabled: !loading });
    status.textContent = invalid || (enabled ? `${phaseLabel(state.phase, zh)}${state.error ? ` · ${state.error}` : ''}` : (zh ? '字段说明未启用' : 'Field explanations disabled'));
    const page = enabled ? state.page : undefined;
    pre.textContent = page ? logDisplayText(`${page.target.context} · ${page.type.group || 'core'}/${page.type.version} ${page.type.kind} · ${page.fieldPath.join('.') || '(kind)'} · r${page.revision}\n${page.explanation.type}${page.explanation.required ? ' · required' : ''}\n${page.explanation.description}\n${page.explanation.properties.map(field => `${field.name}: ${field.type}${field.required ? ' (required)' : ''}`).join('\n')}`) : '';
  }
  return {
    document(value: DocumentState) { doc = value; fields = []; invalid = ''; selected = '0'; if (!doc.editor) enabled = false;
       if (doc.phase === 'ready' && doc.complete && !doc.stale && doc.editor && doc.source) try {
          if (!loadDocumentReferenceSchema.safeParse(doc.source.reference).success) throw new BoundaryError('CONTENT_INVALID');
         fields = documentFields(bufferDocumentText(doc.editor), doc.source.reference.type);
       } catch (error) { invalid = error instanceof BoundaryError ? error.code : 'CONTENT_INVALID'; }
      paint(); },
    show(value: ExplainState) { state = value; paint(); }, paint,
    dispose() { pre.textContent = ''; fields = []; doc = { phase: 'idle', stale: false, text: '', complete: false }; state = { phase: 'idle' }; toggle.dispose(); picker.dispose(); run.dispose(); stop.dispose(); section.remove(); },
  };
}
