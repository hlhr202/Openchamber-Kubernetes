import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import { branchReadRequestSchema } from '../shared/branch-protocol.ts';
import { readConfigSelection } from '../shared/configuration.ts';
import { resourceReadRequestSchema, resourceRequestBytes } from '../shared/resource-protocol.ts';
import { protocolVersion } from '../shared/protocol.ts';
import { localTreeEntries, readTreeEntry, resourceTreeEntry } from '../shared/tree-entries.ts';
import type { TreePage, TreeQuery } from '../shared/tree-entries.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { validateBranchReadPage } from './branch-client.ts';
import type { BranchPageProof } from './branch-client.ts';
import { validateResourceReadPage } from './resource-client.ts';

export type TreeTransport = (request: { method: 'POST'; path: string; query?: Readonly<Record<string, string>>; body: string }) => Promise<{ status: number; body: string }>;
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();

// No SDK, globals, CLI, credentials, or network on construction/import. The caller owns delivery cancellation.
export function createTreeSource(request: TreeTransport, options: { readonly helmTree?: boolean } = {}) {
  return async (query: TreeQuery, selection: ConfigSelection, signal: AbortSignal, cursor?: string, previous?: BranchPageProof, priority: 'manual' | 'background' = 'manual'): Promise<TreePage> => {
    if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
    const local = localTreeEntries(query, options.helmTree !== undefined ? { helmReleases: options.helmTree } : {});
    if (local) return { entries: local, cursor: null, proof: { resourceVersion: null } };
    if (query.kind === 'helm-dependency') throw new BoundaryError('STATE_UNAVAILABLE'); // Explicit unmet M6 dependency, not empty resources.
    const base = { protocol: protocolVersion, selection: readConfigSelection(selection), target: query.target };
    const binding = query.kind === 'resources' ? resourceReadRequestSchema.parse({ ...base, resource: query.resource }) : branchReadRequestSchema.parse({ ...base, ...query });
    const body = JSON.stringify({ ...binding, ...(cursor ? { cursor } : {}) });
    if (new TextEncoder().encode(body).byteLength > resourceRequestBytes) throw new BoundaryError('BUDGET_EXCEEDED');
    const response = await request({
      method: 'POST',
      path: query.kind === 'resources' ? '/v2/resources/read' : '/v2/tree/read',
      ...(priority === 'background' ? { query: { priority: 'background' } } : {}),
      body,
    });
    if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); // SDK proxy abort is not promised.
    if (new TextEncoder().encode(response.body).byteLength > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
    let value: unknown;
    try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
    if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
    if (query.kind === 'resources') {
      const page = validateResourceReadPage(value, resourceReadRequestSchema.parse(binding), cursor, previous);
      return { entries: page.nodes.map(node => resourceTreeEntry(node, query.target)), cursor: page.nextCursor, proof: { resourceVersion: page.resourceVersion } };
    }
    const page = validateBranchReadPage(value, branchReadRequestSchema.parse(binding), cursor, previous);
    if (page.kind === 'helm-releases') {
      return {
        entries: page.nodes.map(node => readTreeEntry({
          node,
          query: { target: query.target, kind: 'helm-release-history', release: node.release.name, namespace: node.release.namespace },
        })),
        cursor: page.nextCursor,
        proof: { resourceVersion: null },
      };
    }
    if (page.kind === 'helm-release-history') {
      return {
        entries: page.nodes.map(node => readTreeEntry({ node, query: null })),
        cursor: page.nextCursor,
        proof: { resourceVersion: null },
      };
    }
    return { entries: page.nodes.map(node => node.type === 'folder' ? readTreeEntry({ node: { id: node.id, type: node.type, label: node.label, expandable: true }, query: { target: query.target, kind: 'custom-resources', definition: node.definition } })
      : node.type === 'resource' ? resourceTreeEntry(node, query.target) : readTreeEntry({ node, query: null })), cursor: page.nextCursor,
      proof: { resourceVersion: page.resourceVersion, ...(page.kind === 'custom-resources' ? { resourceType: page.resourceType, listKind: page.listKind } : {}) } };
  };
}
