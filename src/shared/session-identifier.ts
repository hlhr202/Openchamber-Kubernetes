import { BoundaryError } from './errors.ts';
// Pure UUID v7 formatting; callers supply cryptographic entropy.
export function sessionIdentifier(now: number, entropy: Uint8Array): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff || entropy.length !== 16) throw new BoundaryError('INVALID_INPUT');
  const value = entropy.slice();
  for (let index = 5, timestamp = now; index >= 0; index--) { value[index] = timestamp % 256; timestamp = Math.floor(timestamp / 256); }
  value[6] = 0x70 | (value[6]! & 15); value[8] = 0x80 | (value[8]! & 63);
  const text = Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
