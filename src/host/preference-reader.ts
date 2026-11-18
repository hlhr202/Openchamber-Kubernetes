import { BoundaryError } from '../shared/errors.ts';
import { preferencePrefix, projectPreferenceLedger } from '../shared/preference-protocol.ts';
import type { PreferenceLedger } from '../shared/preference-protocol.ts';

export type PreferenceReadStorage = { generation: () => Promise<string>; keys: (generation: string) => Promise<string[]>; get: (key: string, generation: string) => Promise<unknown> };
// READ ONLY. Injected synthetic get/keys in tests; never accepts a storage writer/controller.
export class PreferenceReader {
  readonly #storage: PreferenceReadStorage; #calls = 0;
  constructor(storage: PreferenceReadStorage) { this.#storage = storage; }
  async read(signal?: AbortSignal): Promise<PreferenceLedger> {
    if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT'); this.#calls++;
    const expiresAt = Date.now() + 6000;
    const active = () => { if (signal?.aborted) throw new BoundaryError('QUERY_CANCELLED'); if (Date.now() >= expiresAt) throw new BoundaryError('QUERY_TIMEOUT'); };
    const keys = async (generation: string) => {
      active(); const all = await this.#storage.keys(generation); active();
      if (!Array.isArray(all) || all.length > 2000 || all.some(value => typeof value !== 'string' || value.length > 128) || new Set(all).size !== all.length) throw new BoundaryError('CONFIG_INVALID');
      const selected = all.filter(value => value.startsWith(preferencePrefix)).sort(); if (selected.length > 64) throw new BoundaryError('QUERY_LIMIT'); return selected;
    };
    try {
      active(); const generation = await this.#storage.generation(); active();
      const before = await keys(generation), entries = [];
      for (const key of before) { active(); const value = await this.#storage.get(key, generation); active(); if (value === undefined) throw new BoundaryError('STALE_TARGET'); entries.push({ key, value }); }
      const after = await keys(generation); if (JSON.stringify(before) !== JSON.stringify(after)) throw new BoundaryError('STALE_TARGET');
      active(); return Object.freeze({ ...projectPreferenceLedger(entries), serviceGeneration: generation });
    } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('STATE_UNAVAILABLE'); }
    finally { this.#calls--; } // Cancel/timeout never releases an unsettled SDK call early.
  }
}
