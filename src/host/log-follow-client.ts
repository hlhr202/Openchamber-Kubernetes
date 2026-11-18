import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { logFollowSourceSchema, logFollowPageSchema } from '../shared/log-follow-protocol.ts';
import type { LogFollowSource, LogFollowPage } from '../shared/log-follow-protocol.ts';
import type { ReadHandle, ReadTaskPhase } from '../shared/read-task-protocol.ts';
import { utf8ByteLength } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';
import { distinctPresentation, readTaskPresentation } from '../shared/presentation-state.ts';

export type LogFollowState = { phase: 'idle' | 'opening' | ReadTaskPhase; text: string; truncated: boolean; source?: LogFollowSource; page?: LogFollowPage; error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
function freeze(value: unknown): void { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }
type Schedule = (callback: () => void) => () => void;
const schedule: Schedule = callback => { const timer = setTimeout(callback, 500); return () => clearTimeout(timer); };
export class LogFollowClient {
  readonly #request: TreeTransport; readonly #show: (state: LogFollowState) => void; readonly #view: string; readonly #schedule: Schedule;
  #revision = 0; #calls = 0; #disposed = false; #cancel: (() => void) | undefined; #handle: ReadHandle | undefined; #source: LogFollowSource | undefined;
  #after = 0; #text = ''; #truncated = false;
  #phase: LogFollowState['phase'] = 'idle'; #error: ErrorCode | undefined; #displaySource: LogFollowSource | undefined;
  constructor(request: TreeTransport, show: (state: LogFollowState) => void, view: string, scheduling = schedule) { this.#request = request; this.#show = distinctPresentation(show, readTaskPresentation); this.#view = view; this.#schedule = scheduling; }
  #emit(phase: LogFollowState['phase'], page?: LogFollowPage, error?: ErrorCode) { this.#phase = phase; this.#error = error; if (!this.#disposed) this.#show({ phase, text: this.#text, truncated: this.#truncated, ...(this.#displaySource ? { source: this.#displaySource } : {}), ...(page ? { page } : {}), ...(error ? { error } : {}) }); }
  async #call(action: 'open' | 'poll' | 'release', input: unknown) {
    if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT'); const body = JSON.stringify(input); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED'); this.#calls++;
    try { const response = await this.#request({ method: 'POST', path: `/v2/logs/follow/${action}`, body }); if (utf8ByteLength(response.body) > 128_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let data: unknown; try { data = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(data); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); } return data;
    } finally { this.#calls--; }
  }
  #release(handle: ReadHandle) { void this.#call('release', { protocol: 2, handle, after: 0 }).catch(() => { /* Lease expiry is fallback, not an implicit reconnect. */ }); }
  async start(input: unknown) {
    if (this.#disposed) return; this.reset(); const revision = this.#revision, parsed = logFollowSourceSchema.safeParse(input);
    if (!parsed.success) { this.#emit('error', undefined, 'INVALID_INPUT'); return; } freeze(parsed.data); this.#source = parsed.data; this.#displaySource = parsed.data; this.#emit('opening'); await this.#load(revision, true);
  }
  async #load(revision: number, opening: boolean) {
    const source = this.#source; if (!source || this.#disposed || revision !== this.#revision) return;
    try {
      const data = await this.#call(opening ? 'open' : 'poll', opening ? { ...source, consumer: { view: this.#view, epoch: revision } } : { protocol: 2, handle: this.#handle, after: this.#after });
      const parsed = logFollowPageSchema.safeParse(data); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); const page = parsed.data;
      if (this.#disposed || revision !== this.#revision) { if (opening) this.#release(page.handle); return; }
      if (JSON.stringify(page.source) !== JSON.stringify(source) || page.handle.generation !== source.target.serviceGeneration || page.handle.epoch !== revision
        || (!opening && JSON.stringify(page.handle) !== JSON.stringify(this.#handle))) throw new BoundaryError('STALE_TARGET');
      freeze(page); this.#handle = page.handle; let previous = this.#after;
      for (const event of page.events) { if (event.sequence <= previous || (event.sequence !== previous + 1 && !(page.lost && previous === this.#after && event.sequence === page.first))) throw new BoundaryError('STATE_UNAVAILABLE'); previous = event.sequence; }
      if (page.next !== previous || page.head < page.next || (page.lost && page.first <= this.#after + 1) || page.expiresAt < page.leaseUntil) throw new BoundaryError('STATE_UNAVAILABLE');
      if (page.lost) { this.#truncated = true; this.#text = ''; } // Never join across a lost byte range as though contiguous.
      this.#after = page.next; this.#text += page.events.map(event => event.text).join('');
      if (this.#text.length > 65_536) { this.#truncated = true; this.#text = this.#text.slice(-65_536); const first = this.#text.charCodeAt(0); if (first >= 0xDC00 && first <= 0xDFFF) this.#text = this.#text.slice(1); }
      this.#emit(page.phase, page, page.error);
      if (page.phase === 'starting' || page.phase === 'running' || page.next < page.head) this.#cancel = this.#schedule(() => { this.#cancel = undefined; void this.#load(revision, false); });
      else { this.#handle = undefined; this.#release(page.handle); }
    } catch (error) { if (!this.#disposed && revision === this.#revision) { const handle = this.#handle; this.#handle = undefined; if (handle) this.#release(handle); this.#emit('error', undefined, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); } }
  }
  clear() { this.#text = ''; this.#truncated = false; this.#emit(this.#phase, undefined, this.#error); }
  stop() { ++this.#revision; this.#cancel?.(); this.#cancel = undefined; const handle = this.#handle; this.#handle = undefined; this.#source = undefined; if (handle) this.#release(handle); this.#emit('error', undefined, 'QUERY_CANCELLED'); }
  reset() { ++this.#revision; this.#cancel?.(); this.#cancel = undefined; const handle = this.#handle; this.#handle = undefined; this.#source = undefined; this.#displaySource = undefined; this.#after = 0; this.#text = ''; this.#truncated = false; if (handle) this.#release(handle); this.#emit('idle'); }
  dispose() { this.reset(); this.#disposed = true; }
}
