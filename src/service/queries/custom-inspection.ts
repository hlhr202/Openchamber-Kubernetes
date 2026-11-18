import { BoundaryError } from '../../shared/errors.ts';
import { inspectionBytes } from '../../shared/inspection-protocol.ts';
import type { InspectionReference } from '../../shared/inspection-protocol.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { readResponseText } from './bounded-response.ts';
import { planLoadDocument, customDocumentProof } from './custom-document.ts';
import { captureInspectionReference } from './inspection-reference.ts';
import type { ResourceReadTransport, ResourceReadRequest } from './resource-reader.ts';
import { verifyResourceObject } from './parent-resource.ts';

// Runs INSIDE one existing finite-reader slot. No scheduler recursion, operation, cache or printer replay.
export async function readCustomInspection(target: TargetIdentity, reference: InspectionReference, signal: AbortSignal,
  read: ResourceReadTransport, verify: (target: TargetIdentity, signal: AbortSignal) => Promise<void>, mode?: 'wide' | 'describe', refresh = false) {
  const plan = planLoadDocument(reference, target);
  if (!plan.custom) throw new BoundaryError('INVALID_INPUT');
  const custom = plan.custom;
  let reads = 0, bytes = 0;
  const maximumReads = mode ? 7 : 5, maximumBytes = mode ? 12_000_000 : 8_000_000;
  const get = async (purpose: ResourceReadRequest['purpose'], path: string, current: InspectionReference = plan.reference) => {
    await verify(target, signal);
    if (++reads > maximumReads || bytes >= maximumBytes) throw new BoundaryError('BUDGET_EXCEEDED');
    const printer = purpose === 'custom-wide' || purpose === 'custom-describe';
    const request: ResourceReadRequest = { method: 'GET', target, purpose, path, query: {}, maximumBytes: 2_000_000,
      ...(printer ? { customInspection: current } : purpose === 'custom-document' ? { customDocument: current } : {}) };
    const text = await readResponseText(await read(request, signal), signal, Math.min(printer ? inspectionBytes : 2_000_000, maximumBytes - bytes));
    bytes += Buffer.byteLength(text); await verify(target, signal); return text;
  };
  const json = (text: string): unknown => { try { return JSON.parse(text) as unknown; } catch { throw new BoundaryError('RESOURCE_INVALID'); } };
  const proof = async () => customDocumentProof(json(await get('resource-object', custom.definitionPath)), json(await get('api-version', custom.discoveryPath)), plan.reference);
  const before = await proof(), current = captureInspectionReference(json(await get('custom-document', plan.path)), plan.reference, !!mode && refresh);
  let text = '';
  if (mode) {
    text = await get(mode === 'wide' ? 'custom-wide' : 'custom-describe', plan.path, current);
    verifyResourceObject(json(await get('custom-document', plan.path, current)), current.type, current);
  }
  if (await proof() !== before) throw new BoundaryError('STALE_TARGET');
  await verify(target, signal); return { text, reference: current };
}
