import { mountButton, mountSelect, mountTextField } from './controls.ts';
import type { DocumentState } from '../host/document-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
import { mountExplainView } from './explain-view.ts';
import type { ExplainState } from '../host/explain-client.ts';

export function mountDocumentView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), title = document.createElement('p'), note = document.createElement('p'), status = document.createElement('p'), actions = document.createElement('div');
  const output = document.createElement('div'), pre = document.createElement('pre'), editor = document.createElement('div'), documentSlot = document.createElement('div');
  output.className = 'configuration-results'; actions.className = 'configuration-actions'; status.setAttribute('role', 'status');
  output.append(pre); section.append(title, note, actions, status, documentSlot, output, editor); container.append(section);
  let state: DocumentState = { phase: 'idle', stale: false, text: '', complete: false };
  editor.setAttribute('data-scene-runtime-value', ''); documentSlot.setAttribute('data-scene-runtime-value', '');
  const explain = mountExplainView(document, section, bridge, locale);
  const field = mountTextField(editor, { label: 'Detached edit buffer (not saved or applied)', value: '', multiline: true, mono: true, onChange: value => bridge()?.editDocument(value) });
  const next = mountButton(actions, { label: 'Read next document chunk', onClick: () => { void bridge()?.nextDocument(); } });
  const reload = mountButton(actions, { label: 'Reload document', variant: 'outline', onClick: () => { void bridge()?.reloadDocument(state.editor?.dirty ?? false); } });
  const revert = mountButton(actions, { label: 'Discard edits', variant: 'outline', onClick: () => bridge()?.revertDocument() });
  const cancel = mountButton(actions, { label: 'Stop waiting', variant: 'ghost', onClick: () => bridge()?.cancelDocument() });
  const close = mountButton(actions, { label: 'Close document', variant: 'ghost', onClick: () => bridge()?.closeDocument(state.editor?.dirty ?? false) });
  const analyse = mountButton(actions, { label: 'Analyse document stream', variant: 'outline', onClick: () => bridge()?.analyseDocument() });
  const picker = mountSelect(documentSlot, { label: 'Local document for Explain (does not change target)', value: '0', options: [], onChange: id => { if (/^(0|[1-9]\d*)$/.test(id)) bridge()?.selectDocument(Number(id)); } });
  const paint = () => {
    explain.paint();
    const zh = locale().startsWith('zh'), loading = state.phase === 'loading', source = state.source, dirty = state.editor?.dirty ?? false;
    section.hidden = state.phase === 'idle'; section.setAttribute('aria-label', zh ? '资源 Load 文档与独立编辑缓冲' : 'Resource Load document and detached edit buffer'); section.setAttribute('aria-busy', String(loading));
    title.textContent = source ? `${source.target.context} / ${source.reference.type.group || 'core'}/${source.reference.type.version} ${source.reference.type.kind} / ${source.reference.namespace ? `${source.reference.namespace}/` : ''}${source.reference.name} · ${source.format.toUpperCase()}` : '';
    title.title = source ? `UID ${source.reference.uid} · RV ${source.reference.resourceVersion}` : '';
    section.className = 'oc-k8s-document-panel';
    note.textContent = zh ? '编辑不会自动保存或更新集群。保存文件、比较与应用请使用对应任务。'
      : 'Editing does not save or update the cluster. Use the separate Save, Compare or Apply task.';
    const info = state.error === 'DOCUMENT_DIRTY' ? (zh ? '已有未保存修改；新请求未执行。' : 'Unsaved edits retained; the new request was not executed.') : state.error;
    status.textContent = info ? `${info}${state.stale ? (zh ? '（过期文档）' : ' (stale document)') : ''}` : loading ? (zh ? '正在读取…' : 'Reading…')
      : state.page ? `${state.complete ? (dirty ? (zh ? '有未保存修改，尚未应用到集群' : 'Unsaved edits; not applied to cluster') : (zh ? '文档已加载，未修改' : 'Document loaded; no edits')) : (zh ? '文档尚未读完，暂不可编辑' : 'Partial document; finish loading to edit')}` : '';
    next.update({ label: zh ? '读取下一文档块' : 'Read next document chunk', disabled: state.phase !== 'ready' || !state.page?.nextCursor });
    reload.update({ label: dirty ? (zh ? '丢弃修改并重新读取' : 'Discard edits and reload') : (zh ? '重新读取文档' : 'Reload document'), disabled: loading || !source });
    revert.update({ label: zh ? '丢弃编辑，恢复缓冲基线' : 'Discard edits; restore buffer baseline', disabled: loading || state.phase !== 'ready' || !dirty });
    cancel.update({ label: zh ? '停止等待' : 'Stop waiting', disabled: !loading }); close.update({ label: dirty ? (zh ? '丢弃修改并关闭' : 'Discard edits and close') : (zh ? '关闭文档' : 'Close document') });
    output.hidden = !!state.editor; editor.hidden = !state.editor; pre.textContent = state.editor ? '' : logDisplayText(state.text);
    field.update({ label: zh ? '资源清单' : 'Resource manifest', value: state.editor?.text ?? '', disabled: !state.complete || loading || state.stale });
    const analysis = state.editor?.analysis; documentSlot.hidden = !analysis;
    analyse.update({ label: zh ? '解析本地文档流' : 'Analyse local document stream', disabled: state.phase !== 'ready' || !state.complete || state.stale || !state.editor });
    picker.update({ label: zh ? '用于Explain的本地文档（不改变目标）' : 'Local document for Explain (does not change target)', value: String(state.editor?.activeDocument ?? 0), disabled: loading || state.stale,
      options: analysis?.documents.map(item => ({ id: String(item.index), label: logDisplayText(`${item.index + 1} · ${item.kind ?? item.shape} · ${item.namespace ? `${item.namespace}/` : ''}${item.name ?? '—'}`) })) ?? [] });
    if (analysis) status.textContent += ` · ${analysis.documents.length} ${zh ? '文档（仅语法/AST，不是Apply校验）' : 'documents (syntax/AST only, not Apply validation)'}`;
    if (state.editor?.savedFile) status.textContent += ` · ${zh ? '上次成功Save（未Apply）' : 'Last successful file Save (not Apply)'}: ${state.editor.savedFile.root} / ${state.editor.savedFile.path}`;
  };
  return { show(value: DocumentState) { state = value; explain.document(value); paint(); }, showExplanation(value: ExplainState) { explain.show(value); }, paint, dispose() { explain.dispose(); state = { phase: 'idle', stale: false, text: '', complete: false }; pre.textContent = ''; field.update({ value: '' }); field.dispose(); analyse.dispose(); picker.dispose(); next.dispose(); reload.dispose(); revert.dispose(); cancel.dispose(); close.dispose(); section.remove(); } };
}
