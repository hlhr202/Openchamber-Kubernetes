import { BoundaryError } from '../../shared/errors.ts';
import { manifestComparisonReferenceSchema } from '../../shared/manifest-diff-protocol.ts';
import type { ManifestLocator, ManifestComparisonReference } from '../../shared/manifest-diff-protocol.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { boundedName } from '../../shared/identity.ts';
import { documentProperty, documentString, parseDocumentJson, renderDocumentJson } from '../../shared/document-json.ts';
import { documentBytes } from '../../shared/document-protocol.ts';
import { apiDiscoveryPath, projectDiscovery } from './resource-query.ts';
import { manifestComparisonPath } from '../../shared/manifest-diff-protocol.ts';
import { readResponseJson, readResponseText } from './bounded-response.ts';
import type { ResourceReadTransport } from './resource-reader.ts';
import { z } from 'zod';
export type ManifestComparison = { readonly kind: 'live'; readonly text: string; readonly reference: ManifestComparisonReference; readonly uid: string; readonly resourceVersion: string }
  | { readonly kind: 'missing'; readonly reference: ManifestComparisonReference } | { readonly kind: 'unresolved' };
export function resolveManifestComparison(discovery: unknown, locator: ManifestLocator, target: TargetIdentity): ManifestComparisonReference | undefined {
  if (!z.object({ groupVersion: z.literal(locator.group ? `${locator.group}/${locator.version}` : locator.version) }).safeParse(discovery).success) throw new BoundaryError('RESOURCE_INVALID');
  const types = projectDiscovery(discovery, ['get']);
  if (types.some(type => type.group !== locator.group || type.version !== locator.version)) throw new BoundaryError('RESOURCE_INVALID');
  const matches = types.filter(type => type.kind === locator.kind); if (matches.length !== 1) return undefined; const type = matches[0]; if (!type) return undefined;
  if (type.scope === 'cluster' && locator.namespace !== undefined) throw new BoundaryError('RESOURCE_INVALID');
  return manifestComparisonReferenceSchema.parse({ type, name: locator.name, ...(type.scope === 'namespace' ? { namespace: locator.namespace ?? target.namespace } : {}) });
}
export function projectManifestComparison(text: string, reference: ManifestComparisonReference, format: 'yaml' | 'json', expectedUid?: string): Extract<ManifestComparison, { kind: 'live' }> {
  const value = parseDocumentJson(text), metadata = documentProperty(value, 'metadata'), type = reference.type;
  if (value.kind !== 'object' || metadata?.kind !== 'object' || documentString(documentProperty(value, 'apiVersion')) !== (type.group ? `${type.group}/${type.version}` : type.version)
    || documentString(documentProperty(value, 'kind')) !== type.kind || documentString(documentProperty(metadata, 'name')) !== reference.name
    || (reference.namespace === undefined ? documentProperty(metadata, 'namespace') !== undefined : documentString(documentProperty(metadata, 'namespace')) !== reference.namespace)) throw new BoundaryError('STALE_TARGET');
  const uid = documentString(documentProperty(metadata, 'uid')), resourceVersion = documentString(documentProperty(metadata, 'resourceVersion'));
  if (!boundedName.safeParse(uid).success || !boundedName.safeParse(resourceVersion).success || !uid || !resourceVersion || expectedUid !== undefined && uid !== expectedUid) throw new BoundaryError('STALE_TARGET');
  const projected = { ...value, entries: value.entries.map(([key, node]) => [key, key === 'metadata' ? { ...metadata, entries: metadata.entries.filter(([key]) => key !== 'managedFields') } : node] as const) };
  return { kind: 'live', reference, uid, resourceVersion, text: renderDocumentJson(projected, format, documentBytes) };
}
// Fresh exact GVK discovery and GET-only object lookup. It does not authorize Load/Delete/Watch or any writer.
export async function readManifestComparison(target: TargetIdentity, locator: ManifestLocator, format: 'yaml' | 'json', expectedUid: string | undefined, signal: AbortSignal, read: ResourceReadTransport, verify: () => Promise<void>): Promise<ManifestComparison> {
  await verify(); const path = apiDiscoveryPath(locator.group, locator.version);
  const discover = async () => readResponseJson(await read({ method: 'GET', purpose: 'api-version', path, query: {}, maximumBytes: 2_000_000, target }, signal), signal);
  const reference = resolveManifestComparison(await discover(), locator, target); if (!reference) { await verify(); return { kind: 'unresolved' }; }
  let result: ManifestComparison;
  try {
    const text = await readResponseText(await read({ method: 'GET', purpose: 'manifest-diff', path: manifestComparisonPath(reference), query: {}, maximumBytes: 2_000_000, target, comparison: reference }, signal), signal);
    result = projectManifestComparison(text, reference, format, expectedUid);
  } catch (error) { if (!(error instanceof BoundaryError) || error.code !== 'NOT_FOUND') throw error; result = { kind: 'missing', reference }; }
  const after = resolveManifestComparison(await discover(), locator, target);
  if (!after || JSON.stringify(after) !== JSON.stringify(reference)) throw new BoundaryError('STALE_TARGET'); await verify(); return result;
}
