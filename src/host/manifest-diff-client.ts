import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { manifestDiffPageSchema, manifestDiffRequestSchema } from '../shared/manifest-diff-protocol.ts';
import type { ManifestDiffPage } from '../shared/manifest-diff-protocol.ts';
import { localComparisonDocuments } from './manifest-diff-source.ts';
import { compareDocumentText } from '../shared/text-comparison.ts';
import type { TextComparison } from '../shared/text-comparison.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import type { TargetIdentity } from '../shared/identity.ts';
import { sameTarget, utf8ByteLength } from '../shared/identity.ts';
import type { TreeTransport } from './tree-source.ts';
import { reviewManifestJsonMerge } from '../parsing/manifest-merge-review.ts';
import type { ManifestMergeReview } from '../parsing/manifest-merge-review.ts';
export type DiffSource = { readonly owner: object; readonly revision: number; readonly text: string; readonly format: 'yaml' | 'json'; readonly target: TargetIdentity; readonly selection: ConfigSelection;
  readonly expected?: { group: string; version: string; kind: string; name: string; namespace?: string; uid: string } };
export type DiffDocument = { readonly index: number; readonly local: string; readonly phase: 'live' | 'missing' | 'unresolved' | 'failed'; readonly live?: string; readonly comparison?: TextComparison;
  readonly observed?: Extract<ManifestDiffPage, { kind: 'live-comparison' }>; readonly code?: ErrorCode; readonly mergeReview?: ManifestMergeReview; readonly mergeReviewError?: ErrorCode };
export type ManifestDiffState = { readonly phase: 'idle' | 'reading' | 'ready' | 'error' | 'empty'; readonly stale: boolean; readonly documents: readonly DiffDocument[]; readonly source?: Pick<DiffSource, 'target' | 'revision' | 'format'>; readonly reason?: 'no-editor' | 'no-input'; readonly error?: ErrorCode };
const failure = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
type DiffSnapshotReader = (kind: 'live' | 'file', format: 'yaml' | 'json') => DiffSource | undefined;
// READ-ONLY comparison client. Not an Apply prepare/confirm/upload handler; body stays exclusively in this browser buffer.
export class ManifestDiffClient {
  readonly #request: TreeTransport; readonly #snapshot: (kind: 'live' | 'file', format: 'yaml' | 'json') => DiffSource | undefined; readonly #show: (state: ManifestDiffState) => void;
  #revision = 0; #calls = 0; #disposed = false; #source: DiffSource | undefined; #kind: 'live' | 'file' = 'live'; #documents: DiffDocument[] = []; #phase: ManifestDiffState['phase'] = 'idle';
  constructor(request: TreeTransport, snapshot: DiffSnapshotReader, show: (state: ManifestDiffState) => void) { this.#request = request; this.#snapshot = snapshot; this.#show = show; }
  #paint(phase: ManifestDiffState['phase'], stale = false, error?: ErrorCode, reason?: ManifestDiffState['reason']) {
    this.#phase = phase; if (!this.#disposed) this.#show({ phase, stale, documents: this.#documents, ...(this.#source ? { source: { target: this.#source.target, revision: this.#source.revision, format: this.#source.format } } : {}), ...(error ? { error } : {}), ...(reason ? { reason } : {}) });
  }
  #current(source: DiffSource) { const value = this.#snapshot(this.#kind, source.format); return !!value && value.owner === source.owner && value.revision === source.revision && value.text === source.text && sameTarget(value.target, source.target) && JSON.stringify(value.selection) === JSON.stringify(source.selection); }
  async #post(request: unknown): Promise<ManifestDiffPage> {
    if (this.#calls >= 2) throw new BoundaryError('QUERY_LIMIT'); const body = JSON.stringify(manifestDiffRequestSchema.parse(request)); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED'); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path: '/v2/manifest-diff/read', body }); if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let value: unknown; try { value = JSON.parse(response.body); } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = failure.safeParse(value); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); }
      const parsed = manifestDiffPageSchema.safeParse(value); if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); return parsed.data;
    } finally { this.#calls--; }
  }
  async read(kind: 'live' | 'file', format: 'yaml' | 'json', selection?: { start: number; end: number }): Promise<void> {
    if (this.#disposed) return; const revision = ++this.#revision; this.#kind = kind; this.#documents = []; this.#source = this.#snapshot(kind, format);
    const source = this.#source; if (!source) { this.#paint('empty', false, undefined, 'no-editor'); return; }
    this.#paint('reading'); let totalBytes = 0;
    const current = () => !this.#disposed && revision === this.#revision && this.#current(source);
    try {
      const local = localComparisonDocuments(source.text, source.format, selection); if (!local.length) { this.#paint('empty', false, undefined, 'no-input'); return; }
      for (const document of local) {
        if (!current()) return;
        if (!document.locator) { this.#documents = [...this.#documents, { index: document.index, local: document.text, phase: 'unresolved', code: 'RESOURCE_INVALID' }]; continue; }
        const locator = document.locator, original = source.expected;
        const expectedUid = original && original.group === locator.group && original.version === locator.version && original.kind === locator.kind && original.name === locator.name
          && original.namespace === (locator.namespace ?? (original.namespace ? source.target.namespace : undefined)) ? original.uid : undefined;
        let text = '', cursor: string | undefined, previous: Extract<ManifestDiffPage, { kind: 'live-comparison' }> | undefined; const tokens = new Set<string>();
        try {
          for (let chunk = 0; chunk < 64; chunk++) {
            const page = await this.#post({ protocol: 2, target: source.target, selection: source.selection, locator, format: source.format, ...(expectedUid ? { expectedUid } : {}), ...(cursor ? { cursor } : {}) });
            if (!current()) return;
            if (!sameTarget(page.target, source.target) || JSON.stringify(page.locator) !== JSON.stringify(locator) || page.format !== source.format) throw new BoundaryError('STALE_TARGET');
            if (page.kind !== 'comparison-unresolved') {
              const reference = page.reference, type = reference.type;
              if (type.group !== locator.group || type.version !== locator.version || type.kind !== locator.kind || reference.name !== locator.name
                || (type.scope === 'namespace' ? reference.namespace !== (locator.namespace ?? source.target.namespace) : locator.namespace !== undefined || reference.namespace !== undefined)) throw new BoundaryError('STALE_TARGET');
            }
            if (page.kind !== 'live-comparison') {
              if (cursor) throw new BoundaryError('STALE_TARGET'); this.#documents = [...this.#documents, { index: document.index, local: document.text, phase: page.kind === 'comparison-missing' ? 'missing' : 'unresolved', ...(page.kind === 'comparison-unresolved' ? { code: page.code } : {}) }]; break;
            }
            if (page.offset !== text.length || previous && (page.identity !== previous.identity || page.uid !== previous.uid || page.resourceVersion !== previous.resourceVersion || page.totalBytes !== previous.totalBytes || page.totalCharacters !== previous.totalCharacters
              || JSON.stringify(page.reference) !== JSON.stringify(previous.reference) || page.expiresAt !== previous.expiresAt) || expectedUid && page.uid !== expectedUid) throw new BoundaryError('STALE_TARGET');
            text += page.text; totalBytes += utf8ByteLength(page.text); if (totalBytes > 4_194_304 || utf8ByteLength(text) > page.totalBytes) throw new BoundaryError('BUDGET_EXCEEDED');
            if (!page.nextCursor) {
              if (text.length !== page.totalCharacters || utf8ByteLength(text) !== page.totalBytes) throw new BoundaryError('CONTENT_INVALID');
              this.#documents = [...this.#documents, { index: document.index, local: document.text, phase: 'live', live: text, comparison: compareDocumentText(document.text, text), observed: { ...page, text: '' } }]; break;
            }
            if (tokens.has(page.nextCursor) || page.end <= page.offset || chunk === 63) throw new BoundaryError('BUDGET_EXCEEDED'); tokens.add(page.nextCursor); cursor = page.nextCursor; previous = page;
          }
        } catch (error) {
          if (!current()) return; const code = error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE';
          if (['STALE_TARGET', 'SERVICE_CLOSED', 'QUERY_CANCELLED', 'BUDGET_EXCEEDED', 'VIEW_EXPIRED'].includes(code)) throw error;
          this.#documents = [...this.#documents, { index: document.index, local: document.text, phase: 'failed', code }];
        }
      }
      if (current()) this.#paint('ready');
    } catch (error) { if (current()) this.#paint('error', true, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  inspectJsonMerge(index: number): void {
    if (this.#disposed || this.#phase !== 'ready' || !this.#source) return;
    if (!this.#current(this.#source)) { this.changed(); return; }
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#documents.length) return;
    const value = this.#documents[index];
    if (!value || value.phase !== 'live' || value.live === undefined || !value.observed) return;
    this.#clearMergeReviews();
    try {
      const mergeReview = reviewManifestJsonMerge(value.local, value.live, this.#source.format, value.observed.reference, value.observed);
      this.#documents = this.#documents.map((document, position) => position === index ? { ...document, mergeReview } : document);
    } catch (error) {
      this.#documents = this.#documents.map((document, position) => position === index ? { ...document, mergeReviewError: error instanceof BoundaryError ? error.code : 'CONTENT_INVALID' } : document);
    }
    this.#paint('ready'); // Local model only: no RPC, new snapshot, confirm, grant, upload or write.
  }
  #clearMergeReviews() {
    this.#documents = this.#documents.map(({ mergeReview: _review, mergeReviewError: _error, ...value }) => value);
  }
  changed() { if (this.#source && !this.#current(this.#source) && this.#phase !== 'idle') { ++this.#revision; this.#clearMergeReviews(); this.#paint('error', true, 'STALE_TARGET'); } }
  cancel() { if (this.#disposed) return; ++this.#revision; this.#paint('error', true, 'QUERY_CANCELLED'); }
  reset() { ++this.#revision; this.#source = undefined; this.#documents = []; this.#paint('idle'); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
