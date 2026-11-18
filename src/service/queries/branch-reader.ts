import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { branchReadRequestSchema, branchReadResponseSchema, referenceKey } from '../../shared/branch-protocol.ts';
import type { BranchReadResponse } from '../../shared/branch-protocol.ts';
import { groupHelmReleases } from '../../shared/helm-release-protocol.ts';
import { boundedName, containsControlCharacters, stableNodeId } from '../../shared/identity.ts';
import type { ResourceType } from '../../shared/identity.ts';
import { protocolVersion } from '../../shared/protocol.ts';
import { resourceDescriptors } from '../../shared/tree.ts';
import { resolveCustomResourceTypeInGroup } from './custom-resources.ts';
import type { createResourcePager } from './resource-pagination.ts';
import type { createResourceReader } from './resource-reader.ts';
import { createSealedCursor } from './sealed-cursor.ts';

const cursorSchema = z.object({ binding: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().nonnegative(), pages: z.number().int().min(1).max(1000),
  page: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('definitions'), continuation: z.string().min(1).max(8192).refine(value => !containsControlCharacters(value)), resourceVersion: boundedName }).strict(),
    z.object({ kind: z.literal('keys'), offset: z.number().int().min(100).max(1900).refine(value => value % 100 === 0), order: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ kind: z.literal('helm'), continuation: z.string().min(1).max(8192).refine(value => !containsControlCharacters(value)) }).strict(),
  ]) }).strict();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function withinBudget<T>(result: Promise<T>, code: 'CRD_LIST_BUDGET_EXCEEDED' | 'CRD_OBJECT_BUDGET_EXCEEDED' | 'CUSTOM_LIST_BUDGET_EXCEEDED'): Promise<T> {
  try { return await result; }
  catch (error) { if (error instanceof BoundaryError && error.code === 'BUDGET_EXCEEDED') throw new BoundaryError(code); throw error; }
}

// Shares the gateway's existing reader and pager: no extra CLI scheduler or result cache.
export function createBranchReader(reader: ReturnType<typeof createResourceReader>, pager: ReturnType<typeof createResourcePager>, clock = Date.now) {
  const codec = createSealedCursor('bp1', 'openchamber-kubernetes-branch-page-1');
  let closed = false;
  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new BoundaryError('STATE_UNAVAILABLE');
    return value;
  }
  return {
    async read(input: unknown, signal: AbortSignal): Promise<BranchReadResponse> {
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      const parsed = branchReadRequestSchema.safeParse(input);
      if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const value = parsed.data, { target } = value;
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      const binding = digest([target, value.kind, value.kind === 'children' ? referenceKey(value.parent)
        : value.kind === 'custom-resources' ? referenceKey(value.definition)
        : value.kind === 'helm-release-history' ? `${value.namespace}/${value.release}` : '']);
      let previous: z.infer<typeof cursorSchema> | undefined;
      if (value.cursor && (value.kind === 'custom-types' || value.kind === 'helm-releases' || value.kind === 'helm-release-history'
        || (value.kind === 'children' && ['secrets', 'configmaps'].includes(value.parent.resource)))) {
        const parsed = cursorSchema.safeParse(codec.open(value.cursor));
        if (!parsed.success || parsed.data.binding !== binding) throw new BoundaryError('STALE_TARGET');
        previous = parsed.data;
        if (now() >= previous.expiresAt) throw new BoundaryError('CONTINUATION_EXPIRED');
        if (previous.pages >= 1000) throw new BoundaryError('QUERY_LIMIT');
      }
      let expiresAt = previous?.expiresAt ?? now() + 60_000;
      const seal = (page: z.infer<typeof cursorSchema>['page']) => codec.seal({ binding, expiresAt, pages: (previous?.pages ?? 0) + 1, page });
      let result: unknown;
      if (value.kind === 'custom-types') {
        if (previous && previous.page.kind !== 'definitions') throw new BoundaryError('STALE_TARGET');
        const page = await withinBudget(reader.customDefinitions({ target, limit: 100, ...(previous?.page.kind === 'definitions'
          ? { continue: previous.page.continuation, resourceVersion: previous.page.resourceVersion } : {}) }, signal), 'CRD_LIST_BUDGET_EXCEEDED');
        result = { protocol: protocolVersion, target, kind: 'custom-types', resourceVersion: page.resourceVersion,
          nodes: page.folders.map(({ label, definition }) => ({ id: stableNodeId(target, 'custom-resource-definition', definition.name, definition.uid, definition.resourceVersion),
            type: 'folder', label, expandable: true, definition: { ...definition } })),
          nextCursor: page.continue ? seal({ kind: 'definitions', continuation: page.continue, resourceVersion: page.resourceVersion }) : null };
      } else if (value.kind === 'children') {
        if (previous && previous.page.kind !== 'keys') throw new BoundaryError('STALE_TARGET');
        const offset = previous?.page.kind === 'keys' ? previous.page.offset : 0;
        const parent = await reader.parent({ target, parent: value.parent, offset }, signal);
        let nodes: unknown, resourceVersion: string | null, nextCursor: string | null;
        if (parent.kind === 'config-keys') {
          if (previous?.page.kind === 'keys' && previous.page.order !== parent.order) throw new BoundaryError('STALE_TARGET');
          nodes = parent.nodes; resourceVersion = value.parent.resourceVersion;
          nextCursor = parent.nextOffset === null ? null : seal({ kind: 'keys', offset: parent.nextOffset, order: parent.order });
        } else if (parent.kind === 'pod-info') {
          if (value.cursor) throw new BoundaryError('INVALID_INPUT');
          nodes = parent.nodes; resourceVersion = value.parent.resourceVersion; nextCursor = null;
        } else {
          const descriptor = resourceDescriptors.pods;
          const { group, version, resource, kind, scope } = descriptor;
          const page = await pager.read({ query: { target, type: { group, version, resource, kind, scope }, limit: 100,
            namespaces: parent.kind === 'pods-on-node' ? 'all' : 'selected', filter: parent.kind === 'pods-on-node'
              ? { kind: 'node', name: value.parent.name } : { kind: 'selector', selector: parent.selector, source: 'workload' } }, binding,
            ...(value.cursor ? { cursor: value.cursor } : {}) }, signal);
          nodes = page.nodes.map(node => ({ ...node, resource: { ...node.resource } }));
          resourceVersion = page.kind === 'resources' ? page.resourceVersion : null;
          nextCursor = page.kind === 'resources' ? page.nextCursor : null;
          if (page.kind === 'resources') expiresAt = Math.min(expiresAt, page.expiresAt);
        }
        const after = await reader.parent({ target, parent: value.parent, offset }, signal);
        if (digest(after) !== digest(parent)) throw new BoundaryError('STALE_TARGET');
        result = { protocol: protocolVersion, target, kind: 'children', parent: value.parent, nodes, resourceVersion, nextCursor };
      } else if (value.kind === 'helm-releases') {
        if (previous && previous.page.kind !== 'helm') throw new BoundaryError('STALE_TARGET');
        const page = await reader.helmReleasesPage(target, signal, previous?.page.kind === 'helm' ? { continueToken: previous.page.continuation } : {});
        const grouped = groupHelmReleases(page.revisions);
        const partial = page.continueToken !== null;
        result = {
          protocol: protocolVersion, target, kind: 'helm-releases', resourceVersion: null, partial,
          nodes: grouped.releases.map(release => ({
            id: stableNodeId(target, 'helm-release', release.namespace, release.name),
            type: 'release', label: release.name, expandable: true,
            description: `r${release.currentRevision} · ${release.currentStatus}${partial ? ' (partial)' : ''}`,
            tooltip: partial ? `${release.name}: r${release.currentRevision} (${release.currentStatus}) — partial page` : `${release.name}: r${release.currentRevision} (${release.currentStatus})`,
            icon: release.currentStatus === 'failed' ? 'helm-failed' : 'helm-deployed',
            release, partial,
          })),
          nextCursor: page.continueToken ? seal({ kind: 'helm', continuation: page.continueToken }) : null,
        };
      } else if (value.kind === 'helm-release-history') {
        if (previous && previous.page.kind !== 'helm') throw new BoundaryError('STALE_TARGET');
        if (value.namespace !== target.namespace) throw new BoundaryError('STALE_TARGET');
        const page = await reader.helmReleasesPage(target, signal, {
          releaseName: value.release,
          ...(previous?.page.kind === 'helm' ? { continueToken: previous.page.continuation } : {}),
        });
        const partial = page.continueToken !== null;
        const sorted = [...page.revisions].sort((a, b) => b.revision - a.revision);
        result = {
          protocol: protocolVersion, target, kind: 'helm-release-history', resourceVersion: null, release: value.release, namespace: value.namespace, partial,
          nodes: sorted.map(rev => ({
            id: stableNodeId(target, 'helm-revision', rev.namespace, rev.name, String(rev.revision), rev.uid),
            type: 'revision', label: String(rev.revision), expandable: false,
            description: `${rev.status} (${rev.chartName} ${rev.chartVersion})${partial ? ' · partial' : ''}`,
            tooltip: `Chart: ${rev.chartName} ${rev.chartVersion}${rev.appVersion ? `\nApp version: ${rev.appVersion}` : ''}`,
            releaseName: rev.name, namespace: rev.namespace,
            revision: {
              revision: rev.revision, status: rev.status, chartName: rev.chartName, chartVersion: rev.chartVersion,
              ...(rev.appVersion !== undefined ? { appVersion: rev.appVersion } : {}),
              ...(rev.lastDeployed !== undefined ? { lastDeployed: rev.lastDeployed } : {}),
              uid: rev.uid, resourceVersion: rev.resourceVersion,
            },
            partial,
          })),
          nextCursor: page.continueToken ? seal({ kind: 'helm', continuation: page.continueToken }) : null,
        };
      } else {
        const definition = await withinBudget(reader.definition({ target, definition: value.definition }, signal), 'CRD_OBJECT_BUDGET_EXCEEDED');
        const group = await reader.discoverGroup({ target, group: definition.spec.group }, signal);
        const discoveries: ResourceType[] = [];
        let resolved: ReturnType<typeof resolveCustomResourceTypeInGroup> | undefined, queried = 0;
        for (const version of group.versions) {
          if (!definition.spec.versions.some(item => item.name === version && item.served)) continue;
          if (++queried > 8) throw new BoundaryError('QUERY_LIMIT'); // Not a silently truncated empty collection.
          discoveries.push(...await reader.discoverVersion({ target, group: group.group, version }, signal));
          if (discoveries.length > 10_000) throw new BoundaryError('BUDGET_EXCEEDED');
          try { resolved = resolveCustomResourceTypeInGroup(definition, group, discoveries); break; }
          catch (error) { if (!(error instanceof BoundaryError) || error.code !== 'NOT_FOUND') throw error; }
        }
        if (!resolved) throw new BoundaryError('NOT_FOUND');
        const page = await withinBudget(pager.read({ query: { target, type: resolved.type, listKind: resolved.listKind, customDefinition: resolved.crd, limit: 100 }, binding,
          ...(value.cursor ? { cursor: value.cursor } : {}) }, signal), 'CUSTOM_LIST_BUDGET_EXCEEDED');
        if (page.kind !== 'resources') throw new BoundaryError('STATE_UNAVAILABLE');
        expiresAt = Math.min(expiresAt, page.expiresAt);
        const after = await withinBudget(reader.definition({ target, definition: value.definition }, signal), 'CRD_OBJECT_BUDGET_EXCEEDED');
        if (digest(after) !== digest(definition)) throw new BoundaryError('STALE_TARGET');
        result = { protocol: protocolVersion, target, kind: 'custom-resources', definition: value.definition, resourceType: resolved.type,
          listKind: resolved.listKind, nodes: page.nodes.map(node => ({ ...node, resource: { ...node.resource } })), resourceVersion: page.resourceVersion, nextCursor: page.nextCursor };
      }
      if (closed) throw new BoundaryError('SERVICE_CLOSED');
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (now() >= expiresAt) throw new BoundaryError('CONTINUATION_EXPIRED');
      const response = branchReadResponseSchema.safeParse(result);
      if (!response.success) throw new BoundaryError('RESOURCE_INVALID');
      if (Buffer.byteLength(JSON.stringify(response.data)) > 480_000) throw new BoundaryError(value.kind === 'custom-types'
        ? 'CRD_LIST_BUDGET_EXCEEDED' : value.kind === 'custom-resources' ? 'CUSTOM_LIST_BUDGET_EXCEEDED' : 'BUDGET_EXCEEDED');
      return response.data;
    },
    dispose() { closed = true; codec.dispose(); },
  };
}
