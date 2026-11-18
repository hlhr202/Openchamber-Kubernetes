import { mountButton } from '@openchamber/sdk/ui';
import { mountLogTextView } from './log-text-view.ts';
import type { LogFollowState } from '../host/log-follow-client.ts';
import type { mountHostBridge } from '../host/bridge.ts';
import { mountLogTerminalView } from './log-terminal-view.ts';
import { phaseLabel } from './presentation.ts';

export function mountLogFollowView(document: Document, container: HTMLElement, bridge: () => ReturnType<typeof mountHostBridge> | undefined, locale: () => string, wrap: () => boolean = () => false, wrapChanged: (value: boolean) => void = () => {}, terminalDestination: () => boolean = () => false) {
  const section = document.createElement('section'), note = document.createElement('p'), status = document.createElement('p'), output = document.createElement('div');
  status.setAttribute('role', 'status'); section.append(note, status, output); container.append(section); let state: LogFollowState = { phase: 'idle', text: '', truncated: false };
  const viewer = mountLogTextView(document, output, locale, text => bridge()?.copyLogPage(text) ?? Promise.reject(new Error('HOST_UNAVAILABLE')), wrapChanged);
  const terminalSlot = document.createElement('div'); section.append(terminalSlot); const terminal = mountLogTerminalView(document, terminalSlot, locale);
  const stop = mountButton(section, { label: 'Stop Follow', variant: 'outline', onClick: () => bridge()?.stopLogFollow() });
  function paint() { const zh = locale().startsWith('zh'), source = state.source ?? state.page?.source; section.hidden = state.phase === 'idle';
    section.className = 'oc-k8s-log-follow'; note.hidden = true;
    status.textContent = `${phaseLabel(state.phase, zh)}${state.error ? ` · ${state.error}` : ''}${state.truncated ? (zh ? ' · 日志不完整，部分内容已丢失' : ' · Incomplete logs; some content was lost') : ''}${source ? ` · ${source.origin ? `Job ${source.origin.name} → ` : ''}${source.reference.namespace}/${source.reference.name}/${source.container}` : ''}`;
    viewer.show(state.text, source ? JSON.stringify(source) : ''); viewer.setWrap(wrap()); stop.update({ label: zh ? '停止跟随' : 'Stop Follow', disabled: !['opening', 'starting', 'running'].includes(state.phase) });
    output.hidden = terminalDestination(); terminal.setEnabled(terminalDestination() && state.phase !== 'idle'); terminal.follow(state);
  }
  return { show(value: LogFollowState) { state = value; paint(); }, paint, dispose() { terminal.dispose(); viewer.dispose(); state = { phase: 'idle', text: '', truncated: false }; stop.dispose(); section.remove(); } };
}
