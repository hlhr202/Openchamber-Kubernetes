import { mountButton, mountSelect, mountTextField } from './controls.ts';
import { phaseLabel } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';
import type { ManifestDiffState } from '../host/manifest-diff-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountManifestDiffView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), actions = document.createElement('div'), status = document.createElement('p'), results = document.createElement('div');
  status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere'; actions.className = 'configuration-actions'; section.append(note, actions, status, results); container.append(section);
  let kind: 'live' | 'file' = 'live', format: 'yaml' | 'json' = 'yaml', selected = 0, start = '', end = '', state: ManifestDiffState = { phase: 'idle', stale: false, documents: [] };
  const source = mountSelect(actions, { label: 'Local comparison source', value: kind, options: [{ id: 'live', label: 'Complete loaded resource buffer' }, { id: 'file', label: 'Explicit in-memory Server file buffer' }], onChange: value => { if (value === 'live' || value === 'file') { kind = value; bridge()?.closeManifestDiff(); } } });
  const language = mountSelect(actions, { label: 'File buffer format', value: format, options: [{ id: 'yaml', label: 'YAML' }, { id: 'json', label: 'JSON' }], onChange: value => { if (value === 'yaml' || value === 'json') { format = value; bridge()?.closeManifestDiff(); } } });
  const from = mountTextField(actions, { label: 'Optional selection start (UTF-16)', value: '', onChange: value => { start = value; bridge()?.closeManifestDiff(); } });
  const to = mountTextField(actions, { label: 'Optional selection end (UTF-16)', value: '', onChange: value => { end = value; bridge()?.closeManifestDiff(); } });
  const read = mountButton(actions, { label: 'Diff captured buffer against live (read only)', onClick: () => {
    if (start || end) { if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) { status.textContent = 'INVALID_INPUT'; return; } void bridge()?.readManifestDiff(kind, format, { start: Number(start), end: Number(end) }); }
    else void bridge()?.readManifestDiff(kind, format);
  } });
  const stop = mountButton(actions, { label: 'Stop waiting', variant: 'ghost', onClick: () => bridge()?.cancelManifestDiff() });
  const close = mountButton(actions, { label: 'Close Diff', variant: 'ghost', onClick: () => bridge()?.closeManifestDiff() });
  const model = mountButton(actions, { label: 'Inspect JSON merge model (local, not Apply)', variant: 'outline', onClick: () => bridge()?.inspectManifestJsonMerge(selected) });
  const picker = mountSelect(actions, { label: 'Compared document', value: '0', options: [], onChange: value => { if (/^\d+$/.test(value)) { selected = Number(value); paint(); } } });
  bindScene(section, 'manifest-diff', () => ({ kind, format, selected, start, end }), value => { kind = value.kind; format = value.format; selected = value.selected; start = value.start; end = value.end; paint(); });
  function paint() {
    const zh = locale().startsWith('zh'), busy = state.phase === 'reading'; section.setAttribute('aria-label', zh ? '只读清单Diff' : 'Read-only manifest Diff'); section.setAttribute('aria-busy', String(busy));
    note.textContent = zh ? '比较编辑内容与本次读取的集群文本，不保存、不提交。文本相同不代表应用后不会发生变化。' : 'Compare edits with the cluster text read for this comparison. Nothing is saved or submitted; matching text is not an Apply prediction.';
    source.update({ label: zh ? '本地比较来源' : 'Local comparison source', disabled: busy, options: [{ id: 'live', label: zh ? '完整Load资源缓冲' : 'Complete loaded resource buffer' }, { id: 'file', label: zh ? '明确比较Server文件内存缓冲' : 'Explicit in-memory Server file buffer' }] }); language.update({ label: zh ? '文件缓冲格式（Load沿原格式）' : 'File format (Load keeps original format)', disabled: busy });
    from.update({ label: zh ? '选区开始UTF-16（可空）' : 'Selection start UTF-16 (optional)', disabled: busy }); to.update({ label: zh ? '选区结束UTF-16（可空）' : 'Selection end UTF-16 (optional)', disabled: busy });
    read.update({ label: zh ? 'Diff内存快照与live（只读）' : 'Diff captured buffer against live (read only)', disabled: busy }); stop.update({ label: zh ? '停止等待' : 'Stop waiting', disabled: !busy }); close.update({ label: zh ? '关闭Diff' : 'Close Diff' });
    if (selected >= state.documents.length) selected = 0; picker.update({ label: zh ? '已比较文档' : 'Compared document', value: String(selected), disabled: busy || !state.documents.length,
      options: state.documents.map((value, index) => ({ id: String(index), label: `${value.index + 1} · ${value.phase}${value.comparison ? value.comparison.equal ? ' · identical' : ' · different' : ''}` })) });
    model.update({ label: zh ? '检查JSON三方合并模型（仅本地，非Apply）' : 'Inspect JSON merge model (local, not Apply)', disabled: state.phase !== 'ready' || state.stale || state.documents[selected]?.phase !== 'live' });
    status.textContent = `${phaseLabel(state.phase, zh)}${state.source ? ` · ${state.source.target.context}/${state.source.target.namespace}` : ''}${state.reason ? ` · ${state.reason}` : ''}${state.error ? ` · ${state.error}` : ''}${state.stale ? (zh ? ' · 结果已过期' : ' · Result is stale') : ''} · ${state.documents.length} ${zh ? '份文档' : 'documents'}`;
    results.replaceChildren(); const value = state.documents[selected]; if (!value) return;
    const info = document.createElement('p'); info.textContent = `${value.phase}${value.code ? ` · ${value.code}` : ''}${value.comparison ? ` · ${value.comparison.equal ? (zh ? '无字面文本变化' : 'No literal text change') : (zh ? '字面文本不同' : 'Text differs')} · ${value.comparison.alignment}` : ''}${value.observed ? ` · UID ${value.observed.uid} · RV ${value.observed.resourceVersion}` : ''}`; results.append(info);
    if (value.mergeReview || value.mergeReviewError) {
      const warning = document.createElement('p'), review = value.mergeReview;
      warning.textContent = zh ? `JSON-merge模型仅用于理解last-applied所有权，不是Apply预测/授权或已选patch策略；未读OpenAPI，不能用于内置strategic列表语义，也不包含服务器默认化/admission。原UID/RV只是已捕获快照，执行前版本门禁/单次writer仍未接。仅保留一份模型；无额外网络、上传或持久化。${value.mergeReviewError ?? ''}`
        : `JSON-merge model only explains last-applied ownership: NOT an Apply prediction/authority or a selected patch strategy. No OpenAPI was read; builtin strategic list semantics, server defaults/admission are not modeled. UID/RV identifies the captured snapshot only; execution-time version gates/single-dispatch writer remain unimplemented. One local model retained, no extra network/upload/persistence. ${value.mergeReviewError ?? ''}`;
      results.append(warning);
      if (review) {
        const summary = document.createElement('p'); summary.textContent = `${review.kind} · baseline ${review.baseline} · ${review.comparison.equal ? 'model unchanged' : 'model changed'} · last-applied ${review.annotationWillChange ? 'different' : 'same'}`; results.append(summary);
        for (const [label, text] of [[zh ? '模型差量（不是可提交授权）' : 'Model delta (not submission authority)', review.comparison.delta], [zh ? '模型结果（非服务器预测）' : 'Modeled values (not a server prediction)', review.comparison.result]] as const) {
          const title = document.createElement('p'), pre = document.createElement('pre'); title.textContent = label; pre.textContent = text; pre.tabIndex = 0; pre.style.maxHeight = '16rem'; pre.style.overflow = 'auto'; pre.style.whiteSpace = 'pre-wrap'; pre.style.overflowWrap = 'anywhere'; results.append(title, pre);
        }
      }
    }
    for (const [label, text] of [[zh ? '本地冻结文本' : 'Captured local text', value.local], [zh ? '已捕获live文本（非写预测）' : 'Captured live text (not write prediction)', value.live ?? '']] as const) {
      const title = document.createElement('p'), pre = document.createElement('pre'); title.textContent = label; pre.textContent = text; pre.tabIndex = 0; pre.style.maxHeight = '22rem'; pre.style.overflow = 'auto'; pre.style.whiteSpace = 'pre-wrap'; pre.style.overflowWrap = 'anywhere'; results.append(title, pre);
    }
    const ranges = document.createElement('pre'); ranges.style.maxHeight = '12rem'; ranges.style.overflow = 'auto'; ranges.textContent = value.comparison?.ranges.map(range => `${range.kind} local[${range.localStart},${range.localEnd}) live[${range.liveStart},${range.liveEnd})`).join('\n') ?? ''; results.append(ranges);
  }
  return { show(value: ManifestDiffState) { state = value; paint(); }, paint, dispose() { source.dispose(); language.dispose(); from.dispose(); to.dispose(); read.dispose(); stop.dispose(); close.dispose(); model.dispose(); picker.dispose(); results.replaceChildren(); section.remove(); } };
}
