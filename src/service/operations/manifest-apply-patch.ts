// WRITE payload preparation. Static review only: never import or execute in automatic functional tests.
import { BoundaryError } from '../../shared/errors.ts';
import { documentProperty, documentString, parseDocumentJson, renderDocumentJson } from '../../shared/document-json.ts';
import type { JsonToken } from '../../shared/document-json.ts';
import { reviewManifestJsonMerge } from '../../parsing/manifest-merge-review.ts';
import { parseManifestValues } from '../../parsing/manifest-values.ts';
import { customDocumentReferenceSchema } from '../../shared/document-protocol.ts';
import { applyComparisonReference } from '../../shared/manifest-apply-protocol.ts';
type Ref = ReturnType<typeof customDocumentReferenceSchema.parse>;
export function prepareManifestApplyPatch(text: string, format: 'yaml' | 'json', live: string, reference: Ref) {
  customDocumentReferenceSchema.parse(reference);
  const desired = parseManifestValues(text, format); if (desired.length !== 1) throw new BoundaryError('CONTENT_INVALID');
  const metadata = documentProperty(desired[0], 'metadata'), currentMetadata = documentProperty(parseDocumentJson(live), 'metadata');
  if (['generateName', 'managedFields', 'deletionTimestamp'].some(key => documentProperty(metadata, key) !== undefined)
    || documentProperty(currentMetadata, 'deletionTimestamp') !== undefined) throw new BoundaryError('CONTENT_INVALID');
  const review = reviewManifestJsonMerge(text, live, format, applyComparisonReference(reference), reference), delta = parseDocumentJson(review.comparison.delta);
  if (delta.kind !== 'object') throw new BoundaryError('CONTENT_INVALID');
  const old = documentProperty(delta, 'metadata'); if (old && old.kind !== 'object') throw new BoundaryError('CONTENT_INVALID');
  // Server-enforced optimistic concurrency, never delete ownership-baseline UID/RV or silently use a newer live RV.
  const pinned: JsonToken = { kind: 'object', entries: [...(old?.kind === 'object' ? old.entries : []).filter(([key]) => key !== 'uid' && key !== 'resourceVersion'),
    ['uid', { kind: 'string', value: reference.uid }], ['resourceVersion', { kind: 'string', value: reference.resourceVersion }]] };
  const body = renderDocumentJson({ kind: 'object', entries: [...delta.entries.filter(([key]) => key !== 'metadata'), ['metadata', pinned]] }, 'json', 1_048_576);
  const check = documentProperty(parseDocumentJson(body), 'metadata');
  if (documentString(documentProperty(check, 'uid')) !== reference.uid || documentString(documentProperty(check, 'resourceVersion')) !== reference.resourceVersion) throw new BoundaryError('CONFLICT');
  return { body, baseline: review.baseline, unchanged: review.comparison.equal };
}
// Explicit missing->Create branch of one Apply intent: the user confirmed Create after a fresh 404 proof.
// The loaded buffer still carries the deleted object's uid/RV; those stale identity fields are removed, never reused.
export function prepareManifestApplyCreate(text: string, format: 'yaml' | 'json', reference: Ref) {
  customDocumentReferenceSchema.parse(reference);
  const desired = parseManifestValues(text, format); if (desired.length !== 1) throw new BoundaryError('CONTENT_INVALID');
  const node = desired[0]; if (!node || node.kind !== 'object') throw new BoundaryError('CONTENT_INVALID');
  const metadata = documentProperty(node, 'metadata'); if (metadata?.kind !== 'object') throw new BoundaryError('CONTENT_INVALID');
  if (['generateName', 'managedFields', 'deletionTimestamp'].some(key => documentProperty(metadata, key) !== undefined)) throw new BoundaryError('CONTENT_INVALID');
  const apiVersion = reference.type.group ? `${reference.type.group}/${reference.type.version}` : reference.type.version;
  if (documentString(documentProperty(node, 'apiVersion')) !== apiVersion || documentString(documentProperty(node, 'kind')) !== reference.type.kind
    || documentString(documentProperty(metadata, 'name')) !== reference.name) throw new BoundaryError('STALE_TARGET');
  if (reference.namespace) { const value = documentString(documentProperty(metadata, 'namespace')); if (value !== undefined && value !== reference.namespace) throw new BoundaryError('STALE_TARGET'); }
  else if (documentProperty(metadata, 'namespace') !== undefined) throw new BoundaryError('STALE_TARGET');
  const entries: readonly (readonly [string, JsonToken])[] = (metadata.kind === 'object' ? metadata.entries : []).filter(([key]) => key !== 'uid' && key !== 'resourceVersion' && key !== 'namespace')
    .map(([key, value]) => [key, value] as const);
  const metadataBody: JsonToken = reference.namespace
    ? { kind: 'object', entries: [...entries, ['namespace', { kind: 'string', value: reference.namespace }]] }
    : { kind: 'object', entries };
  const body = renderDocumentJson({ kind: 'object', entries: [...node.entries.filter(([key]) => key !== 'metadata' && key !== 'apiVersion' && key !== 'kind'), ['apiVersion', { kind: 'string', value: apiVersion }], ['kind', { kind: 'string', value: reference.type.kind }], ['metadata', metadataBody]] }, 'json', 1_048_576);
  const check = documentProperty(parseDocumentJson(body), 'metadata'); if (check?.kind !== 'object') throw new BoundaryError('CONTENT_INVALID');
  if (documentProperty(check, 'uid') !== undefined || documentProperty(check, 'resourceVersion') !== undefined
    || (documentProperty(check, 'namespace') !== undefined && reference.namespace === undefined)
    || documentString(documentProperty(check, 'name')) !== reference.name
    || (reference.namespace !== undefined && documentString(documentProperty(check, 'namespace')) !== reference.namespace)) throw new BoundaryError('CONFLICT');
  return body;
}
