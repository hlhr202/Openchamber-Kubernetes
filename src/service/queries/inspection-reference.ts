import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';
import { inspectionReferenceSchema } from '../../shared/inspection-protocol.ts';
import type { InspectionReference } from '../../shared/inspection-protocol.ts';
import { verifyResourceObject } from './parent-resource.ts';

const metadataVersion = z.object({ metadata: z.object({ resourceVersion: boundedName }) });
// Read-only refresh ONLY. Exact RV checks used by Load, continuations and all write gates are deliberately unchanged.
export function captureInspectionReference(input: unknown, original: InspectionReference, refresh: boolean): InspectionReference {
  const parsed = metadataVersion.safeParse(input);
  if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID');
  const reference = inspectionReferenceSchema.safeParse({ ...original, resourceVersion: refresh ? parsed.data.metadata.resourceVersion : original.resourceVersion });
  if (!reference.success) throw new BoundaryError('INVALID_INPUT');
  verifyResourceObject(input, reference.data.type, reference.data); // Includes original GVR/kind/name/namespace/UID; only RV may advance on explicit refresh.
  Object.freeze(reference.data.type); if ('definition' in reference.data) Object.freeze(reference.data.definition); return Object.freeze(reference.data);
}
