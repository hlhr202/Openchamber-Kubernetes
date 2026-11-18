import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { apiGroup, apiVersion, boundedName, containsControlCharacters, namespaceName } from '../../shared/identity.ts';
import type { ResourceType } from '../../shared/identity.ts';
import type { NamespaceDeleteReference } from '../../shared/namespace-inventory.ts';
import { apiDiscoveryPath, projectDiscovery } from './resource-query.ts';

const groupVersion = z.object({ groupVersion: boundedName, version: apiVersion });
const groupList = z.object({ apiVersion: z.literal('v1').optional(), kind: z.literal('APIGroupList'), groups: z.array(z.object({ name: apiGroup.refine(value => !!value),
  preferredVersion: groupVersion, versions: z.array(groupVersion).min(1).max(8) })).max(32) });
const list = z.object({ apiVersion: boundedName, kind: boundedName, metadata: z.object({ resourceVersion: boundedName, continue: z.string().max(8192).refine(value => !containsControlCharacters(value)).optional() }),
  items: z.array(z.object({ apiVersion: boundedName.optional(), kind: boundedName.optional(), metadata: z.object({ namespace: namespaceName, name: boundedName, uid: boundedName, resourceVersion: boundedName }) })).max(100) });
export const inventoryDigest = (key: Uint8Array, values: unknown) => createHmac('sha256', key).update(JSON.stringify(values)).digest('hex');

// Independent GET-only collector. No operations, confirmations, executors, filesystem or CLI.
export async function collectNamespaceInventory(reference: NamespaceDeleteReference, key: Uint8Array,
  get: (path: string, query?: Readonly<Record<string, string>>) => Promise<unknown>) {
  const groups = groupList.safeParse(await get('/apis')); if (!groups.success) throw new BoundaryError('RESOURCE_INVALID');
  if (new Set(groups.data.groups.map(value => value.name)).size !== groups.data.groups.length) throw new BoundaryError('RESOURCE_INVALID');
  const versions = [{ group: '', version: 'v1' }, ...groups.data.groups.flatMap(value => {
    if (new Set(value.versions.map(item => item.version)).size !== value.versions.length || value.versions.some(item => item.groupVersion !== `${value.name}/${item.version}`)
      || value.preferredVersion.groupVersion !== `${value.name}/${value.preferredVersion.version}` || !value.versions.some(item => item.version === value.preferredVersion.version)) throw new BoundaryError('RESOURCE_INVALID');
    return [value.preferredVersion, ...value.versions.filter(item => item.version !== value.preferredVersion.version)].map(item => ({ group: value.name, version: item.version }));
  })];
  const chosen = new Map<string, ResourceType>();
  for (const version of versions) {
    const value = await get(apiDiscoveryPath(version.group, version.version)), found = projectDiscovery(value);
    if (found.some(type => type.group !== version.group || type.version !== version.version)) throw new BoundaryError('RESOURCE_INVALID');
    // Check even an empty discovery document's groupVersion; no fake empty success.
    if (!z.object({ groupVersion: z.literal(version.group ? `${version.group}/${version.version}` : version.version) }).safeParse(value).success) throw new BoundaryError('RESOURCE_INVALID');
    for (const type of found.filter(type => type.scope === 'namespace')) {
      const id = JSON.stringify([type.group, type.resource]), previous = chosen.get(id);
      if (previous && previous.kind !== type.kind) throw new BoundaryError('RESOURCE_INVALID');
      if (!previous) chosen.set(id, type); // Preferred first; retain fallback-only resources from other advertised versions.
    }
    if (chosen.size > 128) throw new BoundaryError('BUDGET_EXCEEDED');
  }
  const types = [...chosen.values()];
  if (!types.length) throw new BoundaryError('RESOURCE_INVALID');
  types.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'));
  let count = 0, pages = 0;
  const facts: string[] = [];
  for (const type of types) {
    let continuation = '', rv: string | undefined; const seen = new Set<string>(), tokens = new Set<string>();
    do {
      if (++pages > 128) throw new BoundaryError('BUDGET_EXCEEDED');
      const page = list.safeParse(await get(`${apiDiscoveryPath(type.group, type.version)}/namespaces/${reference.name}/${type.resource}`, { limit: '100', ...(continuation ? { continue: continuation } : {}) }));
      if (!page.success || page.data.apiVersion !== (type.group ? `${type.group}/${type.version}` : type.version)) throw new BoundaryError('RESOURCE_INVALID');
      if (rv && rv !== page.data.metadata.resourceVersion) throw new BoundaryError('STALE_TARGET'); rv = page.data.metadata.resourceVersion;
      for (const item of page.data.items) {
        if ((item.apiVersion && item.apiVersion !== page.data.apiVersion) || (item.kind && item.kind !== type.kind)) throw new BoundaryError('RESOURCE_INVALID');
        if (item.metadata.namespace !== reference.name || seen.has(item.metadata.uid)) throw new BoundaryError('STALE_TARGET'); seen.add(item.metadata.uid);
        facts.push(JSON.stringify([type.group, type.version, type.resource, rv, item.metadata.name, item.metadata.uid, item.metadata.resourceVersion]));
        if (++count > 10_000) throw new BoundaryError('BUDGET_EXCEEDED');
      }
      continuation = page.data.metadata.continue ?? '';
      if (continuation && tokens.has(continuation)) throw new BoundaryError('RESOURCE_INVALID'); if (continuation) tokens.add(continuation);
    } while (continuation);
    facts.push(JSON.stringify([type.group, type.version, type.resource, rv]));
  }
  facts.sort();
  return { count, types: types.length, digest: inventoryDigest(key, [reference, types, facts]) };
}
