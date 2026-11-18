import { mountButton } from '@openchamber/sdk/ui';
import type { BranchState } from '../host/branch-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { parentFromResource } from '../shared/branch-protocol.ts';
import { keyReferenceFromNode } from '../shared/key-content-protocol.ts';
import { jobLogOriginFromParent } from '../shared/pod-log-protocol.ts';
import { customDocumentReferenceFromNode, documentReferenceFromNode } from '../shared/document-protocol.ts';
import { mountDeleteActions } from './delete-actions.ts';
import { mountCopyNameButton } from './copy-name-button.ts';

// Explicit diagnostic controls only. This does not stand in for the measured, accessible tree.
export function mountBranchDiagnostics(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), actions = document.createElement('div'), status = document.createElement('p'), note = document.createElement('p');
  const list = document.createElement('div'), table = document.createElement('table'), caption = document.createElement('caption'), body = document.createElement('tbody');
  actions.className = 'configuration-actions'; list.className = 'configuration-results'; status.setAttribute('role', 'status');
  table.append(caption, body); list.append(table); section.append(note, actions, status, list); container.append(section);
  let state: BranchState = { phase: 'idle', stale: false }, enabled = false;
  const rows: (() => void)[] = [];
  const custom = mountButton(actions, { label: 'Read custom types', disabled: true, onClick: () => { void bridge()?.readCustomTypes(); } });
  const watch = mountButton(actions, { label: 'Watch custom resource directory', disabled: true, variant: 'outline', onClick: () => { void bridge()?.startCustomWatch(); } });
  const next = mountButton(actions, { label: 'Next branch page', disabled: true, onClick: () => { void bridge()?.nextBranch(); } });
  const cancel = mountButton(actions, { label: 'Stop waiting', disabled: true, variant: 'ghost', onClick: () => bridge()?.cancelBranch() });
  const paint = () => {
    const zh = locale().startsWith('zh'), loading = state.phase === 'loading';
    for (const dispose of rows.splice(0)) dispose();
    section.setAttribute('aria-label', zh ? '分支读取诊断（非资源树）' : 'Branch read diagnostics (not the resource tree)');
    section.setAttribute('aria-busy', String(loading));
    note.textContent = zh ? '点击资源行读取子项，或读取 Custom Resources 类型及实例；每页重新核对父对象/CRD。配置键仅显示键名，不显示值。非完整资源树，外部变更仍有非原子竞争窗口。'
      : 'Read children from a resource row, or read Custom Resources types and instances. Each page rechecks its parent/CRD. Configuration keys contain names only, never values. Not the full resource tree; external changes are not atomic with these reads.';
    custom.update({ label: zh ? '读取自定义类型' : 'Read custom types', disabled: !enabled || loading });
    watch.update({ label: zh ? '观察此CRD资源目录' : 'Watch this CRD resource directory', disabled: !enabled || state.phase !== 'ready' || state.stale || state.page?.kind !== 'custom-resources' });
    next.update({ label: zh ? '下一分支页' : 'Next branch page', disabled: state.phase !== 'ready' || state.stale || !state.page?.nextCursor });
    cancel.update({ label: zh ? '停止等待' : 'Stop waiting', disabled: !loading });
    const stale = state.stale ? (zh ? '（过期结果，不可展开）' : ' (stale results; expansion disabled)') : '';
    status.textContent = state.phase === 'idle' ? (zh ? '尚未查询分支。' : 'No branch query started.') : state.phase === 'loading' ? `${zh ? '正在读取分支…' : 'Reading branch…'}${stale}`
      : state.phase === 'error' ? `${state.error ?? 'STATE_UNAVAILABLE'}${stale}` : `${state.page?.kind ?? ''}: ${state.page?.nodes.length ?? 0}`;
    const origin = state.page?.kind === 'children' ? jobLogOriginFromParent(state.page.parent) : null;
    caption.textContent = origin ? (zh ? `Job ${origin.namespace}/${origin.name}：明确选择实际日志 Pod（仅当前页）` : `Job ${origin.namespace}/${origin.name}: select the actual log Pod (current page)`)
      : zh ? '当前分支单页（非资源总数）' : 'Current branch page (not a resource total)';
    list.hidden = !state.page;
    body.replaceChildren(...(state.page?.nodes ?? []).map(node => {
      const row = document.createElement('tr'), label = document.createElement('td'), kind = document.createElement('td'), action = document.createElement('td');
      label.textContent = node.label; kind.textContent = node.type === 'resource' ? `${node.resource.kind} / ${node.resource.namespace ?? '—'}` : node.type;
      row.append(label, kind, action);
      if (node.type === 'resource' && state.page) rows.push(mountCopyNameButton(document, action, bridge, { kind: 'branch', id: node.id, target: state.page.target }, zh,
        state.phase !== 'ready' || state.stale || !enabled));
      const documentReference = node.type === 'resource' ? documentReferenceFromNode(node) : null;
      if (state.page?.kind === 'custom-resources' && node.type === 'resource' && node.resource.uid && node.resource.resourceVersion) {
        const observe = mountButton(action, { label: zh ? '观察此CRD实例' : 'Watch this CRD instance', variant: 'outline', disabled: state.phase !== 'ready' || state.stale || !enabled,
          onClick: () => { void bridge()?.startCustomWatch(node.id); } }); rows.push(() => observe.dispose());
      }
      if (documentReference) rows.push(mountDeleteActions(action, documentReference, bridge, zh, state.phase !== 'ready' || state.stale || !enabled));
       const loadReference = documentReference ?? (state.page?.kind === 'custom-resources' ? customDocumentReferenceFromNode(node, state.page.definition) : null);
       if (loadReference) for (const format of ['yaml', 'json'] as const) {
         const button = mountButton(action, { label: zh ? `加载 ${format.toUpperCase()}` : `Load ${format.toUpperCase()}`, variant: 'outline', disabled: state.phase !== 'ready' || state.stale || !enabled,
           onClick: () => { void bridge()?.readDocument(loadReference, format); } }); rows.push(() => button.dispose());
       }
       if (loadReference && 'definition' in loadReference) for (const mode of ['wide', 'describe'] as const) {
         const button = mountButton(action, { label: mode === 'wide' ? (zh ? 'Get wide（只读）' : 'Get wide (read only)') : (zh ? 'Describe（只读）' : 'Describe (read only)'),
           variant: 'outline', disabled: state.phase !== 'ready' || state.stale || !enabled,
           onClick: () => { void bridge()?.readInspection(loadReference, mode); } }); rows.push(() => button.dispose());
       }
      const parent = node.type === 'resource' ? parentFromResource(node) : null;
      if (node.type === 'folder') {
        const button = mountButton(action, { label: zh ? '读取实例' : 'Read instances', variant: 'outline', disabled: state.phase !== 'ready' || !enabled,
          onClick: () => { void bridge()?.readCustomResources(node.definition); } }); rows.push(() => button.dispose());
      } else if (parent) {
        const button = mountButton(action, { label: zh ? '读取子项' : 'Read children', variant: 'outline', disabled: state.phase !== 'ready' || !enabled,
          onClick: () => { void bridge()?.readChildren(parent); } }); rows.push(() => button.dispose());
        if (parent.resource === 'pods' && parent.namespace) {
          const reference = { ...parent, resource: 'pods' as const, namespace: parent.namespace };
          const logs = mountButton(action, { label: origin ? (zh ? '查看此 Job Pod 日志' : 'View this Job Pod logs') : (zh ? '打开 Pod 日志' : 'Open Pod logs'), variant: 'outline', disabled: state.phase !== 'ready' || !enabled,
            onClick: () => { void bridge()?.openPodLog(reference, origin ?? undefined); } }); rows.push(() => logs.dispose());
        } else if (parent.resource === 'jobs') {
          const logs = mountButton(action, { label: zh ? '选择 Job 日志 Pod' : 'Select Job log Pod', variant: 'outline', disabled: state.phase !== 'ready' || !enabled,
            onClick: () => { void bridge()?.readChildren(parent); } }); rows.push(() => logs.dispose());
        }
      } else if (node.type === 'config-key') {
        const reference = keyReferenceFromNode(node);
        const button = mountButton(action, { label: zh ? '查看内容' : 'View content', variant: 'outline', disabled: !reference || state.phase !== 'ready' || !enabled,
          onClick: () => { if (reference) void bridge()?.readKeyContent(reference); } }); rows.push(() => button.dispose());
      }
      return row;
    }));
  };
  return {
    show(value: BranchState) { state = value; paint(); },
    update(available: boolean) { enabled = available; paint(); },
    dispose() { for (const dispose of rows.splice(0)) dispose(); custom.dispose(); watch.dispose(); next.dispose(); cancel.dispose(); section.remove(); },
  };
}
