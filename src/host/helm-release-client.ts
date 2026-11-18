// READ UI client for the D-01 Helm Releases view. No write surface; one explicit read per
// namespace; the state carries only metadata projections (no secret payloads, no credentials).
import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { helmReleaseResponseSchema } from '../shared/helm-release-protocol.ts';
import type { HelmReleaseEntry, HelmReleaseResponse } from '../shared/helm-release-protocol.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { configSelectionSchema } from '../shared/configuration.ts';
import { utf8ByteLength } from '../shared/identity.ts';
import type { TargetIdentity } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';
export type HelmReleaseDetail = Extract<HelmReleaseResponse, { kind: 'release-detail' }>;
export type HelmReleaseState = { readonly phase: 'idle' | 'loading' | 'ready' | 'error'; readonly stale: boolean;
  readonly namespace?: string; readonly releases?: readonly HelmReleaseEntry[]; readonly truncated?: boolean; readonly detail?: HelmReleaseDetail; readonly error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
export class HelmReleaseClient {
  readonly #request: TreeTransport; readonly #show: (state: HelmReleaseState) => void;
  #revision = 0; #calls = 0; #disposed = false;
  constructor(request: TreeTransport, show: (state: HelmReleaseState) => void) { this.#request = request; this.#show = show; }
  async read(target: TargetIdentity | undefined, selection: ConfigSelection, namespace: string): Promise<void> {
    if (this.#disposed) return;
    const revision = ++this.#revision, current = () => !this.#disposed && revision === this.#revision;
    this.#show({ phase: 'loading', stale: false });
    if (this.#calls >= 2) { if (current()) this.#show({ phase: 'error', stale: false, error: 'QUERY_LIMIT' }); return; }
    const body = JSON.stringify({ protocol: 2, kind: 'read', selection: configSelectionSchema.parse(selection), ...(target ? { target } : {}), namespace });
    if (utf8ByteLength(body) > 12_000) { if (current()) this.#show({ phase: 'error', stale: false, error: 'BUDGET_EXCEEDED' }); return; }
    this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/helm/releases/read', body });
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = helmReleaseResponseSchema.safeParse(value); if (!parsed.success || parsed.data.kind !== 'releases') throw new BoundaryError('STATE_UNAVAILABLE');
      if (current()) this.#show({ phase: 'ready', stale: false, namespace: parsed.data.namespace, releases: parsed.data.releases as readonly HelmReleaseEntry[], truncated: parsed.data.truncated });
    } catch (error) {
      if (current()) this.#show({ phase: 'error', stale: false, error: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    } finally { this.#calls--; }
  }
  async detail(target: TargetIdentity | undefined, selection: ConfigSelection, namespace: string, release: string): Promise<void> {
    if (this.#disposed) return;
    const revision = ++this.#revision, current = () => !this.#disposed && revision === this.#revision;
    this.#show({ phase: 'loading', stale: false });
    if (this.#calls >= 2) { if (current()) this.#show({ phase: 'error', stale: false, error: 'QUERY_LIMIT' }); return; }
    const body = JSON.stringify({ protocol: 2, kind: 'detail', selection: configSelectionSchema.parse(selection), ...(target ? { target } : {}), namespace, release });
    if (utf8ByteLength(body) > 12_000) { if (current()) this.#show({ phase: 'error', stale: false, error: 'BUDGET_EXCEEDED' }); return; }
    this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/helm/releases/read', body });
      if (utf8ByteLength(response.body) > 1_200_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = helmReleaseResponseSchema.safeParse(value); if (!parsed.success || parsed.data.kind !== 'release-detail') throw new BoundaryError('STATE_UNAVAILABLE');
      if (current()) this.#show({ phase: 'ready', stale: false, namespace: parsed.data.namespace, detail: parsed.data });
    } catch (error) {
      if (current()) this.#show({ phase: 'error', stale: false, error: error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' });
    } finally { this.#calls--; }
  }
  reset() { ++this.#revision; if (!this.#disposed) this.#show({ phase: 'idle', stale: false }); }
  dispose() { this.#disposed = true; }
}
