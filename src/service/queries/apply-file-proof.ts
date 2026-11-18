// READ ONLY. Per-document locator resolution + existence probe for the approved D-02 ApplyFile
// chain. No writer, grant or operation dependency; mirrors the manifest create proof discipline.
import { BoundaryError } from '../../shared/errors.ts';
import { manifestComparisonPath, manifestLocatorSchema } from '../../shared/manifest-diff-protocol.ts';
import type { ManifestLocator, ManifestComparisonReference } from '../../shared/manifest-diff-protocol.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import type { ResourceReadTransport } from './resource-reader.ts';
import { resolveManifestComparison } from './manifest-comparison.ts';
import { apiDiscoveryPath, projectDiscovery } from './resource-query.ts';
import { readResponseJson } from './bounded-response.ts';
export type ApplyFileDocumentProbe = { readonly reference: ManifestComparisonReference; readonly exists: boolean };
export async function readApplyFileDocumentProbe(target: TargetIdentity, locator: ManifestLocator, signal: AbortSignal, read: ResourceReadTransport, verify: () => Promise<void>): Promise<ApplyFileDocumentProbe> {
  const parsed = manifestLocatorSchema.safeParse(locator); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); locator = parsed.data;
  if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
  await verify();
  const discover = async () => {
    const value = await readResponseJson(await read({ method: 'GET', purpose: 'api-version', path: apiDiscoveryPath(locator.group, locator.version), query: {}, maximumBytes: 2_000_000, target }, signal), signal);
    const reference = resolveManifestComparison(value, locator, target);
    // Apply needs get+patch for an existing object and get+create for a missing one; require both verbs.
    const candidates = projectDiscovery(value, ['get']);
    if (!reference || !candidates.some(type => JSON.stringify(type) === JSON.stringify(reference.type))) throw new BoundaryError('RESOURCE_INVALID');
    return reference;
  };
  const reference = await discover();
  const response = await read({ method: 'GET', purpose: 'manifest-create-proof', path: manifestComparisonPath(reference), query: {}, maximumBytes: 2_000_000, target, createReference: reference }, signal);
  const status = response.status;
  let exists: boolean;
  if (status === 200) { try { await response.close(); } catch { throw new BoundaryError('STATE_UNAVAILABLE'); } exists = true; } // Existing object's body is neither iterated nor exposed here.
  else if (status === 404) { try { await response.close(); } catch { throw new BoundaryError('STATE_UNAVAILABLE'); } exists = false; }
  else { try { await response.close(); } catch { /* upstream error bodies are never parsed */ } throw new BoundaryError('STATE_UNAVAILABLE'); }
  const after = await discover(); if (JSON.stringify(reference) !== JSON.stringify(after)) throw new BoundaryError('STALE_TARGET');
  await verify();
  return { reference, exists };
}
