import { mountButton } from '@openchamber/sdk/ui';
import type { EventState } from '../host/event-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { eventLastObserved, eventOccurrences } from '../shared/event-protocol.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
import { mountEventFollowView } from './event-follow-view.ts';
import type { EventFollowState } from '../host/event-follow-client.ts';

export function mountEventView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), title = document.createElement('p'), note = document.createElement('p'), status = document.createElement('p'), actions = document.createElement('div');
  const list = document.createElement('div'), table = document.createElement('table'), caption = document.createElement('caption'), head = document.createElement('thead'), body = document.createElement('tbody');
  list.className = 'configuration-results'; actions.className = 'configuration-actions'; status.setAttribute('role', 'status');
  table.append(caption, head, body); list.append(table); section.append(title, note, actions, status, list); container.append(section);
  let state: EventState = { phase: 'idle', stale: false };
  const follow = mountEventFollowView(document, section, bridge, locale);
  const startFollow = mountButton(actions, { label: 'Follow Events', variant: 'outline', onClick: () => { void bridge()?.startEventFollow(); } });
  const refresh = mountButton(actions, { label: 'Refresh events', onClick: () => { void bridge()?.reloadEvents(); } });
  const next = mountButton(actions, { label: 'Next event page', variant: 'outline', onClick: () => { void bridge()?.nextEvents(); } });
  const cancel = mountButton(actions, { label: 'Stop waiting', variant: 'ghost', onClick: () => bridge()?.cancelEvents() });
  const close = mountButton(actions, { label: 'Close events', variant: 'ghost', onClick: () => bridge()?.closeEvents() });
  const paint = () => {
    follow.paint();
    const zh = locale().startsWith('zh'), page = state.page, loading = state.phase === 'loading';
    section.hidden = state.phase === 'idle'; section.setAttribute('aria-label', zh ? 'Namespace 事件有限读取' : 'Finite namespace events'); section.setAttribute('aria-busy', String(loading));
    const source = state.source, namespace = page?.namespace.name ?? (source?.scope.kind === 'namespace' ? source.scope.name : source?.target.namespace);
    title.textContent = source ? `${source.target.context} / ${namespace ?? ''} / ${page ? page.apiVersion === 'v1' ? 'core/v1' : page.apiVersion : 'Events API pending'} Events` : '';
    title.title = page ? `Namespace UID ${page.namespace.uid} · RV ${page.namespace.resourceVersion} · EventList RV ${page.resourceVersion}` : '';
    note.textContent = zh ? '查看当前命名空间事件。事件可能过期，不能作为完整审计记录。' : 'View namespace events. Events can expire and are not a complete audit record.';
    refresh.update({ label: zh ? '刷新事件' : 'Refresh events', disabled: loading || !source });
    startFollow.update({ label: zh ? '跟随事件' : 'Follow Events', disabled: state.phase !== 'ready' || state.stale || !page });
    next.update({ label: zh ? '下一事件页' : 'Next event page', disabled: state.phase !== 'ready' || !page?.nextCursor });
    cancel.update({ label: zh ? '停止等待' : 'Stop waiting', disabled: !loading }); close.update({ label: zh ? '关闭事件' : 'Close events' });
    status.textContent = state.phase === 'error' ? `${state.error ?? 'STATE_UNAVAILABLE'}${state.stale ? (zh ? '（过期页，不可继续）' : ' (stale page; paging disabled)') : ''}`
      : loading ? (zh ? '正在读取事件…' : 'Reading events…') : page ? (zh ? `第${page.page}页，${page.rows.length}项；${page.nextCursor ? '还有分页（不是完整结果）' : '此快照已到末页'}` : `Page ${page.page}, ${page.rows.length} rows; ${page.nextCursor ? 'more pages (incomplete result)' : 'end of this snapshot'}`) : '';
    caption.textContent = zh ? 'Namespace 事件（当前单页）' : 'Namespace events (current page only)';
    const headings = document.createElement('tr');
    for (const text of zh ? ['最近观察时间', '类型', '原因', '对象', '次数', '消息'] : ['Last observed', 'Type', 'Reason', 'Object', 'Count', 'Message']) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = text; headings.append(cell); }
    head.replaceChildren(headings);
    body.replaceChildren(...(page?.rows ?? []).map(row => {
      const tr = document.createElement('tr');
      tr.title = logDisplayText(`UID ${row.uid} · RV ${row.resourceVersion} · first ${row.first ?? '—'} · eventTime ${row.eventTime ?? '—'} · reporter ${row.reporter} · action ${row.action}`);
      for (const text of [eventLastObserved(row) ?? '—', row.type, row.reason, `${row.object.kind}/${row.object.name}`, String(eventOccurrences(row) ?? '—'), row.message]) {
        const cell = document.createElement('td'); cell.style.whiteSpace = 'pre-wrap'; cell.textContent = logDisplayText(text); tr.append(cell);
      }
      return tr;
    }));
    list.hidden = !page;
  };
  return { show(value: EventState) { state = value; paint(); }, showFollow(value: EventFollowState) { follow.show(value); }, paint, dispose() { follow.dispose(); startFollow.dispose(); state = { phase: 'idle', stale: false }; body.replaceChildren(); refresh.dispose(); next.dispose(); cancel.dispose(); close.dispose(); section.remove(); } };
}
