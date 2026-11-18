import { BoundaryError } from '../../shared/errors.ts';
import type { WatchSource } from '../../shared/watch-protocol.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import type { ResourceReadRequest, ResourceReadTransport } from './resource-reader.ts';
import { readResponseText } from './bounded-response.ts';
import { customDocumentProof } from './custom-document.ts';
import { projectCustomResourceDefinition } from './custom-resources.ts';
import { apiDiscoveryPath, projectDiscovery } from './resource-query.ts';
import { crdType, resourceObjectPath, verifyResourceObject } from './parent-resource.ts';

// Called only inside the original finite slot. A separate cumulative proof budget never resets between watch windows/recovery.
export async function readCustomWatchProof(source: WatchSource, signal: AbortSignal, read: ResourceReadTransport,
  verify: (target: TargetIdentity, signal: AbortSignal) => Promise<void>, budget: { bytes: number; reads: number }, initial: boolean): Promise<string> {
  const custom = source.custom; if (!custom || source.resource !== 'custom-resource') throw new BoundaryError('INVALID_INPUT');
  const get = async (purpose: ResourceReadRequest['purpose'], path: string, reference?: ResourceReadRequest['customDocument']) => {
    await verify(source.target, signal);
    if (++budget.reads > 256 || budget.bytes >= 8_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
    const request: ResourceReadRequest = { method: 'GET', target: source.target, purpose, path, maximumBytes: 2_000_000, query: {}, ...(reference ? { customDocument: reference } : {}) };
    const text = await readResponseText(await read(request, signal), signal, Math.min(2_000_000, 8_000_000 - budget.bytes));
    budget.bytes += Buffer.byteLength(text); await verify(source.target, signal);
    try { return JSON.parse(text) as unknown; } catch { throw new BoundaryError('RESOURCE_INVALID'); }
  };
  const proof = async () => {
    const definition = await get('resource-object', resourceObjectPath(crdType, custom.definition.name));
    const discovery = await get('api-version', apiDiscoveryPath(custom.type.group, custom.type.version));
    const route = customDocumentProof(definition, discovery, custom);
    if (!projectDiscovery(discovery, ['list', 'watch']).some(type => type.group === custom.type.group && type.version === custom.type.version && type.resource === custom.type.resource)) throw new BoundaryError('STALE_TARGET');
    const names = projectCustomResourceDefinition(definition).spec.names;
    if ((names.listKind ?? `${custom.type.kind}List`) !== custom.listKind) throw new BoundaryError('STALE_TARGET'); return route;
  };
  const original = await proof();
  if (initial && source.object) {
    const namespace = custom.type.scope === 'namespace' ? source.target.namespace : undefined;
    const reference = { type: custom.type, definition: custom.definition, ...source.object, resourceVersion: source.resourceVersion,
      ...(namespace ? { namespace } : {}) };
    verifyResourceObject(await get('custom-document', resourceObjectPath(custom.type, reference.name, namespace), reference), custom.type, reference);
    if (await proof() !== original) throw new BoundaryError('STALE_TARGET');
  }
  return original;
}
