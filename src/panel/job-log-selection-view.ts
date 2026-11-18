import { mountButton } from '@openchamber/sdk/ui';
import { phaseLabel } from './presentation.ts';
import type { JobLogSelectionState } from '../host/job-log-selection-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
export function mountJobLogSelectionView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string) {
  const section = document.createElement('section'), note = document.createElement('p'), status = document.createElement('p'); status.setAttribute('role', 'status'); section.append(note, status); container.append(section);
  let state: JobLogSelectionState = { phase: 'idle' };
  const stop = mountButton(section, { label: 'Stop waiting for Job Pod', variant: 'outline', onClick: () => bridge()?.stopJobLogSelection() });
  const close = mountButton(section, { label: 'Close Job selection', variant: 'ghost', onClick: () => bridge()?.closeJobLogSelection() });
  const paint = () => { const zh = locale().startsWith('zh'), source = state.source, selected = state.selected; section.hidden = state.phase === 'idle';
    note.textContent = zh ? '选择此 Job 的日志 Pod；尚无 Pod 时等待其出现，不创建新 Pod。选定后再读取或跟随日志。' : 'Choose a log Pod for this Job, or wait for one to appear without creating a Pod. Then read or follow its logs.';
    status.textContent = `${phaseLabel(state.phase, zh)}${state.error ? ` · ${state.error}` : ''}${source ? ` · ${source.target.context}/${source.origin.namespace}/Job ${source.origin.name}` : ''}${selected ? ` · ${selected.candidates} ${zh ? '候选，选择' : 'candidates, using'} ${selected.reference.name}${selected.waited ? (zh ? ' · 等待后首个匹配' : ' · first match after waiting') : ''}` : ''}`;
    stop.update({ label: zh ? '停止等待 Job Pod' : 'Stop waiting for Job Pod', disabled: !['opening', 'starting', 'running'].includes(state.phase) }); close.update({ label: zh ? '关闭 Job 来源选择' : 'Close Job selection' });
  };
  return { show(value: JobLogSelectionState) { state = value; paint(); }, paint, dispose() { state = { phase: 'idle' }; stop.dispose(); close.dispose(); section.remove(); } };
}
