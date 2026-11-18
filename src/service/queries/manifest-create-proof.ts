// Independent GET-only routing/nonexistence proof. No grant, writer, prepare or operation imports.
import { BoundaryError } from '../../shared/errors.ts';
import { manifestComparisonPath, manifestLocatorSchema } from '../../shared/manifest-diff-protocol.ts';
import type { ManifestLocator, ManifestComparisonReference } from '../../shared/manifest-diff-protocol.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import type { ResourceReadTransport } from './resource-reader.ts';
import { resolveManifestComparison } from './manifest-comparison.ts';
import { apiDiscoveryPath, projectDiscovery } from './resource-query.ts';
import { readResponseJson, readResponseText } from './bounded-response.ts';
export async function readManifestCreateProof(target: TargetIdentity, locator: ManifestLocator, signal: AbortSignal, read: ResourceReadTransport, verify: () => Promise<void>): Promise<ManifestComparisonReference> {
  const parsed = manifestLocatorSchema.safeParse(locator); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); locator = parsed.data;
  if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
  await verify();
  const discover = async () => {
    const value = await readResponseJson(await read({ method: 'GET', purpose: 'api-version', path: apiDiscoveryPath(locator.group, locator.version), query: {}, maximumBytes: 2_000_000, target }, signal), signal);
    const reference = resolveManifestComparison(value, locator, target);
    const candidates = projectDiscovery(value, ['get', 'create']);
    if (!reference || !candidates.some(type => JSON.stringify(type) === JSON.stringify(reference.type))) throw new BoundaryError('RESOURCE_INVALID');
    return reference;
  };
  const reference = await discover();
  const response = await read({ method: 'GET', purpose: 'manifest-create-proof', path: manifestComparisonPath(reference), query: {}, maximumBytes: 2_000_000, target, createReference: reference }, signal);
  if (response.status === 200) {
    try { await response.close(); } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
    throw new BoundaryError('CONFLICT'); // Existing object's body is neither iterated nor exposed.
  }
  try { await readResponseText(response, signal); throw new BoundaryError('RESOURCE_INVALID'); }
  catch (error) { if (!(error instanceof BoundaryError) || error.code !== 'NOT_FOUND') throw error; }
  const after = await discover(); if (JSON.stringify(reference) !== JSON.stringify(after)) throw new BoundaryError('STALE_TARGET'); await verify(); return reference;
}
