import { BoundaryError } from './errors.ts';
import { logPreferenceNumber } from './log-preferences.ts';
export const logDurationUnits = Object.freeze(['s', 'm', 'h'] as const);
export type LogDurationUnit = typeof logDurationUnits[number];
const secondsPerUnit = Object.freeze({ s: 1, m: 60, h: 3600 });
export const logSinceMaximumSeconds = 31_536_000;
export function isLogDurationUnit(value: string): value is LogDurationUnit { return value === 's' || value === 'm' || value === 'h'; }
// The saved/wire value stays seconds. The display unit never changes the stored schema or CLI grammar.
export function logDurationSeconds(input: string, unit: LogDurationUnit): number {
  if (!isLogDurationUnit(unit)) throw new BoundaryError('INVALID_INPUT');
  const number = logPreferenceNumber(input, logSinceMaximumSeconds);
  if (number === -1) return -1;
  const seconds = number * secondsPerUnit[unit];
  if (!Number.isSafeInteger(seconds) || seconds > logSinceMaximumSeconds) throw new BoundaryError('INVALID_INPUT');
  return seconds;
}
export function splitLogDuration(seconds: number): { value: string; unit: LogDurationUnit } {
  if (seconds === -1) return { value: '', unit: 's' };
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > logSinceMaximumSeconds) throw new BoundaryError('INVALID_INPUT');
  // Match the fixed upstream hours -> minutes -> seconds exact-divisor order, never round saved seconds.
  for (const unit of ['h', 'm', 's'] as const) if (seconds % secondsPerUnit[unit] === 0) return { value: String(seconds / secondsPerUnit[unit]), unit };
  throw new BoundaryError('INVALID_INPUT');
}
