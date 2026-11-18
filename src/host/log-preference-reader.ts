import { BoundaryError } from '../shared/errors.ts';
import { defaultLogPreferences, logPreferenceKey, readLogPreferences } from '../shared/log-preferences.ts';
import type { LogPreferences } from '../shared/log-preferences.ts';
export type LogPreferenceState = { phase: 'idle' | 'loading' | 'ready' | 'error'; settings: Readonly<LogPreferences>; error?: 'INVALID_INPUT' | 'STATE_UNAVAILABLE' | 'QUERY_LIMIT' };
// Read-only storage snapshot adapter, deliberately separate from the explicit Save writer.
export class LogPreferenceReader {
  readonly #get: (key: string) => Promise<unknown>; readonly #show: (value: LogPreferenceState) => void;
  #revision = 0; #pending = 0; #disposed = false; #settings = defaultLogPreferences;
  constructor(get: (key: string) => Promise<unknown>, show: (value: LogPreferenceState) => void) { this.#get = get; this.#show = show; }
  async read() {
    if (this.#disposed) return; const revision = ++this.#revision;
    this.#show({ phase: 'loading', settings: this.#settings });
    if (this.#pending >= 4) { this.#show({ phase: 'error', settings: defaultLogPreferences, error: 'QUERY_LIMIT' }); return; }
    this.#pending++;
    try { const input = await this.#get(logPreferenceKey); if (this.#disposed || revision !== this.#revision) return;
      this.#settings = readLogPreferences(input); this.#show({ phase: 'ready', settings: this.#settings });
    } catch (error) { if (!this.#disposed && revision === this.#revision) this.#show({ phase: 'error', settings: defaultLogPreferences, error: error instanceof BoundaryError && error.code === 'INVALID_INPUT' ? 'INVALID_INPUT' : 'STATE_UNAVAILABLE' }); }
    finally { this.#pending--; }
  }
  reset() { ++this.#revision; this.#settings = defaultLogPreferences; if (!this.#disposed) this.#show({ phase: 'idle', settings: this.#settings }); }
  dispose() { this.reset(); this.#disposed = true; }
}
