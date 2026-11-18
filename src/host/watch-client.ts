import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { watchPageSchema, watchSourceSchema } from '../shared/watch-protocol.ts';
import type { WatchSource, WatchPage, WatchHandle } from '../shared/watch-protocol.ts';
import { utf8ByteLength } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';
import { distinctPresentation, readTaskPresentation } from '../shared/presentation-state.ts';

export type WatchState = { phase: 'idle' | 'opening' | 'starting' | 'running' | 'completed' | 'error'; page?: WatchPage; error?: ErrorCode; changed: boolean; recovery?: 'relisting' | 'resynced' };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
function freeze(value: unknown): void { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }
type Schedule = (callback: () => void) => () => void;
const schedule: Schedule = callback => { const timer = setTimeout(callback, 500); return () => clearTimeout(timer); };
export class WatchClient {
  readonly #request: TreeTransport; readonly #show: (state: WatchState) => void; readonly #view: string; readonly #schedule: Schedule;
  #revision = 0; #calls = 0; #disposed = false; #cancel: (() => void) | undefined; #handle: WatchHandle | undefined; #source: WatchSource | undefined; #after = 0;
  #recovery: WatchState['recovery'];
  constructor(request: TreeTransport, show: (state: WatchState) => void, view: string, scheduling = schedule) { this.#request = request; this.#show = distinctPresentation(show, readTaskPresentation); this.#view = view; this.#schedule = scheduling; }
  async #call(action: 'open' | 'poll' | 'release', input: unknown) {
    if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT');
    const body = JSON.stringify(input); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
    this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: `/v2/watch/${action}`, body });
      if (utf8ByteLength(response.body) > 128_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let data: unknown; try { data = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(data); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      return data;
    } finally { this.#calls--; }
  }
  #release(handle: WatchHandle) { void this.#call('release', { protocol: 2, handle, after: 0 }).catch(() => { /* Lease expiry is the fallback; no replay/retry. */ }); }
  async start(input: unknown) {
    if (this.#disposed) return; this.reset(); const revision = this.#revision;
    const source = watchSourceSchema.safeParse(input); if (!source.success || source.data.resourceVersion === '0') { this.#show({ phase: 'error', changed: false, error: 'INVALID_INPUT' }); return; }
    this.#source = source.data; this.#show({ phase: 'opening', changed: false });
    await this.#load(revision, true);
  }
  async #load(revision: number, opening: boolean) {
    const source = this.#source; if (!source || this.#disposed || revision !== this.#revision) return;
    try {
      const input = opening ? { ...source, consumer: { view: this.#view, epoch: revision } } : { protocol: 2, handle: this.#handle, after: this.#after };
      const data = await this.#call(opening ? 'open' : 'poll', input), parsed = watchPageSchema.safeParse(data);
      if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); const page = parsed.data;
      if (this.#disposed || revision !== this.#revision) { if (opening) this.#release(page.handle); return; }
      if (JSON.stringify(page.source) !== JSON.stringify(source) || page.handle.generation !== source.target.serviceGeneration || page.handle.epoch !== revision
        || (!opening && JSON.stringify(page.handle) !== JSON.stringify(this.#handle))) throw new BoundaryError('STALE_TARGET');
      freeze(page); this.#handle = page.handle;
      let previous = this.#after;
      for (const event of page.events) { if (event.sequence <= previous || (!page.lost && event.sequence !== previous + 1)) throw new BoundaryError('STATE_UNAVAILABLE'); previous = event.sequence; }
      if (page.next !== previous || page.head < page.next || (page.lost && page.first <= this.#after + 1) || page.expiresAt < page.leaseUntil) throw new BoundaryError('STATE_UNAVAILABLE');
      this.#after = page.next;
      for (const event of page.events) { if (event.type === 'RELISTING') this.#recovery = 'relisting'; if (event.type === 'RESYNC') this.#recovery = 'resynced'; }
      const changed = page.lost || page.events.some(event => event.type !== 'BOOKMARK');
      this.#show({ phase: page.phase, page, changed, ...(this.#recovery ? { recovery: this.#recovery } : {}), ...(page.error ? { error: page.error } : {}) });
      if (page.phase === 'running' || page.phase === 'starting' || page.next < page.head) this.#cancel = this.#schedule(() => { this.#cancel = undefined; void this.#load(revision, false); });
      else { this.#handle = undefined; this.#release(page.handle); }
    } catch (error) {
      if (this.#disposed || revision !== this.#revision) return;
      const handle = this.#handle; this.#handle = undefined; if (handle) this.#release(handle);
      this.#show({ phase: 'error', changed: false, error: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    }
  }
  reset() { ++this.#revision; this.#cancel?.(); this.#cancel = undefined; const handle = this.#handle; this.#handle = undefined; this.#source = undefined; this.#after = 0; this.#recovery = undefined; if (handle) this.#release(handle); if (!this.#disposed) this.#show({ phase: 'idle', changed: false }); }
  dispose() { this.reset(); this.#disposed = true; }
}
