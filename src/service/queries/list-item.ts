import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';

const itemSchema = z.object({ apiVersion: boundedName.optional(), kind: boundedName.optional() }).passthrough();

// Only for items of an already validated, typed collection at the expected GVR.
// Raw API lists may omit item TypeMeta. Explicit conflicts are never overwritten.
// This transient object must still go through the caller's metadata/body projection;
// it is not a public DTO, a standalone GET parser or a Watch event fallback.
export function normalizeListItemType(input: unknown, apiVersion: string, kind: string) {
  const parsed = itemSchema.safeParse(input);
  if (!parsed.success || (parsed.data.apiVersion !== undefined && parsed.data.apiVersion !== apiVersion)
    || (parsed.data.kind !== undefined && parsed.data.kind !== kind)) throw new BoundaryError('RESOURCE_INVALID');
  return { ...parsed.data, apiVersion, kind };
}
