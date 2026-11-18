import { mountButton, mountSelect, mountTextField } from './controls.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
import { filterLogRanges, findLogMatch, logSearchParts, logViewerPage, logViewerPageCharacters } from '../shared/log-viewer.ts';
import type { LogFilterMode } from '../shared/log-viewer.ts';
import { LogFilterFailure } from '../shared/log-filter.ts';
import { hasWellFormedUnicode } from '../shared/identity.ts';
import { parseLogSgr, selectLogSgrRanges, logSgrDisplayParts, LogStyleFailure } from '../shared/log-ansi.ts';
import type { LogSgrText } from '../shared/log-ansi.ts';
import { disclosure } from './presentation.ts';
import { bindScene } from './workspace-scene.ts';

// Local text only. No service/bridge imports, lifecycle controls, persistence or implicit clipboard calls.
export function mountLogTextView(document: Document, container: HTMLElement, locale: () => string, copyPage: (text: string) => Promise<unknown>, wrapChangedByUser: (value: boolean) => void = () => {}) {
  const section = document.createElement('section'), fields = document.createElement('div'), filterSlot = document.createElement('div'), modeSlot = document.createElement('div'), searchSlot = document.createElement('div');
  const actions = document.createElement('div'), status = document.createElement('p'), viewport = document.createElement('div'), pre = document.createElement('pre');
  const wrapLabel = document.createElement('label'), wrapText = document.createElement('span'), wrap = document.createElement('input'); wrap.type = 'checkbox'; wrapLabel.append(wrap, wrapText);
  const ansiLabel = document.createElement('label'), ansiText = document.createElement('span'), ansi = document.createElement('input'); ansi.type = 'checkbox'; ansi.checked = true; ansiLabel.append(ansi, ansiText);
  fields.className = 'log-viewer-fields'; actions.className = 'configuration-actions'; viewport.className = 'log-viewer-output'; viewport.tabIndex = 0; status.setAttribute('role', 'status'); viewport.append(pre);
  fields.append(searchSlot, wrapLabel); section.append(fields, actions, status, viewport); container.append(section);
  section.className = 'oc-k8s-log-viewer';
  const advanced = disclosure(document, section, 'Filter options'), advancedActions = document.createElement('div');
  advancedActions.className = 'configuration-actions'; advanced.body.append(filterSlot, modeSlot, ansiLabel, advancedActions);
  section.insertBefore(advanced.element, status);
  let text = '', filtered = '', draft = '', pattern = '', mode: LogFilterMode = 'include', appliedMode: LogFilterMode = 'include', query = '', page = 0, hit = -1, pinned = false, disposed = false, revision = 0;
  let error = '', renderError = '', copied = '', dirty = true, sourceKey = '', styled: LogSgrText = { text: '', runs: [] };
  const validQuery = () => query.length <= 128 && hasWellFormedUnicode(query);
  const clearSearch = () => { query = ''; hit = -1; search.update({ value: '' }); };
  const project = () => { error = ''; try { const source = parseLogSgr(text, ansi.checked); styled = selectLogSgrRanges(source, filterLogRanges(source.text, pattern, appliedMode)); filtered = styled.text; }
    catch (failure) { filtered = ''; styled = { text: '', runs: [] }; error = failure instanceof LogFilterFailure || failure instanceof LogStyleFailure ? failure.code : 'FILTER_INVALID'; } };
  const locate = (backward = false) => {
    if (!query || !filtered || !validQuery()) { paint(); return; }
    hit = findLogMatch(filtered, query, hit, backward);
    if (hit >= 0) { page = Math.floor(hit / logViewerPageCharacters); pinned = false; }
    paint();
    if (hit >= 0) pre.querySelector('mark')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const filter = mountTextField(filterSlot, { label: 'Filter (bounded regular expression)', value: '', onChange: value => { draft = value.slice(0, 129); filter.update({ value: draft }); } });
  const modeField = mountSelect(modeSlot, { label: 'Filter mode', value: mode, options: [], onChange: value => { if (['include', 'exclude', 'before', 'after'].includes(value)) { mode = value as LogFilterMode; modeField.update({ value: mode }); } } });
  const search = mountTextField(searchSlot, { label: 'Find (literal, case-sensitive)', value: '', onChange: value => {
    query = value.slice(0, 129); search.update({ value: query }); hit = -1; copied = ''; if (query) locate(); else paint();
  } });
  const apply = mountButton(advancedActions, { label: 'Apply filter', variant: 'outline', onClick: () => { pattern = draft; appliedMode = mode; project(); hit = -1; page = 0; pinned = false; copied = ''; if (query) locate(); else paint(); } });
  const reset = mountButton(advancedActions, { label: 'Reset view', variant: 'ghost', onClick: () => { draft = ''; pattern = ''; mode = 'include'; appliedMode = mode; filter.update({ value: '' }); modeField.update({ value: mode }); clearSearch(); wrap.checked = false; ansi.checked = true; wrapChangedByUser(false); pinned = false; page = 0; copied = ''; project(); paint(); } });
  const previous = mountButton(actions, { label: 'Previous page', variant: 'outline', onClick: () => { page--; pinned = false; hit = -1; copied = ''; paint(); viewport.scrollTop = 0; } });
  const next = mountButton(actions, { label: 'Next page', variant: 'outline', onClick: () => { page++; pinned = false; hit = -1; copied = ''; paint(); viewport.scrollTop = 0; } });
  const findPrevious = mountButton(actions, { label: 'Previous match', variant: 'ghost', onClick: () => locate(true) });
  const findNext = mountButton(actions, { label: 'Next match', variant: 'ghost', onClick: () => locate() });
  const bottom = mountButton(actions, { label: 'Go to bottom / follow display', variant: 'outline', onClick: () => { pinned = true; hit = -1; copied = ''; paint(); } });
  const copy = mountButton(actions, { label: 'Copy page (escaped)', variant: 'outline', onClick: () => {
    const current = revision; const value = pre.textContent ?? ''; if (!value || disposed || error || renderError) return;
    // Only this explicit click invokes the official SDK callback. Never auto-copy on load/poll/paint/search.
    void copyPage(value).then(() => { if (!disposed && current === revision) { copied = 'COPIED'; paint(false); } }, () => { if (!disposed && current === revision) { copied = 'COPY_FAILED'; paint(false); } });
  } });
  const wrapChanged = () => { copied = ''; wrapChangedByUser(wrap.checked); paint(); };
  const ansiChanged = () => { hit = -1; page = 0; pinned = false; copied = ''; project(); paint(); };
  const scroll = () => { if (viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 2) pinned = false; };
  wrap.addEventListener('change', wrapChanged); ansi.addEventListener('change', ansiChanged); viewport.addEventListener('scroll', scroll);
  bindScene(section, 'log-viewer', () => ({ draft, pattern, mode, appliedMode, query, page, hit, pinned, copied, wrap: wrap.checked, ansi: ansi.checked }), value => {
    draft = value.draft; pattern = value.pattern; mode = value.mode; appliedMode = value.appliedMode; query = value.query;
    page = value.page; hit = value.hit; pinned = value.pinned; copied = value.copied; wrap.checked = value.wrap; ansi.checked = value.ansi; project(); paint();
  });
  function paint(content = true) {
    if (disposed) return; const zh = locale().startsWith('zh');
    if (pinned) page = Number.MAX_SAFE_INTEGER; const current = logViewerPage(filtered, page); page = current.page;
    if (content || dirty) {
      ++revision; const top = viewport.scrollTop, left = viewport.scrollLeft;
      const relative = hit - current.start;
      const parts = query && validQuery() && relative >= 0 && relative < current.text.length ? [
        { text: current.text.slice(0, relative), match: false }, { text: current.text.slice(relative, relative + query.length), match: true }, { text: current.text.slice(relative + query.length), match: false },
      ] : logSearchParts(current.text, validQuery() ? query : '');
      renderError = '';
      try { pre.replaceChildren(...logSgrDisplayParts(styled, current.start, parts).map(part => {
        const node = document.createElement(part.match ? 'mark' : 'span'); node.textContent = logDisplayText(part.text);
        const style = part.style, foreground = style.foreground ?? 'var(--oc-fg)', background = style.background ?? 'var(--oc-bg)';
        if (style.inverse) { node.style.color = background; node.style.backgroundColor = foreground; }
        else { if (style.foreground) node.style.color = style.foreground; if (style.background) node.style.backgroundColor = style.background; }
        if (style.bold) node.style.fontWeight = 'bold'; if (style.dim) node.style.opacity = '0.7'; if (style.italic) node.style.fontStyle = 'italic';
        const decoration = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' '); if (decoration) node.style.textDecoration = decoration;
        return node;
      })); } catch { pre.replaceChildren(); renderError = 'LOG_STYLE_BUDGET'; }
      pre.style.whiteSpace = wrap.checked ? 'pre-wrap' : 'pre'; pre.style.overflowWrap = wrap.checked ? 'anywhere' : 'normal';
      viewport.scrollTop = pinned ? viewport.scrollHeight : top; viewport.scrollLeft = left; dirty = false;
    }
    viewport.setAttribute('aria-label', zh ? '日志文本（可滚动、分页）' : 'Log text (scrollable, paged)');
    wrapText.textContent = zh ? '自动换行' : 'Wrap lines';
    ansiText.textContent = zh ? '显示日志原有颜色' : 'Show log colors';
    advanced.summary.textContent = zh ? '过滤选项' : 'Filter options';
    filter.update({ label: zh ? '正则过滤' : 'Regular expression filter' });
    modeField.update({ label: zh ? '过滤方式' : 'Filter mode', value: mode, options: [
      { id: 'include', label: zh ? '包含匹配行' : 'Include matching lines' }, { id: 'exclude', label: zh ? '排除匹配行' : 'Exclude matching lines' },
      { id: 'before', label: zh ? '首个匹配之前（不含）' : 'Before first match (exclusive)' }, { id: 'after', label: zh ? '首个匹配之后（含）' : 'After first match (inclusive)' },
    ] });
    search.update({ label: zh ? '查找（字面文本、区分大小写）' : 'Find (literal, case-sensitive)' });
    apply.update({ label: zh ? '应用过滤' : 'Apply filter' }); reset.update({ label: zh ? '重置展示' : 'Reset view' });
    previous.update({ label: zh ? '上一页' : 'Previous page', disabled: page === 0 }); next.update({ label: zh ? '下一页' : 'Next page', disabled: page + 1 >= current.count });
    findPrevious.update({ label: zh ? '上个匹配' : 'Previous match', disabled: !query || !filtered || !validQuery() || filtered.indexOf(query) < 0 }); findNext.update({ label: zh ? '下个匹配' : 'Next match', disabled: !query || !filtered || !validQuery() || filtered.indexOf(query) < 0 });
    bottom.update({ label: zh ? '跳到末尾' : 'Go to bottom' }); copy.update({ label: zh ? '复制本页' : 'Copy page', disabled: !current.text || !!error || !!renderError });
    const problem = error ? (zh ? `过滤失败，请简化正则表达式 (${error})` : `Filter failed. Simplify the expression (${error})`)
      : renderError ? (zh ? `无法显示颜色，请在过滤选项中关闭颜色 (${renderError})` : `Cannot show colors. Disable colors in Filter options (${renderError})`) : '';
    status.textContent = `${problem || (current.text ? (zh ? `第 ${page + 1} / ${current.count} 页` : `Page ${page + 1} / ${current.count}`) : (zh ? '暂无日志' : 'No logs'))}${!validQuery() ? (zh ? ' · 查找内容不能超过 128 字符' : ' · Search must be at most 128 characters') : query && filtered.indexOf(query) < 0 ? (zh ? ' · 未找到' : ' · No matches') : ''}${pinned ? (zh ? ' · 已定位末尾' : ' · At bottom') : ''}${copied ? (copied === 'COPIED' ? (zh ? ' · 已复制' : ' · Copied') : (zh ? ' · 复制失败，请重试' : ' · Copy failed; try again')) : ''}`;
    status.dataset.tone = problem ? 'error' : 'neutral';
    if (problem) advanced.element.open = true;
  }
  return {
    show(value: string, key: string) {
      if (disposed) return;
      if (sourceKey !== key) { sourceKey = key; draft = ''; pattern = ''; mode = 'include'; appliedMode = mode; filter.update({ value: '' }); modeField.update({ value: mode }); clearSearch(); page = 0; pinned = false; wrap.checked = false; ansi.checked = true; dirty = true; }
      if (text !== value) { text = value; hit = -1; copied = ''; dirty = true; }
      if (dirty) project(); paint(dirty);
    }, paint: () => paint(false), setWrap(value: boolean) { if (wrap.checked !== value) { wrap.checked = value; paint(); } },
    dispose() { disposed = true; ++revision; text = ''; filtered = ''; draft = ''; pattern = ''; query = ''; sourceKey = ''; styled = { text: '', runs: [] }; pre.replaceChildren(); wrap.removeEventListener('change', wrapChanged); ansi.removeEventListener('change', ansiChanged); viewport.removeEventListener('scroll', scroll);
      for (const control of [filter, modeField, search, apply, reset, previous, next, findPrevious, findNext, bottom, copy]) control.dispose(); section.remove(); },
  };
}
