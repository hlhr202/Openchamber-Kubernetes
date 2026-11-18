import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { jobLogSelectionSourceSchema, jobLogSelectionPageSchema } from '../shared/job-log-selection-protocol.ts';
import type { JobLogSelectionSource, JobLogSelectionPage, JobLogSelected } from '../shared/job-log-selection-protocol.ts';
import type { ReadHandle, ReadTaskPhase } from '../shared/read-task-protocol.ts';
import { utf8ByteLength } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';
export type JobLogSelectionState = { phase: 'idle' | 'opening' | ReadTaskPhase; source?: JobLogSelectionSource; selected?: JobLogSelected; error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
function freeze(value: unknown): void { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }
const scheduling = (callback: () => void) => { const timer = setTimeout(callback, 500); return () => clearTimeout(timer); };
export class JobLogSelectionClient {
  readonly #request: TreeTransport; readonly #show: (state: JobLogSelectionState) => void; readonly #selected: (value: JobLogSelected, source: JobLogSelectionSource) => void; readonly #view: string; readonly #schedule: typeof scheduling;
  #revision = 0; #calls = 0; #disposed = false; #cancel: (() => void) | undefined; #handle: ReadHandle | undefined; #source: JobLogSelectionSource | undefined; #choice: JobLogSelected | undefined; #after = 0;
  constructor(request: TreeTransport, show: (state: JobLogSelectionState) => void, selected: (value: JobLogSelected, source: JobLogSelectionSource) => void, view: string, schedule = scheduling) {
    this.#request = request; this.#show = show; this.#selected = selected; this.#view = view; this.#schedule = schedule;
  }
  #emit(phase: JobLogSelectionState['phase'], error?: ErrorCode) { if (!this.#disposed) this.#show({ phase, ...(this.#source ? { source: this.#source } : {}), ...(this.#choice ? { selected: this.#choice } : {}), ...(error ? { error } : {}) }); }
  async #call(action: 'open' | 'poll' | 'release', input: unknown) {
    if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT'); const body = JSON.stringify(input); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED'); this.#calls++;
    try { const result = await this.#request({ method: 'POST', path: `/v2/logs/job/${action}`, body }); if (utf8ByteLength(result.body) > 128_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(result.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (result.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); } return value;
    } finally { this.#calls--; }
  }
  #release(handle: ReadHandle) { void this.#call('release', { protocol: 2, handle, after: 0 }).catch(() => { /* Independent lease fallback. */ }); }
  async start(input: unknown) {
    if (this.#disposed) return; this.reset(); const parsed = jobLogSelectionSourceSchema.safeParse(input); if (!parsed.success) { this.#emit('error', 'INVALID_INPUT'); return; }
    freeze(parsed.data); this.#source = parsed.data; this.#emit('opening'); await this.#load(this.#revision, true);
  }
  async #load(revision: number, opening: boolean) {
    const source = this.#source; if (this.#disposed || revision !== this.#revision || !source) return;
    try {
      const data = await this.#call(opening ? 'open' : 'poll', opening ? { ...source, consumer: { view: this.#view, epoch: revision } } : { protocol: 2, handle: this.#handle, after: this.#after });
      const parsed = jobLogSelectionPageSchema.safeParse(data); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); const page: JobLogSelectionPage = parsed.data;
      if (this.#disposed || revision !== this.#revision) { if (opening) this.#release(page.handle); return; }
      if (JSON.stringify(page.source) !== JSON.stringify(source) || page.handle.generation !== source.target.serviceGeneration || page.handle.epoch !== revision
        || !opening && JSON.stringify(page.handle) !== JSON.stringify(this.#handle)) throw new BoundaryError('STALE_TARGET');
      this.#handle = page.handle;
      if (page.lost || page.first !== 1 || page.head > 1 || page.next !== this.#after + page.events.length || page.head < page.next || page.leaseUntil > page.expiresAt
        || page.events.some(value => value.sequence !== this.#after + 1 || value.reference.namespace !== source.origin.namespace
          || value.origin.name !== source.origin.name || value.origin.namespace !== source.origin.namespace || value.origin.uid !== source.origin.uid)) throw new BoundaryError('STATE_UNAVAILABLE');
      freeze(page); if (page.events[0]) this.#choice = page.events[0]; this.#after = page.next;
      if (page.phase === 'completed' && (!this.#choice || page.head !== 1 || page.next !== 1)) throw new BoundaryError('STATE_UNAVAILABLE');
      this.#emit(page.phase, page.error);
      if (page.phase === 'starting' || page.phase === 'running') this.#cancel = this.#schedule(() => { this.#cancel = undefined; void this.#load(revision, false); });
      else { this.#handle = undefined; this.#release(page.handle); if (page.phase === 'completed' && this.#choice && revision === this.#revision) this.#selected(this.#choice, source); }
    } catch (error) { if (!this.#disposed && revision === this.#revision) { const handle = this.#handle; this.#handle = undefined; if (handle) this.#release(handle); this.#emit('error', error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); } }
  }
  stop() { ++this.#revision; this.#cancel?.(); this.#cancel = undefined; const handle = this.#handle; this.#handle = undefined; if (handle) this.#release(handle); this.#emit('error', 'QUERY_CANCELLED'); }
  reset() { ++this.#revision; this.#cancel?.(); this.#cancel = undefined; const handle = this.#handle; this.#handle = undefined; this.#source = undefined; this.#choice = undefined; this.#after = 0; if (handle) this.#release(handle); this.#emit('idle'); }
  dispose() { this.reset(); this.#disposed = true; }
}
