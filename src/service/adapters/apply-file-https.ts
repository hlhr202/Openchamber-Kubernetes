// Actual WRITE transport for the approved D-02 ApplyFile chain. Never imported, constructed or
// invoked by automatic functional tests. Per document: ONE discovery GET per distinct
// group/version, ONE fresh GET proving the pinned state, ONE write (PATCH merge or POST create)
// via the shared one-shot core. Documents are dispatched strictly in order; the first
// not-submitted failure stops the batch, and anything after a dispatched write can only be
// reported, never retried or rolled back.
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { boundedName, targetSchema } from '../../shared/identity.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import { documentProperty, documentString, parseDocumentJson, renderDocumentJson } from '../../shared/document-json.ts';
import type { JsonToken } from '../../shared/document-json.ts';
import { manifestComparisonPath } from '../../shared/manifest-diff-protocol.ts';
import type { ManifestComparisonReference } from '../../shared/manifest-diff-protocol.ts';
import { reviewManifestJsonMerge } from '../../parsing/manifest-merge-review.ts';
import { resolveManifestComparison } from '../queries/manifest-comparison.ts';
import { apiDiscoveryPath, projectDiscovery } from '../queries/resource-query.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { onceRequest } from './https-once.ts';
import { directConnection } from './manifest-apply-https.ts';
import type { OnceConnection } from './https-once.ts';
import type { ApplyFileResult } from '../../shared/apply-file-protocol.ts';

export type ApplyFileDispatchDocument = { readonly index: number; readonly text: string; readonly locator: { readonly group: string; readonly version: string; readonly kind: string; readonly name: string; readonly namespace?: string | undefined }; readonly action: 'apply-merge' | 'create' };
export type ApplyFileDispatch = { readonly target: TargetIdentity; readonly selection: ConfigSelection; readonly documents: readonly ApplyFileDispatchDocument[]; readonly notAfter: number };
export type ApplyFileDispatchResult = { readonly outcome: 'accepted' | 'failed' | 'unknown'; readonly code?: ErrorCode; readonly results: readonly ApplyFileResult[] };
const metadataOf = (raw: string) => documentProperty(parseDocumentJson(raw), 'metadata');

export function createApplyFileHttpsAdapter(config: ReturnType<typeof createConfigReader>) {
  return async function execute(input: ApplyFileDispatch, beforeDispatch: () => void, signal: AbortSignal): Promise<ApplyFileDispatchResult> {
      targetSchema.parse(input.target);
      if (!input.documents.length || input.documents.length > 16) throw new BoundaryError('INVALID_INPUT');
      const transport = await directConnection(config, input, signal);
      const discovery = new Map<string, ManifestComparisonReference>();
      const results: ApplyFileResult[] = [];
      let dispatched = false, stopped: ErrorCode | undefined;
      try {
        const resolve = async (document: ApplyFileDispatchDocument): Promise<ManifestComparisonReference> => {
          const key = `${document.locator.group}/${document.locator.version}`;
          const cached = discovery.get(key);
          if (cached) return cached;
          const url = new URL(apiDiscoveryPath(document.locator.group, document.locator.version), transport.server);
          const payload = await onceRequest<string | null>(transport, url, 'GET', 'application/json', 200, undefined, signal, null, () => null, (_value, raw) => raw);
          if (!payload) throw new BoundaryError('RESOURCE_INVALID');
          const value: unknown = JSON.parse(payload);
          const reference = resolveManifestComparison(value, { group: document.locator.group, version: document.locator.version, kind: document.locator.kind, name: document.locator.name, ...(document.locator.namespace !== undefined ? { namespace: document.locator.namespace } : {}) }, input.target);
          const candidates = projectDiscovery(value, ['get']);
          if (!reference || !candidates.some(type => JSON.stringify(type) === JSON.stringify(reference.type))) throw new BoundaryError('RESOURCE_INVALID');
          discovery.set(key, reference);
          return reference;
        };
        for (const document of input.documents) {
          if (signal.aborted || Date.now() >= input.notAfter) { stopped = signal.aborted ? 'QUERY_CANCELLED' : 'CONFIRMATION_EXPIRED'; break; }
          const reference = await resolve(document);
          const objectUrl = new URL(manifestComparisonPath(reference), transport.server);
          // Fresh GET proving the pinned state immediately before the single write.
          const live = await onceRequest<string | null>(transport, objectUrl, 'GET', 'application/json', 200, undefined, signal, null, () => null, (_value, raw) => raw);
          if (document.action === 'create' ? live !== null : live === null) {
            const code: ErrorCode = document.action === 'create' ? 'CONFLICT' : 'NOT_FOUND';
            results.push({ index: document.index, action: document.action, outcome: dispatched ? 'unknown' : 'failed', code });
            stopped = stopped ?? code; break;
          }
          const observed = live === null ? undefined : liveIdentity(live, reference);
          if (document.action === 'apply-merge' && !observed) {
            results.push({ index: document.index, action: 'apply-merge', outcome: dispatched ? 'unknown' : 'failed', code: 'CONFLICT' });
            stopped = stopped ?? 'CONFLICT'; break;
          }
          const body = Buffer.from(document.action === 'create' ? createBody(document, reference) : mergeBody(document, reference, observed ?? { uid: '', resourceVersion: '' }, live ?? ''));
          try {
            if (!dispatched) beforeDispatch();
            dispatched = true;
            const url = document.action === 'create' ? collectionUrl(reference, transport) : objectUrl;
            if (document.action === 'apply-merge') url.search = '?fieldManager=kubectl-client-side-apply&fieldValidation=Strict';
            const written = await onceRequest<ApplyFileResult | undefined>(transport, url, document.action === 'create' ? 'POST' : 'PATCH',
              document.action === 'create' ? 'application/json' : 'application/merge-patch+json', document.action === 'create' ? 201 : 200, body, signal, undefined,
              (code: ErrorCode) => ({ index: document.index, action: document.action, outcome: 'unknown', code }),
              (_value, raw) => {
                const rv = documentString(documentProperty(metadataOf(raw), 'resourceVersion'));
                return sameIdentity(raw, reference) && rv ? { index: document.index, action: document.action, outcome: 'accepted', ...(rv ? { resourceVersion: rv } : {}) } : undefined;
              });
            const result = written ?? { index: document.index, action: document.action, outcome: 'unknown' as const, code: 'OPERATION_UNKNOWN' as ErrorCode };
            results.push(result);
            if (result.outcome !== 'accepted') { stopped = stopped ?? result.code ?? 'STATE_UNAVAILABLE'; break; }
          } finally { body.fill(0); }
        }
        if (!results.length) return { outcome: 'failed', code: stopped ?? 'STATE_UNAVAILABLE', results };
        const outcome = results.some(item => item.outcome === 'unknown') ? 'unknown' : stopped ? 'failed' : 'accepted';
        return { outcome, ...(outcome === 'accepted' ? {} : { code: stopped ?? 'OPERATION_UNKNOWN' }), results };
    } finally { transport.ca?.fill(0); }
  };
}
function collectionUrl(reference: ManifestComparisonReference, transport: OnceConnection): URL {
  const objectPath = manifestComparisonPath(reference), url = new URL(objectPath.slice(0, objectPath.lastIndexOf('/')), transport.server);
  url.search = '?fieldManager=kubectl-create&fieldValidation=Strict';
  return url;
}
function sameIdentity(raw: string, reference: ManifestComparisonReference): boolean {
  const node = parseDocumentJson(raw), metadata = metadataOf(raw);
  return documentString(documentProperty(node, 'apiVersion')) === (reference.type.group ? `${reference.type.group}/${reference.type.version}` : reference.type.version)
    && documentString(documentProperty(node, 'kind')) === reference.type.kind
    && documentString(documentProperty(metadata, 'name')) === reference.name
    && (reference.namespace ? documentString(documentProperty(metadata, 'namespace')) === reference.namespace : documentProperty(metadata, 'namespace') === undefined);
}
function liveIdentity(raw: string, reference: ManifestComparisonReference): { uid: string; resourceVersion: string } | undefined {
  const metadata = metadataOf(raw), uid = documentString(documentProperty(metadata, 'uid')), rv = documentString(documentProperty(metadata, 'resourceVersion'));
  if (!uid || !rv || !boundedName.safeParse(uid).success || !boundedName.safeParse(rv).success || !sameIdentity(raw, reference)) return undefined;
  return { uid, resourceVersion: rv };
}
// Client-side-apply merge body: the delta of the reviewed three-way merge with the server-side
// optimistic-concurrency metadata pinned to the fresh live uid/resourceVersion.
function mergeBody(document: ApplyFileDispatchDocument, reference: ManifestComparisonReference, observed: { uid: string; resourceVersion: string }, live: string): string {
  const review = reviewManifestJsonMerge(document.text, live, 'yaml', reference, observed);
  const delta = parseDocumentJson(review.comparison.delta);
  if (delta.kind !== 'object') throw new BoundaryError('CONTENT_INVALID');
  const old = documentProperty(delta, 'metadata');
  const kept: readonly (readonly [string, JsonToken])[] = (old?.kind === 'object' ? old.entries : []).filter((entry): entry is readonly [string, JsonToken] => entry[0] !== 'uid' && entry[0] !== 'resourceVersion');
  const pinned: JsonToken = { kind: 'object', entries: [...kept,
    ['uid', { kind: 'string', value: observed.uid }] as const, ['resourceVersion', { kind: 'string', value: observed.resourceVersion }] as const] };
  const body = renderDocumentJson({ kind: 'object', entries: [...delta.entries.filter((entry): entry is readonly [string, JsonToken] => entry[0] !== 'metadata'), ['metadata', pinned] as const] }, 'json', 1_048_576);
  const check = documentProperty(parseDocumentJson(body), 'metadata');
  if (documentString(documentProperty(check, 'uid')) !== observed.uid || documentString(documentProperty(check, 'resourceVersion')) !== observed.resourceVersion) throw new BoundaryError('CONFLICT');
  return body;
}
// kubectl-create semantics: the create body carries the intended identity and no stale fields.
function createBody(document: ApplyFileDispatchDocument, reference: ManifestComparisonReference): string {
  const node = parseDocumentJson(document.text);
  if (node.kind !== 'object') throw new BoundaryError('CONTENT_INVALID');
  const metadata = documentProperty(node, 'metadata');
  const apiVersion = reference.type.group ? `${reference.type.group}/${reference.type.version}` : reference.type.version;
  if (documentString(documentProperty(node, 'apiVersion')) !== apiVersion || documentString(documentProperty(node, 'kind')) !== reference.type.kind
    || documentString(documentProperty(metadata, 'name')) !== reference.name) throw new BoundaryError('STALE_TARGET');
  const entries: readonly (readonly [string, JsonToken])[] = (metadata?.kind === 'object' ? metadata.entries : []).filter((entry): entry is readonly [string, JsonToken] => entry[0] !== 'uid' && entry[0] !== 'resourceVersion' && entry[0] !== 'namespace');
  const metadataBody: JsonToken = reference.namespace
    ? { kind: 'object', entries: [...entries, ['namespace', { kind: 'string', value: reference.namespace }] as const] }
    : { kind: 'object', entries };
  const body = renderDocumentJson({ kind: 'object', entries: [...node.entries.filter((entry): entry is readonly [string, JsonToken] => entry[0] !== 'metadata' && entry[0] !== 'apiVersion' && entry[0] !== 'kind'),
    ['apiVersion', { kind: 'string', value: apiVersion }] as const, ['kind', { kind: 'string', value: reference.type.kind }] as const, ['metadata', metadataBody] as const] }, 'json', 1_048_576);
  const check = documentProperty(parseDocumentJson(body), 'metadata');
  if (documentProperty(check, 'uid') !== undefined || documentProperty(check, 'resourceVersion') !== undefined || documentString(documentProperty(check, 'name')) !== reference.name) throw new BoundaryError('CONFLICT');
  return body;
}
