import { BoundaryError } from '../shared/errors.ts';
import { logOutputFrameSchema } from '../shared/log-output-protocol.ts';
import type { LogOutputFrame } from '../shared/log-output-protocol.ts';
import type { PodLogState } from './pod-log-client.ts';
import type { LogFollowState } from './log-follow-client.ts';

// In-memory M3 -> M5 read-output projection. No handles/tokens/selection paths or control methods cross this DTO.
export class LogOutputProducer {
  #key = ''; #sequence = 0; #cursor = 0; #text = ''; #stream = 'pending';
  reset() { this.#key = ''; this.#sequence = 0; this.#cursor = 0; this.#text = ''; this.#stream = 'pending'; }
  snapshot(state: PodLogState): LogOutputFrame | null {
    if (state.phase === 'idle' || state.source?.kind !== 'read') { this.reset(); return null; }
    const source = state.source, binding = { target: source.target, reference: source.reference, ...(source.origin ? { origin: source.origin } : {}), container: source.container, options: source.options };
    const id = state.page?.snapshotId ?? 'pending', key = JSON.stringify([binding, id]), changed = key !== this.#key;
    const action = changed || !state.text.startsWith(this.#text) ? 'reset' : state.text === this.#text ? 'state' : 'append';
    const text = action === 'reset' ? state.text : action === 'append' ? state.text.slice(this.#text.length) : '';
    if (changed) this.#sequence = 0;
    const frame = this.#frame({ source: binding, stream: { kind: 'snapshot', id }, cursor: state.page?.end ?? 0, action, text, phase: state.phase, partial: state.stale || !!state.page?.nextCursor, ...(state.error ? { error: state.error } : {}) });
    this.#key = key; this.#text = state.text; return frame;
  }
  follow(state: LogFollowState): LogOutputFrame | null {
    const source = state.source ?? state.page?.source; if (state.phase === 'idle' || !source) { this.reset(); return null; }
    const binding = { target: source.target, reference: source.reference, ...(source.origin ? { origin: source.origin } : {}), container: source.container, options: source.options };
    const id = state.page?.handle.task ?? this.#stream, key = JSON.stringify([binding, id]), changed = key !== this.#key;
    const cursor = state.page?.next ?? (changed ? 0 : this.#cursor); let action: LogOutputFrame['action'] = 'state', text = '';
    if (cursor < this.#cursor && !changed) throw new BoundaryError('STALE_TARGET');
    if (changed || state.page?.lost && cursor > this.#cursor || state.text === '' && this.#text !== '') { action = 'reset'; text = state.text; }
    else if (cursor > this.#cursor) {
      const events = state.page?.events.filter(event => event.sequence > this.#cursor) ?? [];
      if (!events.length || events[0]?.sequence !== this.#cursor + 1 || events.at(-1)?.sequence !== cursor || events.some((event, index) => index > 0 && event.sequence !== (events[index - 1]?.sequence ?? 0) + 1)) throw new BoundaryError('STATE_UNAVAILABLE');
      action = 'append'; text = events.map(event => event.text).join(''); // Never deduplicate identical log text or infer stream position from retained suffixes.
    }
    if (changed) this.#sequence = 0;
    const frame = this.#frame({ source: binding, stream: { kind: 'follow', id }, cursor, action, text, phase: state.phase, partial: state.truncated, ...(state.error ? { error: state.error } : {}) });
    this.#key = key; this.#stream = id; this.#cursor = cursor; this.#text = state.text; return frame;
  }
  #frame(value: Omit<LogOutputFrame, 'protocol' | 'kind' | 'sequence'>): LogOutputFrame {
    const parsed = logOutputFrameSchema.safeParse({ protocol: 1, kind: 'log-output', sequence: this.#sequence + 1, ...value });
    if (!parsed.success) throw new BoundaryError('BUDGET_EXCEEDED'); this.#sequence++; return parsed.data;
  }
}
