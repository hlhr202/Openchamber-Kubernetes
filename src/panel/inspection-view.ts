import { mountButton } from '@openchamber/sdk/ui';
import type { InspectionState } from '../host/inspection-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
import { renderInspectionText } from './inspection-text.ts';

export function mountInspectionView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), title = document.createElement('p'), note = document.createElement('p'), status = document.createElement('p'),
    actions = document.createElement('div'), output = document.createElement('div'), pre = document.createElement('pre'),
    details = document.createElement('details'), summary = document.createElement('summary'), technical = document.createElement('p');
  section.className = 'oc-k8s-inspection'; title.className = 'oc-k8s-inspection-target'; note.className = 'oc-k8s-inspection-note';
  status.className = 'oc-k8s-inspection-status'; details.className = 'oc-k8s-inspection-details';
  actions.className = 'configuration-actions'; output.className = 'oc-k8s-inspection-output'; status.setAttribute('role', 'status');
  pre.setAttribute('translate', 'no'); output.tabIndex = 0; output.setAttribute('role', 'region');
  output.append(pre); details.append(summary, technical); section.append(title, note, status, actions, details, output); container.append(section);
  let state: InspectionState = { phase: 'idle', stale: false, text: '', complete: false }, renderedText: string | undefined;
  const nextSlot = document.createElement('span'), cancelSlot = document.createElement('span');
  actions.append(nextSlot);
  const next = mountButton(nextSlot, { label: 'Load more', onClick: () => { void bridge()?.nextInspection(); } });
  const refresh = mountButton(actions, { label: 'Refresh', variant: 'outline', onClick: () => { void bridge()?.refreshInspection(); } });
  actions.append(cancelSlot);
  const cancel = mountButton(cancelSlot, { label: 'Stop loading', variant: 'ghost', onClick: () => bridge()?.cancelInspection() });
  const close = mountButton(actions, { label: 'Close', variant: 'ghost', onClick: () => bridge()?.closeInspection() });
  const paint = () => {
    const zh = locale().toLowerCase().startsWith('zh'), loading = state.phase === 'loading', source = state.source, cluster = source?.mode === 'cluster-info';
    section.hidden = state.phase === 'idle'; section.setAttribute('aria-label', zh ? '资源详情（只读）' : 'Resource details (read only)'); section.setAttribute('aria-busy', String(loading));
    output.setAttribute('aria-label', zh ? '资源详情输出' : 'Resource details output');
    title.textContent = source ? cluster ? `${source.target.context} · kube-system` : `${source.target.context} · ${source.reference.namespace ?? (zh ? '集群资源' : 'Cluster scope')} · ${source.reference.type.kind} / ${source.reference.name}` : '';
    note.textContent = cluster ? (zh ? '查看控制面和集群服务地址。不会自动打开链接或修改集群。' : 'Control-plane and cluster service addresses. Links are not opened automatically.')
      : source?.mode === 'wide' ? (zh ? '查看资源概览。点击刷新获取最新结果，不会修改集群。' : 'Resource overview. Refresh to fetch the latest result; the cluster is not modified.')
        : (zh ? '查看资源详情、容器状态和最近事件。此操作不会修改集群。' : 'Resource details, container state and recent events. This does not modify the cluster.');
    const bytes = state.page ? new Intl.NumberFormat(zh ? 'zh-CN' : 'en', { maximumFractionDigits: 1 }).format(state.page.totalBytes / 1024) : '';
    status.textContent = loading ? (zh ? '正在读取…' : 'Loading…')
      : state.phase === 'error' ? `${zh ? '读取失败，请重试刷新' : 'Could not load. Try Refresh'}${state.error ? ` (${state.error})` : ''}`
        : state.phase === 'ready' ? `${state.complete ? (zh ? '已加载全部内容' : 'All content loaded') : (zh ? '已加载部分内容，可继续读取' : 'Partial content loaded; load more to continue')}${bytes ? ` · ${bytes} KB` : ''}` : '';
    if (state.stale) status.textContent += zh ? ' · 当前显示的是之前读取的结果' : ' · Showing the previous result';
    status.dataset.tone = state.phase === 'error' ? 'error' : loading ? 'info' : state.stale ? 'warning' : 'neutral';
    summary.textContent = zh ? '查看资源标识' : 'Resource identifiers';
    details.hidden = !source || cluster;
    technical.textContent = source && source.mode !== 'cluster-info'
      ? `${source.reference.type.group || 'core'}/${source.reference.type.version} · UID ${source.reference.uid} · Resource version ${source.reference.resourceVersion}` : '';
    if (renderedText !== state.text) {
      renderedText = state.text;
      renderInspectionText(document, pre, logDisplayText(state.text));
    }
    next.update({ label: zh ? '继续读取' : 'Load more', disabled: state.phase !== 'ready' || !state.page?.nextCursor });
    nextSlot.hidden = !state.page?.nextCursor;
    refresh.update({ label: zh ? '刷新' : 'Refresh', disabled: loading || !source });
    cancel.update({ label: zh ? '停止读取' : 'Stop loading', disabled: !loading }); cancelSlot.hidden = !loading;
    close.update({ label: zh ? '关闭' : 'Close' });
  };
  return { show(value: InspectionState) { state = value; paint(); }, paint, dispose() { state = { phase: 'idle', stale: false, text: '', complete: false }; renderedText = undefined; pre.textContent = ''; for (const button of [next, refresh, cancel, close]) button.dispose(); section.remove(); } };
}
