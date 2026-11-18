import { BoundaryError } from '../shared/errors.ts';
import type { EventRow } from '../shared/event-protocol.ts';
import { eventFollowDeltaSchema } from '../shared/event-follow-protocol.ts';
import { utf8ByteLength } from '../shared/identity.ts';

// Bounded current rows, not an audit archive. Stream sequence is authoritative; RVs are opaque, counts are replacements.
export class EventFollowBuffer {
  readonly #rows = new Map<string, EventRow>(); readonly #names = new Map<string, string>(); #bytes = 0; #truncated = false; #synchronizing = true;
  get rows(): readonly EventRow[] { return [...this.#rows.values()]; }
  get truncated() { return this.#truncated; }
  get synchronizing() { return this.#synchronizing; }
  clear(truncated = false) { this.#rows.clear(); this.#names.clear(); this.#bytes = 0; this.#truncated = truncated; this.#synchronizing = true; }
  #remove(uid: string) { const old = this.#rows.get(uid); if (old) { this.#bytes -= utf8ByteLength(JSON.stringify(old)); this.#rows.delete(uid); if (this.#names.get(old.name) === uid) this.#names.delete(old.name); } }
  apply(input: unknown, namespace: string) {
    const parsed = eventFollowDeltaSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); const event = parsed.data;
    if (event.type === 'RELISTING') { this.clear(true); return; }
    if (event.type === 'RESYNC') { this.#synchronizing = false; return; } // Complete LIST, never a guarantee of complete ring/window history.
    if (event.type === 'BOOKMARK') return; const row = event.row; if (!row || row.namespace !== namespace) throw new BoundaryError('STALE_TARGET');
    const old = this.#rows.get(row.uid);
    if (old && old.name !== row.name) throw new BoundaryError('STATE_UNAVAILABLE');
    if (event.type === 'DELETED') { this.#remove(row.uid); return; }
    if (old?.resourceVersion === row.resourceVersion) { if (JSON.stringify(old) !== JSON.stringify(row)) throw new BoundaryError('STATE_UNAVAILABLE'); return; }
    const prior = this.#names.get(row.name); if (prior && prior !== row.uid) this.#remove(prior);
    this.#remove(row.uid); Object.freeze(row.object); if (row.series) Object.freeze(row.series); Object.freeze(row);
    this.#rows.set(row.uid, row); this.#names.set(row.name, row.uid); this.#bytes += utf8ByteLength(JSON.stringify(row));
    while (this.#rows.size > 200 || this.#bytes > 256_000) { const first = this.#rows.keys().next().value; if (!first) break; this.#truncated = true; this.#remove(first); }
  }
}
