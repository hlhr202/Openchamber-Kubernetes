import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { helmRepositoryPageSchema, helmRepositoryRequestSchema, helmRepositorySelectionSchema } from '../shared/helm-repository-protocol.ts';
import type { HelmRepositoryPage, HelmRepositoryRequest } from '../shared/helm-repository-protocol.ts';
import type { TreeTransport } from './tree-source.ts';
import { boundedName, utf8ByteLength } from '../shared/identity.ts';
import { healthSchema } from '../shared/protocol.ts';
type HealthTransport = () => Promise<{ status: number; body: string }>;
export type HelmRepositoryState = { readonly phase: 'idle' | 'loading' | 'ready' | 'error'; readonly stale: boolean; readonly page?: HelmRepositoryPage; readonly error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
const freeze = (value: unknown): void => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } };
export function validateHelmRepositoryPage(input: unknown, request: HelmRepositoryRequest): HelmRepositoryPage {
  const parsed = helmRepositoryPageSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); const page = parsed.data;
  if (JSON.stringify(page.binding) !== JSON.stringify(request.binding) || JSON.stringify(page.branch) !== JSON.stringify(request.branch) || page.offset !== request.offset
    || request.snapshotId !== undefined && request.snapshotId !== page.snapshotId || page.snapshotId !== (page.indexId ?? page.configurationId)
    || request.branch.kind !== 'repositories' && request.branch.configurationId !== page.configurationId
    || request.branch.kind === 'versions' && request.branch.indexId !== page.indexId) throw new BoundaryError('STALE_TARGET');
  const end = page.offset + page.nodes.length;
  if ('mode' in request.binding.selection ? page.sourceOrigins.repositoryFile === 'explicit' || page.sourceOrigins.indexDirectory === 'explicit'
    : JSON.stringify(page.resolvedSelection) !== JSON.stringify(request.binding.selection) || page.sourceOrigins.repositoryFile !== 'explicit' || page.sourceOrigins.indexDirectory !== 'explicit') throw new BoundaryError('STALE_TARGET');
  if (end > page.total || page.nextOffset !== (end < page.total ? end : null) || end < page.total && page.nodes.length !== 100
    || new Set(page.nodes.map(node => node.id)).size !== page.nodes.length || (request.branch.kind === 'repositories') !== (page.indexId === null)) throw new BoundaryError('STATE_UNAVAILABLE');
  for (const node of page.nodes) {
    if (node.kind === 'repository' ? request.branch.kind !== 'repositories' || node.label !== node.repository
      : request.branch.kind === 'repositories' || node.repository !== request.branch.repository || (node.kind === 'chart' ? request.branch.kind !== 'charts' || node.label !== node.chart
        : request.branch.kind !== 'versions' || node.chart !== request.branch.chart || node.label !== node.version)) throw new BoundaryError('STATE_UNAVAILABLE');
  }
  freeze(page); return page;
}
export class HelmRepositoryClient {
  readonly #transport: TreeTransport; readonly #show: (state: HelmRepositoryState) => void;
  readonly #health: HealthTransport | undefined;
  #request: HelmRepositoryRequest | undefined; #page: HelmRepositoryPage | undefined; #phase: HelmRepositoryState['phase'] = 'idle'; #revision = 0; #calls = 0; #disposed = false;
  constructor(transport: TreeTransport, show: (state: HelmRepositoryState) => void, health?: HealthTransport) { this.#transport = transport; this.#show = show; this.#health = health; }
  async connect(selectionInput: unknown, projectId: string): Promise<void> {
    if (this.#disposed) return;
    this.reset(); const revision = this.#revision, selection = helmRepositorySelectionSchema.safeParse(selectionInput);
    this.#phase = 'loading'; this.#show({ phase: 'loading', stale: false });
    try {
      if (!selection.success || !boundedName.safeParse(projectId).success) throw new BoundaryError('INVALID_INPUT');
      if (!this.#health) throw new BoundaryError('STATE_UNAVAILABLE');
      if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT');
      this.#calls++; let response;
      try { response = await this.#health(); } finally { this.#calls--; }
      if (this.#disposed || revision !== this.#revision) return;
      if (utf8ByteLength(response.body) > 4096) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const error = failure.safeParse(value); throw new BoundaryError(error.success ? error.data.error.code : 'STATE_UNAVAILABLE'); }
      const health = healthSchema.safeParse(value); if (!health.success) throw new BoundaryError('STATE_UNAVAILABLE');
      await this.read({ protocol: 2, binding: { serviceGeneration: health.data.serviceGeneration, projectId, selection: selection.data }, branch: { kind: 'repositories' } });
    } catch (error) { if (!this.#disposed && revision === this.#revision) { this.#phase = 'error'; this.#show({ phase: 'error', stale: false, error: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' }); } }
  }
  async read(input: unknown): Promise<void> {
    if (this.#disposed) return; const parsed = helmRepositoryRequestSchema.safeParse(input);
    if (!parsed.success) { this.reset(); this.#show({ phase: 'error', stale: false, error: 'INVALID_INPUT' }); return; }
    const request = parsed.data, revision = ++this.#revision;
    if (this.#page && JSON.stringify(this.#page.binding) !== JSON.stringify(request.binding)) this.#page = undefined;
    this.#request = request; this.#phase = 'loading'; this.#show({ phase: 'loading', stale: !!this.#page, ...(this.#page ? { page: this.#page } : {}) });
    try {
      if (this.#calls >= 4) throw new BoundaryError('QUERY_LIMIT'); const body = JSON.stringify(request); if (utf8ByteLength(body) > 12_000) throw new BoundaryError('BUDGET_EXCEEDED');
      this.#calls++; let response;
      try { response = await this.#transport({ method: 'POST', path: '/v2/helm/repositories/read', body }); } finally { this.#calls--; }
      if (this.#disposed || revision !== this.#revision) return;
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const error = failure.safeParse(value); throw new BoundaryError(error.success ? error.data.error.code : 'STATE_UNAVAILABLE'); }
      this.#page = validateHelmRepositoryPage(value, request); this.#phase = 'ready'; this.#show({ phase: 'ready', stale: false, page: this.#page });
    } catch (error) { if (!this.#disposed && revision === this.#revision) { this.#phase = 'error'; this.#show({ phase: 'error', stale: !!this.#page, error: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE', ...(this.#page ? { page: this.#page } : {}) }); } }
  }
  open(id: string): Promise<void> {
    const page = this.#page, node = this.#phase === 'ready' ? page?.nodes.find(node => node.id === id) : undefined; if (!page || !node || node.kind === 'version') return Promise.resolve();
    const branch = node.kind === 'repository' ? { kind: 'charts' as const, repository: node.repository, configurationId: page.configurationId }
      : { kind: 'versions' as const, repository: node.repository, chart: node.chart, configurationId: page.configurationId, indexId: page.indexId };
    return this.read({ protocol: 2, binding: page.binding, branch });
  }
  next(): Promise<void> { const page = this.#page; return this.#phase === 'ready' && page?.nextOffset && this.#request ? this.read({ ...this.#request, offset: page.nextOffset, snapshotId: page.snapshotId }) : Promise.resolve(); }
  back(): Promise<void> {
    const page = this.#page; if (!page || this.#phase !== 'ready') return Promise.resolve();
    const branch = page.branch.kind === 'versions' ? { kind: 'charts', repository: page.branch.repository, configurationId: page.configurationId } : { kind: 'repositories' };
    return this.read({ protocol: 2, binding: page.binding, branch });
  }
  observeGeneration(serviceGeneration: string): void {
    // A ready configuration response may independently reveal a service restart. No kubeconfig success is required to connect.
    if (this.#request && this.#request.binding.serviceGeneration !== serviceGeneration) this.reset();
  }
  cancel(): void { ++this.#revision; if (!this.#disposed && this.#phase === 'loading') { this.#phase = 'error'; this.#show({ phase: 'error', stale: !!this.#page, error: 'QUERY_CANCELLED', ...(this.#page ? { page: this.#page } : {}) }); } }
  reset(): void { ++this.#revision; this.#request = undefined; this.#page = undefined; this.#phase = 'idle'; if (!this.#disposed) this.#show({ phase: 'idle', stale: false }); }
  dispose(): void { this.#disposed = true; this.reset(); }
}
