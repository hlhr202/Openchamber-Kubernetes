// READ ONLY. Independent fresh CRD/discovery/instance proof; no writer, grant or operation dependency.
import { BoundaryError } from '../../shared/errors.ts';
import { customDocumentReferenceSchema } from '../../shared/document-protocol.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { planLoadDocument } from './custom-document.ts';
import { projectCustomResourceDefinition } from './custom-resources.ts';
import { projectDiscovery } from './resource-query.ts';
import { readResponseJson, readResponseText } from './bounded-response.ts';
import { projectManifestComparison } from './manifest-comparison.ts';
import type { ResourceReadTransport } from './resource-reader.ts';
export type ManifestApplySnapshot = { readonly reference: ReturnType<typeof customDocumentReferenceSchema.parse>; readonly text: string } | { readonly reference: ReturnType<typeof customDocumentReferenceSchema.parse>; readonly missing: true };
export async function readManifestApplySnapshot(target: TargetIdentity, input: unknown, signal: AbortSignal, read: ResourceReadTransport, verify: () => Promise<void>, expect: 'live'): Promise<Extract<ManifestApplySnapshot, { text: string }>>;
export async function readManifestApplySnapshot(target: TargetIdentity, input: unknown, signal: AbortSignal, read: ResourceReadTransport, verify: () => Promise<void>, expect: 'missing'): Promise<Extract<ManifestApplySnapshot, { missing: true }>>;
export async function readManifestApplySnapshot(target: TargetIdentity, input: unknown, signal: AbortSignal, read: ResourceReadTransport, verify: () => Promise<void>, expect: 'live' | 'missing'): Promise<ManifestApplySnapshot>;
export async function readManifestApplySnapshot(target: TargetIdentity, input: unknown, signal: AbortSignal, read: ResourceReadTransport, verify: () => Promise<void>, expect: 'live' | 'missing'): Promise<ManifestApplySnapshot> {
  const parsed = customDocumentReferenceSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const reference = parsed.data;
  const plan = planLoadDocument(reference, target); if (!plan.custom) throw new BoundaryError('INVALID_INPUT');
  const get = async (path: string, purpose: 'resource-object' | 'api-version') => readResponseJson(await read({ method: 'GET', purpose, target, path, query: {}, maximumBytes: 2_000_000 }, signal), signal);
  const proof = (definition: unknown, discovery: unknown) => {
    const value = projectCustomResourceDefinition(definition), type = reference.type;
    if (value.metadata.name !== reference.definition.name || value.metadata.uid !== reference.definition.uid || value.metadata.resourceVersion !== reference.definition.resourceVersion
      || value.spec.group !== type.group || value.spec.names.plural !== type.resource || value.spec.names.kind !== type.kind
      || (value.spec.scope === 'Namespaced' ? 'namespace' : 'cluster') !== type.scope || !value.spec.versions.some(version => version.name === type.version && version.served)) throw new BoundaryError('STALE_TARGET');
    const matches = projectDiscovery(discovery, expect === 'missing' ? ['get', 'create'] : ['get', 'patch']).filter(type => type.group === reference.type.group && type.version === reference.type.version && type.resource === reference.type.resource);
    const found = matches[0];
    if (matches.length !== 1 || !found || (['group', 'version', 'resource', 'kind', 'scope'] as const).some(key => found[key] !== reference.type[key])) throw new BoundaryError('RESOURCE_INVALID'); return JSON.stringify(value);
  };
  await verify(); const definition = await get(plan.custom.definitionPath, 'resource-object'), before = proof(definition, await get(plan.custom.discoveryPath, 'api-version'));
  let text: string | undefined;
  if (expect === 'missing') {
    // Only a fresh 404 proves absence. A fresh 200 means the object reappeared and voids the old pinned-RV intent.
    try { await readResponseText(await read({ method: 'GET', purpose: 'custom-document', target, path: plan.path, query: {}, maximumBytes: 2_000_000, customDocument: reference }, signal), signal); throw new BoundaryError('CONFLICT'); }
    catch (error) { if (!(error instanceof BoundaryError) || error.code !== 'NOT_FOUND') throw error; }
  } else {
    const body = await readResponseText(await read({ method: 'GET', purpose: 'custom-document', target, path: plan.path, query: {}, maximumBytes: 2_000_000, customDocument: reference }, signal), signal);
    const value = projectManifestComparison(body, reference, 'json', reference.uid);
    if (value.resourceVersion !== reference.resourceVersion) throw new BoundaryError('CONFLICT');
    text = value.text;
  }
  const discovery = await get(plan.custom.discoveryPath, 'api-version');
  if (proof(await get(plan.custom.definitionPath, 'resource-object'), discovery) !== before) throw new BoundaryError('STALE_TARGET');
  await verify(); return expect === 'missing' ? { reference, missing: true as const } : { reference, text: text as string };
}