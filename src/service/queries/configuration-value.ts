import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { isDisplayText, keyContentBytes, keyReferenceSchema } from '../../shared/key-content-protocol.ts';
import type { KeyReference } from '../../shared/key-content-protocol.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { hasWellFormedUnicode } from '../../shared/identity.ts';
import { planParentResource, verifyResourceObject } from './parent-resource.ts';

export type ConfigurationValue = { readonly encoding: 'utf8' | 'base64'; readonly text: string; readonly totalBytes: number };
export function planConfigurationValue(input: unknown, target: TargetIdentity) {
  const parsed = keyReferenceSchema.safeParse(input);
  if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
  const plan = planParentResource(parsed.data.parent, target);
  return { ...plan, reference: parsed.data };
}
// This projection is only for the explicit M3 key-content path, never a default tree DTO.
export function projectConfigurationValue(input: unknown, reference: KeyReference, target: TargetIdentity): ConfigurationValue {
  const plan = planConfigurationValue(reference, target);
  verifyResourceObject(input, plan.descriptor, reference.parent);
  const parsed = z.object({ data: z.unknown().optional() }).safeParse(input);
  if (!parsed.success) throw new BoundaryError('CONTENT_INVALID');
  const data = parsed.data.data;
  if (data === undefined || data === null) throw new BoundaryError('NOT_FOUND');
  if (typeof data !== 'object' || Array.isArray(data) || ![Object.prototype, null].includes(Object.getPrototypeOf(data))) throw new BoundaryError('CONTENT_INVALID');
  if (!Object.hasOwn(data, reference.key)) throw new BoundaryError('NOT_FOUND');
  const value: unknown = Reflect.get(data, reference.key);
  if (typeof value !== 'string' || !hasWellFormedUnicode(value)) throw new BoundaryError('CONTENT_INVALID');
  let bytes: Buffer;
  if (reference.parent.resource === 'secrets') {
    if (value.length > Math.ceil(keyContentBytes / 3) * 4) throw new BoundaryError('BUDGET_EXCEEDED');
    if (value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new BoundaryError('CONTENT_INVALID');
    bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw new BoundaryError('CONTENT_INVALID');
  } else bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength > keyContentBytes) throw new BoundaryError('BUDGET_EXCEEDED');
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (isDisplayText(text) && Buffer.from(text, 'utf8').equals(bytes)) return Object.freeze({ encoding: 'utf8', text, totalBytes: bytes.byteLength });
  } catch { /* Non-text bytes are preserved below, never replaced by U+FFFD. */ }
  return Object.freeze({ encoding: 'base64', text: bytes.toString('base64'), totalBytes: bytes.byteLength });
}
