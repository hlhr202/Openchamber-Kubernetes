import { mountButton } from '@openchamber/sdk/ui';
import { eventLastObserved, eventOccurrences } from '../shared/event-protocol.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
import { phaseLabel } from './presentation.ts';
import type { EventFollowState } from '../host/event-follow-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';

export function mountEventFollowView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), status = document.createElement('p'), list = document.createElement('div'), table = document.createElement('table'), head = document.createElement('thead'), body = document.createElement('tbody');
  list.className = 'configuration-results'; status.setAttribute('role', 'status'); table.append(head, body); list.append(table); section.append(note, status, list); container.append(section);
  let state: EventFollowState = { phase: 'idle', rows: [], truncated: false, synchronizing: true };
  const stop = mountButton(section, { label: 'Stop Follow Events', variant: 'outline', onClick: () => bridge()?.stopEventFollow() });
  const paint = () => { const zh = locale().startsWith('zh'); section.hidden = state.phase === 'idle';
    note.textContent = zh ? '跟随命名空间中的新事件。发生缺口或重新同步时会标记，不能保证完整历史。' : 'Follow new namespace events. Gaps and resynchronization are marked; complete history is not guaranteed.';
    status.textContent = `${phaseLabel(state.phase, zh)}${state.error ? ` · ${state.error}` : ''} · ${state.rows.length} ${zh ? '项' : 'events'}${state.synchronizing ? (zh ? ' · 正在同步，结果尚未完整' : ' · Synchronizing; result is incomplete') : ''}${state.truncated ? (zh ? ' · 历史不完整' : ' · Incomplete history') : ''}${state.page ? ` · ${state.page.source.namespace.name}` : ''}`;
    const row = document.createElement('tr'); for (const label of zh ? ['最近观察', '类型', '原因', '对象', '次数', '消息'] : ['Last observed', 'Type', 'Reason', 'Object', 'Count', 'Message']) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; row.append(th); } head.replaceChildren(row);
    body.replaceChildren(...state.rows.map(event => { const tr = document.createElement('tr'); for (const text of [eventLastObserved(event) ?? '—', event.type, event.reason, `${event.object.kind}/${event.object.name}`, String(eventOccurrences(event) ?? '—'), event.message]) { const td = document.createElement('td'); td.style.whiteSpace = 'pre-wrap'; td.textContent = logDisplayText(text); tr.append(td); } return tr; }));
    stop.update({ label: zh ? '停止跟随事件' : 'Stop Follow Events', disabled: !['opening', 'starting', 'running'].includes(state.phase) });
  };
  return { show(value: EventFollowState) { state = value; paint(); }, paint, dispose() { state = { phase: 'idle', rows: [], truncated: false, synchronizing: true }; body.replaceChildren(); stop.dispose(); section.remove(); } };
}
