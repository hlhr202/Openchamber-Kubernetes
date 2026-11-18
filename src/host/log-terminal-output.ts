import { BoundaryError } from '../shared/errors.ts';
import { logOutputFrameSchema, logOutputKey } from '../shared/log-output-protocol.ts';
import type { LogOutputFrame } from '../shared/log-output-protocol.ts';
import { logDisplayText } from '../shared/pod-log-protocol.ts';
export type LogOutputSink = { write: (text: string, done: () => void) => void; reset: () => void; dispose: () => void };
export type LogTerminalStatus = { frame?: LogOutputFrame; masked: boolean; error?: 'BUDGET_EXCEEDED' | 'STATE_UNAVAILABLE' | 'STALE_TARGET' };
// Read-only render admission, not a session registry. A write here only means an escaped display chunk into a local terminal parser.
export class LogTerminalOutput {
  readonly #sink: LogOutputSink; readonly #show: (value: LogTerminalStatus) => void;
  #key = ''; #sequence = 0; #cursor = 0; #revision = 0; #writeRevision = 0; #busy = false; #inflight = 0; #disposed = false; #failed = false; #masked = false; #clearPending = false;
  #queue: Array<{ frame: LogOutputFrame; offset: number; reset: boolean }> = [];
  constructor(sink: LogOutputSink, show: (value: LogTerminalStatus) => void) { this.#sink = sink; this.#show = show; }
  accept(input: unknown) {
    if (this.#disposed) return;
    try {
      const parsed = logOutputFrameSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); const frame = parsed.data, key = logOutputKey(frame), changed = key !== this.#key;
      if ((changed && (frame.action !== 'reset' || frame.sequence !== 1)) || (!changed && frame.sequence !== this.#sequence + 1) || !changed && frame.cursor < this.#cursor && frame.action !== 'reset') throw new BoundaryError('STALE_TARGET');
      if (frame.action === 'reset') { this.#queue = []; this.#revision++; this.#masked = true; this.#failed = false; this.#clearPending = false; }
      else if (this.#failed) return;
      const queued = this.#inflight + this.#queue.reduce((sum, item) => sum + item.frame.text.length - item.offset, 0) - (this.#busy && this.#writeRevision === this.#revision ? this.#inflight : 0);
      if (queued + frame.text.length > 131_072 || this.#queue.length + Number(this.#busy) >= 8) throw new BoundaryError('BUDGET_EXCEEDED');
      this.#key = key; this.#sequence = frame.sequence; this.#cursor = frame.cursor; this.#queue.push({ frame, offset: 0, reset: frame.action === 'reset' });
      this.#show({ frame, masked: this.#masked }); this.#drain();
    } catch (error) { this.fail(error instanceof BoundaryError && ['BUDGET_EXCEEDED', 'STALE_TARGET'].includes(error.code) ? error.code as 'BUDGET_EXCEEDED' | 'STALE_TARGET' : 'STATE_UNAVAILABLE'); }
  }
  #drain() {
    if (this.#disposed || this.#busy || this.#failed) return;
    if (this.#clearPending) { try { this.#sink.reset(); this.#clearPending = false; this.#masked = false; this.#show({ masked: false }); }
      catch { this.fail('STATE_UNAVAILABLE'); return; } }
    const item = this.#queue[0]; if (!item) return;
    try {
      if (item.reset) { this.#sink.reset(); item.reset = false; this.#masked = false; this.#show({ frame: item.frame, masked: false }); }
      if (item.offset >= item.frame.text.length) { this.#queue.shift(); this.#drain(); return; }
      let end = Math.min(item.frame.text.length, item.offset + 4096); const code = item.frame.text.charCodeAt(end - 1); if (end < item.frame.text.length && code >= 0xD800 && code <= 0xDBFF) end--;
      const chunk = item.frame.text.slice(item.offset, end), revision = this.#revision; this.#busy = true; this.#writeRevision = revision; this.#inflight = chunk.length;
      this.#sink.write(logDisplayText(chunk), () => {
        if (this.#disposed) return; this.#busy = false; this.#inflight = 0;
        if (revision === this.#revision && this.#queue[0] === item) item.offset = end;
        this.#drain();
      });
    } catch { this.fail('STATE_UNAVAILABLE'); }
  }
  fail(error: NonNullable<LogTerminalStatus['error']>) { if (this.#disposed) return; this.#revision++; this.#failed = true; this.#clearPending = false; this.#queue = []; this.#masked = true; this.#show({ masked: true, error }); }
  clear() { if (this.#disposed) return; this.#revision++; this.#key = ''; this.#sequence = 0; this.#cursor = 0; this.#queue = []; this.#failed = false; this.#masked = true; this.#clearPending = true; this.#show({ masked: true }); this.#drain(); }
  dispose() { if (this.#disposed) return; this.#disposed = true; this.#revision++; this.#queue = []; this.#sink.dispose(); }
}
