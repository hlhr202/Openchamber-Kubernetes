import { z } from 'zod';
import { BoundaryError } from './errors.ts';
export const logPreferenceKey = 'log-viewer.v1';
const number = (maximum: number) => z.union([z.literal(-1), z.number().int().min(1).max(maximum)]);
export const logPreferencesSchema = z.object({ version: z.literal(1), follow: z.boolean(), timestamp: z.boolean(), wrap: z.boolean(), autorun: z.boolean(),
  since: number(31_536_000), tail: number(1_000_000), destination: z.enum(['Webview', 'Terminal']) }).strict();
export type LogPreferences = z.infer<typeof logPreferencesSchema>;
export const defaultLogPreferences: Readonly<LogPreferences> = Object.freeze({ version: 1, follow: false, timestamp: false, wrap: false, autorun: false, since: -1, tail: -1, destination: 'Webview' });
export function readLogPreferences(input: unknown): Readonly<LogPreferences> {
  if (input === undefined) return defaultLogPreferences;
  const parsed = logPreferencesSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); return Object.freeze(parsed.data);
}
export function logPreferenceNumber(input: string, maximum: number): number {
  if (!input) return -1;
  if (!/^-?\d{1,8}$/.test(input)) throw new BoundaryError('INVALID_INPUT'); const value = Number(input);
  if (value <= 0) return -1; if (value > maximum) throw new BoundaryError('INVALID_INPUT'); return value;
}
export function logOptionsFromPreferences(value: LogPreferences) {
  const parsed = logPreferencesSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const settings = parsed.data;
  return { timestamps: settings.timestamp, sinceSeconds: settings.since === -1 ? null : settings.since, tailLines: settings.tail === -1 ? null : settings.tail };
}
// Pure decision state only: not a read executor and cannot call storage, SDK or a session.
export class LogOpenDefaults {
  #taken = false; #touched = false; #revision = 0;
  get revision() { return this.#revision; }
  get touched() { return this.#touched; }
  reset() { this.#taken = false; this.#touched = false; this.#revision++; }
  touch() { this.#touched = true; this.#taken = true; }
  take(ready: boolean, containers: number, preferences: Readonly<LogPreferences>): { settings: Readonly<LogPreferences>; autorun: boolean; revision: number } | null {
    if (!ready || !Number.isSafeInteger(containers) || containers < 1 || containers > 128 || this.#taken || this.#touched) return null;
    const settings = readLogPreferences(preferences); this.#taken = true; return { settings, autorun: settings.autorun, revision: this.#revision };
  }
}
