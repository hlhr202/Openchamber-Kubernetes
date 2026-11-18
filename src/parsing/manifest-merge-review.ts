// Explicit local read-only model review of already captured Diff values; never authorizes Apply.
import { BoundaryError } from '../shared/errors.ts';
import { documentProperty, documentString, parseDocumentJson, renderDocumentJson } from '../shared/document-json.ts';
import type { JsonToken } from '../shared/document-json.ts';
import { compareThreeWayJson } from '../shared/json-merge-comparison.ts';
import type { JsonMergeComparison } from '../shared/json-merge-comparison.ts';
import { manifestComparisonReferenceSchema } from '../shared/manifest-diff-protocol.ts';
import type { ManifestComparisonReference } from '../shared/manifest-diff-protocol.ts';
import { boundedName, utf8ByteLength } from '../shared/identity.ts';
import { parseManifestValues } from './manifest-values.ts';
const annotation = 'kubectl.kubernetes.io/last-applied-configuration';
type ObjectToken = Extract<JsonToken, { kind: 'object' }>;
export type ManifestMergeReview = { readonly kind: 'json-merge-model-only'; readonly baseline: 'annotation' | 'absent'; readonly uid: string; readonly resourceVersion: string;
  readonly annotationWillChange: boolean; readonly comparison: JsonMergeComparison };
function object(value: JsonToken | undefined): ObjectToken { if (value?.kind !== 'object') throw new BoundaryError('CONTENT_INVALID'); return value; }
function set(node: ObjectToken, key: string, value: JsonToken | undefined): ObjectToken {
  return { kind: 'object', entries: [...node.entries.filter(([name]) => name !== key), ...(value ? [[key, value] as const] : [])] };
}
function annotations(node: ObjectToken): ObjectToken {
  const value = documentProperty(object(documentProperty(node, 'metadata')), 'annotations');
  if (value === undefined || value.kind === 'atom' && value.text === 'null') return { kind: 'object', entries: [] };
  const map = object(value); if (map.entries.some(([, entry]) => entry.kind !== 'string')) throw new BoundaryError('CONTENT_INVALID'); return map;
}
function serialise(node: JsonToken) { return renderDocumentJson(node, 'json', 1_048_576); }
export function reviewManifestJsonMerge(local: string, current: string, format: 'yaml' | 'json', reference: ManifestComparisonReference, observed: { uid: string; resourceVersion: string }): ManifestMergeReview {
  const ref = manifestComparisonReferenceSchema.parse(reference), values = parseManifestValues(local, format), liveValues = parseManifestValues(current, format);
  if (values.length !== 1 || liveValues.length !== 1 || !boundedName.safeParse(observed.uid).success || !boundedName.safeParse(observed.resourceVersion).success) throw new BoundaryError('CONTENT_INVALID');
  const desired = object(values[0]), live = object(liveValues[0]), metadata = object(documentProperty(live, 'metadata'));
  if (documentString(documentProperty(metadata, 'uid')) !== observed.uid || documentString(documentProperty(metadata, 'resourceVersion')) !== observed.resourceVersion) throw new BoundaryError('STALE_TARGET');
  function identity(node: ObjectToken, origin: 'desired' | 'live' | 'baseline') {
    const meta = object(documentProperty(node, 'metadata')), ns = documentProperty(meta, 'namespace');
    if (documentString(documentProperty(node, 'apiVersion')) !== (ref.type.group ? `${ref.type.group}/${ref.type.version}` : ref.type.version)
      || documentString(documentProperty(node, 'kind')) !== ref.type.kind || documentString(documentProperty(meta, 'name')) !== ref.name
      || (ref.namespace ? ns !== undefined ? documentString(ns) !== ref.namespace : origin === 'live' : ns !== undefined)) throw new BoundaryError('STALE_TARGET');
    for (const key of ['uid', 'resourceVersion'] as const) {
      if (origin === 'baseline' && key === 'resourceVersion') continue; // Last-applied normally predates the captured live RV.
      const value = documentProperty(meta, key); if (value !== undefined && documentString(value) !== observed[key]) throw new BoundaryError('CONFLICT');
    }
    return ref.namespace && ns === undefined ? set(node, 'metadata', set(meta, 'namespace', { kind: 'string', value: ref.namespace })) : node;
  }
  const normalized = identity(desired, 'desired'); identity(live, 'live');
  const liveAnnotations = annotations(live), previous = documentProperty(liveAnnotations, annotation), originalText = documentString(previous);
  if (previous && originalText === undefined || originalText !== undefined && utf8ByteLength(originalText) > 262_144) throw new BoundaryError('CONTENT_INVALID');
  // An absent/empty annotation is an empty ownership baseline, never permission to delete all live fields.
  let original: ObjectToken = { kind: 'object', entries: [] };
  if (originalText) { original = object(parseDocumentJson(originalText)); identity(original, 'baseline'); annotations(original); }
  const localAnnotations = set(annotations(normalized), annotation, undefined), localMetadata = object(documentProperty(normalized, 'metadata'));
  const withoutAnnotation = set(normalized, 'metadata', set(localMetadata, 'annotations', localAnnotations));
  const encoded = serialise(withoutAnnotation);
  // Server annotation limits are aggregate/admission-dependent. This conservative local cap isn't proof of acceptance.
  if (utf8ByteLength(encoded) > 262_144) throw new BoundaryError('BUDGET_EXCEEDED');
  const modified = set(withoutAnnotation, 'metadata', set(object(documentProperty(withoutAnnotation, 'metadata')), 'annotations', set(localAnnotations, annotation, { kind: 'string', value: encoded })));
  const comparison = compareThreeWayJson(serialise(original), serialise(modified), serialise(live));
  const delta = parseDocumentJson(comparison.delta);
  if (documentProperty(delta, 'apiVersion') !== undefined || documentProperty(delta, 'kind') !== undefined || documentProperty(documentProperty(delta, 'metadata'), 'name') !== undefined) throw new BoundaryError('CONFLICT');
  return Object.freeze({ kind: 'json-merge-model-only', baseline: originalText ? 'annotation' : 'absent', uid: observed.uid, resourceVersion: observed.resourceVersion,
    annotationWillChange: originalText !== encoded, comparison });
}
