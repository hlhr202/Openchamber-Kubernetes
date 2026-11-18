import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { branchReadRequestSchema, branchReadResponseSchema, referenceKey } from '../shared/branch-protocol.ts';
import type { BranchReadRequest, BranchReadResponse, DefinitionReference } from '../shared/branch-protocol.ts';
import { sameTarget, stableNodeId } from '../shared/identity.ts';
import type { ResourceType, TargetIdentity } from '../shared/identity.ts';
import { resourceDescriptors } from '../shared/tree.ts';
import { resourceRequestBytes } from '../shared/resource-protocol.ts';
import type { resourceNodeSchema } from '../shared/resource-protocol.ts';

export type BranchState = { readonly phase: 'idle' | 'loading' | 'ready' | 'error'; readonly stale: boolean; readonly page?: BranchReadResponse; readonly error?: ErrorCode };
const errorSchema = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
type Transport = (request: { method: 'POST'; path: string; body: string }) => Promise<{ status: number; body: string }>;
function resourceNode(node: z.infer<typeof resourceNodeSchema>, target: TargetIdentity, type: ResourceType, allNamespaces = false) {
  const identity = node.resource;
  if (identity.group !== type.group || identity.version !== type.version || identity.resource !== type.resource || identity.kind !== type.kind || identity.scope !== type.scope
    || (identity.scope === 'namespace' ? !identity.namespace || (!allNamespaces && identity.namespace !== target.namespace) : identity.namespace !== undefined)
    || node.id !== stableNodeId(target, identity.group, identity.version, identity.resource, identity.namespace ?? '', identity.name, identity.uid ?? '')) throw new BoundaryError('STALE_TARGET');
  const descriptor = Object.values(resourceDescriptors).find(item => item.group === type.group && item.version === type.version && item.resource === type.resource && item.kind === type.kind && item.scope === type.scope);
  const children = descriptor?.children ?? 'none';
  if (node.label !== identity.name || node.children !== children || node.expandable !== (children !== 'none')
    || (node.icon && !(type.group === '' && type.resource === 'pods' && type.kind === 'Pod'))) throw new BoundaryError('STATE_UNAVAILABLE');
}

function verifyPage(page: BranchReadResponse, binding: BranchReadRequest): void {
  if (!sameTarget(page.target, binding.target) || page.kind !== binding.kind) throw new BoundaryError('STALE_TARGET');
  if (new Set(page.nodes.map(node => node.id)).size !== page.nodes.length) throw new BoundaryError('STATE_UNAVAILABLE');
  if (page.kind === 'custom-types' && binding.kind === 'custom-types') {
    for (const node of page.nodes) {
      if (node.label !== node.definition.name.split('.')[0] || node.id !== stableNodeId(binding.target, 'custom-resource-definition', node.definition.name, node.definition.uid, node.definition.resourceVersion)) throw new BoundaryError('STALE_TARGET');
    }
  } else if (page.kind === 'custom-resources' && binding.kind === 'custom-resources') {
    if (referenceKey(page.definition) !== referenceKey(binding.definition) || `${page.resourceType.resource}.${page.resourceType.group}` !== binding.definition.name) throw new BoundaryError('STALE_TARGET');
    for (const node of page.nodes) resourceNode(node, binding.target, page.resourceType);
  } else if (page.kind === 'children' && binding.kind === 'children') {
    if (referenceKey(page.parent) !== referenceKey(binding.parent)) throw new BoundaryError('STALE_TARGET');
    const descriptor = resourceDescriptors[binding.parent.resource], parent = binding.parent;
    const id = stableNodeId(binding.target, descriptor.group, descriptor.version, descriptor.resource, parent.namespace ?? '', parent.name, parent.uid);
    if (descriptor.children === 'config-keys' || descriptor.children === 'pod-info') {
      if (page.resourceVersion !== parent.resourceVersion || (descriptor.children === 'pod-info' && (page.nextCursor || page.nodes.length > 2))) throw new BoundaryError('STALE_TARGET');
      for (const node of page.nodes) {
        if (descriptor.children === 'config-keys') {
          if (node.type !== 'config-key') throw new BoundaryError('STATE_UNAVAILABLE');
          const expected = { group: descriptor.group, version: descriptor.version, resource: descriptor.resource, kind: descriptor.kind, scope: descriptor.scope,
            name: parent.name, namespace: parent.namespace, uid: parent.uid, resourceVersion: parent.resourceVersion };
          if (Object.keys(expected).some(key => Reflect.get(node.resource, key) !== Reflect.get(expected, key)) || node.label !== node.key || node.id !== JSON.stringify([id, node.key])) throw new BoundaryError('STALE_TARGET');
        } else {
          if (node.type !== 'info' && node.type !== 'message') throw new BoundaryError('STATE_UNAVAILABLE');
          if (node.type === 'message' ? node.id !== `${id}:status-unavailable` || node.label !== 'STATE_UNAVAILABLE' || page.nodes.length !== 1
            : ![`${id}:status`, `${id}:ip`].includes(node.id)) throw new BoundaryError('STATE_UNAVAILABLE');
        }
      }
    } else {
      if (page.resourceVersion === null && (descriptor.children !== 'selected-pods' || page.nodes.length || page.nextCursor)) throw new BoundaryError('STATE_UNAVAILABLE');
      for (const node of page.nodes) {
        if (node.type !== 'resource') throw new BoundaryError('STATE_UNAVAILABLE');
        resourceNode(node, binding.target, resourceDescriptors.pods, descriptor.children === 'pods-on-node');
      }
    }
  } else if (page.kind === 'helm-releases' && binding.kind === 'helm-releases') {
    const partial = page.nextCursor !== null;
    if (page.partial !== partial) throw new BoundaryError('STATE_UNAVAILABLE');
    for (const node of page.nodes) {
      if (node.release.namespace !== binding.target.namespace || node.label !== node.release.name || node.partial !== partial
        || node.id !== stableNodeId(binding.target, 'helm-release', node.release.namespace, node.release.name)) throw new BoundaryError('STALE_TARGET');
    }
  } else if (page.kind === 'helm-release-history' && binding.kind === 'helm-release-history') {
    const partial = page.nextCursor !== null;
    if (page.partial !== partial || page.release !== binding.release || page.namespace !== binding.namespace) throw new BoundaryError('STALE_TARGET');
    for (const node of page.nodes) {
      if (node.releaseName !== binding.release || node.namespace !== binding.namespace || node.partial !== partial
        || node.id !== stableNodeId(binding.target, 'helm-revision', node.namespace, node.releaseName, String(node.revision.revision), node.revision.uid)) throw new BoundaryError('STALE_TARGET');
    }
  }
}

export type BranchPageProof = { readonly resourceVersion: string | null; readonly resourceType?: ResourceType; readonly listKind?: string };
export function validateBranchReadPage(value: unknown, binding: BranchReadRequest, cursor?: string, previous?: BranchPageProof): BranchReadResponse {
  const parsed = branchReadResponseSchema.safeParse(value);
  if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
  const page = parsed.data;
  verifyPage(page, binding);
  const pageRv = 'resourceVersion' in page ? page.resourceVersion : null;
  if (cursor && ((page.kind !== 'helm-releases' && page.kind !== 'helm-release-history' && pageRv !== previous?.resourceVersion) || page.nextCursor === cursor)) throw new BoundaryError('STALE_TARGET');
  if (cursor && page.kind === 'custom-resources'
    && (JSON.stringify(page.resourceType) !== JSON.stringify(previous?.resourceType) || page.listKind !== previous?.listKind)) throw new BoundaryError('STALE_TARGET');
  return page;
}

export class BranchClient {
  readonly #request: Transport;
  readonly #show: (state: BranchState) => void;
  #binding: BranchReadRequest | undefined;
  #page: BranchReadResponse | undefined;
  #revision = 0;
  #phase: BranchState['phase'] = 'idle';
  #stale = false;
  #disposed = false;
  constructor(request: Transport, show: (state: BranchState) => void) { this.#request = request; this.#show = show; }
  read(input: unknown): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const parsed = branchReadRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.cursor !== undefined) { this.reset(); this.#phase = 'error'; this.#show({ phase: 'error', stale: false, error: 'INVALID_INPUT' }); return Promise.resolve(); }
    if (JSON.stringify(parsed.data) !== JSON.stringify(this.#binding)) this.#page = undefined;
    this.#binding = parsed.data;
    return this.#load();
  }
  next(): Promise<void> { return this.#phase === 'ready' && !this.#stale && this.#page?.nextCursor ? this.#load(this.#page.nextCursor) : Promise.resolve(); }
  async #load(cursor?: string): Promise<void> {
    if (this.#disposed || !this.#binding) return;
    const binding = this.#binding, previous = this.#page, revision = ++this.#revision;
    const current = () => !this.#disposed && this.#revision === revision;
    this.#phase = 'loading'; this.#show({ phase: 'loading', stale: !!previous, ...(previous ? { page: previous } : {}) });
    try {
      const body = JSON.stringify({ ...binding, ...(cursor ? { cursor } : {}) });
      if (new TextEncoder().encode(body).byteLength > resourceRequestBytes) throw new BoundaryError('BUDGET_EXCEEDED');
      const response = await this.#request({ method: 'POST', path: '/v2/tree/read', body });
      if (!current()) return;
      if (new TextEncoder().encode(response.body).byteLength > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown;
      try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const error = errorSchema.safeParse(value); throw new BoundaryError(error.success ? error.data.error.code : 'STATE_UNAVAILABLE'); }
      const page = validateBranchReadPage(value, binding, cursor, previous ? { ...previous, resourceVersion: 'resourceVersion' in previous ? previous.resourceVersion : null } : undefined);
      this.#page = page; this.#phase = 'ready'; this.#stale = false; this.#show({ phase: 'ready', stale: false, page });
    } catch (error) {
      if (!current()) return;
      this.#phase = 'error'; this.#show({ phase: 'error', stale: !!previous, error: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE', ...(previous ? { page: previous } : {}) });
    }
  }
  cancel(): void {
    if (this.#disposed || this.#phase !== 'loading') return;
    ++this.#revision; this.#phase = 'error'; this.#show({ phase: 'error', stale: !!this.#page, error: 'QUERY_CANCELLED', ...(this.#page ? { page: this.#page } : {}) });
  }
  reset(): void { ++this.#revision; this.#page = undefined; this.#binding = undefined; this.#phase = 'idle'; this.#stale = false; if (!this.#disposed) this.#show({ phase: 'idle', stale: false }); }
  invalidateCustomWatch(target: TargetIdentity, definition: DefinitionReference): void {
    if (this.#disposed || this.#page?.kind !== 'custom-resources' || !sameTarget(this.#page.target, target) || referenceKey(this.#page.definition) !== referenceKey(definition)) return;
    ++this.#revision; this.#phase = 'ready'; this.#stale = true; this.#show({ phase: 'ready', stale: true, page: this.#page });
  }
  dispose(): void { this.#disposed = true; this.reset(); }
}
