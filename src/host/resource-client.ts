import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { sameTarget, stableNodeId } from '../shared/identity.ts';
import { resourceReadRequestSchema, resourceReadResponseSchema, resourceRequestBytes } from '../shared/resource-protocol.ts';
import type { ResourceReadResponse } from '../shared/resource-protocol.ts';
import { resourceDescriptors } from '../shared/tree.ts';

export type ResourceState = { readonly phase: 'idle' | 'loading' | 'ready' | 'error'; readonly stale: boolean; readonly page?: ResourceReadResponse; readonly error?: ErrorCode };
const bindingSchema = resourceReadRequestSchema.omit({ cursor: true });
type Binding = z.infer<typeof bindingSchema>;
const errorSchema = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
type Transport = (request: { method: 'POST'; path: string; body: string }) => Promise<{ status: number; body: string }>;

export function validateResourceReadPage(value: unknown, binding: Binding, cursor?: string, previous?: { resourceVersion: string | null }): ResourceReadResponse {
  const parsed = resourceReadResponseSchema.safeParse(value);
  if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE');
  const page = parsed.data;
  if (!sameTarget(page.target, binding.target) || page.resource !== binding.resource || (cursor && page.resourceVersion !== previous?.resourceVersion)) throw new BoundaryError('STALE_TARGET');
  if (cursor && page.nextCursor === cursor) throw new BoundaryError('STATE_UNAVAILABLE');
  const descriptor = Object.entries(resourceDescriptors).find(([name]) => name === binding.resource)?.[1];
  if (!descriptor || new Set(page.nodes.map(node => node.id)).size !== page.nodes.length) throw new BoundaryError('STATE_UNAVAILABLE');
  for (const node of page.nodes) {
    const identity = node.resource;
    if (identity.group !== descriptor.group || identity.version !== descriptor.version || identity.resource !== descriptor.resource || identity.kind !== descriptor.kind || identity.scope !== descriptor.scope
      || (identity.scope === 'namespace' ? identity.namespace !== binding.target.namespace : identity.namespace !== undefined)
      || node.id !== stableNodeId(binding.target, identity.group, identity.version, identity.resource, identity.namespace ?? '', identity.name, identity.uid ?? '')) throw new BoundaryError('STALE_TARGET');
    const label = binding.resource === 'namespaces' && identity.name === binding.target.namespace ? `* ${identity.name}` : identity.name;
    if (node.children !== descriptor.children || node.expandable !== (descriptor.children !== 'none') || node.label !== label) throw new BoundaryError('STATE_UNAVAILABLE');
  }
  return page;
}

export class ResourceClient {
  readonly #request: Transport;
  readonly #show: (state: ResourceState) => void;
  #binding: Binding | undefined;
  #page: ResourceReadResponse | undefined;
  #revision = 0;
  #phase: ResourceState['phase'] = 'idle';
  #disposed = false;
  constructor(request: Transport, show: (state: ResourceState) => void) { this.#request = request; this.#show = show; }
  read(input: unknown): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const parsed = bindingSchema.safeParse(input);
    if (!parsed.success) { this.reset(); this.#phase = 'error'; this.#show({ phase: 'error', stale: false, error: 'INVALID_INPUT' }); return Promise.resolve(); }
    if (JSON.stringify(parsed.data) !== JSON.stringify(this.#binding)) this.#page = undefined;
    this.#binding = parsed.data;
    return this.#load();
  }
  next(): Promise<void> {
    if (this.#phase !== 'ready' || !this.#page?.nextCursor) return Promise.resolve();
    return this.#load(this.#page.nextCursor);
  }
  async #load(cursor?: string): Promise<void> {
    if (this.#disposed || !this.#binding) return;
    const binding = this.#binding, previous = this.#page, revision = ++this.#revision;
    const current = () => !this.#disposed && this.#revision === revision;
    this.#phase = 'loading';
    this.#show({ phase: 'loading', stale: !!previous, ...(previous ? { page: previous } : {}) });
    try {
      const body = JSON.stringify({ ...binding, ...(cursor ? { cursor } : {}) });
      if (new TextEncoder().encode(body).byteLength > resourceRequestBytes) throw new BoundaryError('BUDGET_EXCEEDED');
      const response = await this.#request({ method: 'POST', path: '/v2/resources/read', body });
      if (!current()) return;
      if (new TextEncoder().encode(response.body).byteLength > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown;
      try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const error = errorSchema.safeParse(value); throw new BoundaryError(error.success ? error.data.error.code : 'STATE_UNAVAILABLE'); }
      const page = validateResourceReadPage(value, binding, cursor, previous);
      this.#page = page; this.#phase = 'ready'; this.#show({ phase: 'ready', stale: false, page });
    } catch (error) {
      if (!current()) return;
      this.#phase = 'error'; this.#show({ phase: 'error', stale: !!previous, error: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE', ...(previous ? { page: previous } : {}) });
    }
  }
  cancel(): void {
    if (this.#disposed || this.#phase !== 'loading') return;
    ++this.#revision; this.#phase = 'error';
    this.#show({ phase: 'error', stale: !!this.#page, error: 'QUERY_CANCELLED', ...(this.#page ? { page: this.#page } : {}) });
  }
  reset(): void { ++this.#revision; this.#page = undefined; this.#binding = undefined; this.#phase = 'idle'; if (!this.#disposed) this.#show({ phase: 'idle', stale: false }); }
  invalidate(resource: string, target: ResourceReadResponse['target']): void {
    if (this.#disposed || !this.#page || this.#binding?.resource !== resource || !sameTarget(this.#page.target, target)) return;
    ++this.#revision; this.#phase = 'ready'; this.#show({ phase: 'ready', stale: true, page: this.#page });
  }
  dispose(): void { this.#disposed = true; this.reset(); }
}
