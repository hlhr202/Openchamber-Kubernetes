import { logPreferenceKey, logPreferencesSchema } from '../shared/log-preferences.ts';
import type { LogPreferences } from '../shared/log-preferences.ts';
export type LogPreferenceSave = 'saved' | 'unknown' | 'invalid' | 'busy';
// Explicit non-sensitive preference write. Never imported or called by automatic functional tests.
export function createLogPreferenceWriter(set: (key: string, value: LogPreferences) => Promise<void>) {
  let pending = false;
  return {
    async save(input: unknown): Promise<LogPreferenceSave> {
      const parsed = logPreferencesSchema.safeParse(input); if (!parsed.success) return 'invalid'; if (pending) return 'busy';
      const value = Object.freeze(parsed.data); pending = true;
      try { await set(logPreferenceKey, value); return 'saved'; }
      catch { return 'unknown'; } // A rejected/expired SDK result is not proof the host did not commit. Never auto-retry.
      finally { pending = false; } // Actual unsettled call keeps the slot even across view/project reset.
    },
  };
}
