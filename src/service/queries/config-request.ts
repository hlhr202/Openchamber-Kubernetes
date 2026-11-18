import { BoundaryError } from '../../shared/errors.ts';
import { configReadRequestSchema } from '../../shared/protocol.ts';

export const configRequestBytes = 32_000;
export function parseConfigReadRequest(text: string) {
  if (Buffer.byteLength(text) > configRequestBytes) throw new BoundaryError('BUDGET_EXCEEDED');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new BoundaryError('INVALID_INPUT'); }
  const result = configReadRequestSchema.safeParse(value);
  if (!result.success) throw new BoundaryError('INVALID_INPUT');
  return result.data;
}
