// Pure bounded file→documents splitter for the approved D-02 ApplyFile chain and the Typed List
// create upgrade. Streaming YAML composition via the shared analyser; no IO, no execution plan.
import { BoundaryError } from '../shared/errors.ts';
import { documentBytes } from '../shared/document-protocol.ts';
import { parseDocumentJson, documentProperty, documentString, renderDocumentJson } from '../shared/document-json.ts';
import { manifestLocatorSchema } from '../shared/manifest-diff-protocol.ts';
import type { ManifestLocator } from '../shared/manifest-diff-protocol.ts';
import { analyseManifestBundle } from './manifest-bundle.ts';
export const applyFileMaxDocuments = 16;
export const applyFileDocumentBytes = 1_048_576;
export type ApplyFileDocument = { readonly index: number; readonly text: string; readonly locator: ManifestLocator }; // digests are computed by the service-side callers

function splitApiVersion(apiVersion: string): { group: string; version: string } {
  const parts = apiVersion.split('/');
  if (parts.length < 1 || parts.length > 2 || parts.some(part => !part)) throw new BoundaryError('CONTENT_INVALID');
  return { group: parts.length === 1 ? '' : parts[0] ?? '', version: parts.at(-1) ?? '' };
}
function locatorOf(apiVersion: string, kind: string, name: string | undefined, namespace: string | undefined): ManifestLocator {
  if (!name) throw new BoundaryError('CONTENT_INVALID'); // apply requires an explicit name; generateName is create-only
  const { group, version } = splitApiVersion(apiVersion);
  const parsed = manifestLocatorSchema.safeParse({ group, version, kind, name, ...(namespace !== undefined ? { namespace } : {}) });
  if (!parsed.success) throw new BoundaryError('CONTENT_INVALID');
  return parsed.data;
}
// One workspace file → ≤16 strict documents. A single JSON `<Kind>List` wrapper (typed List)
// expands its `items` array into individual documents; YAML List wrappers, nested Lists, empty
// files and >16 documents are explicit rejections. Every document keeps its exact text and a
// SHA-256 identity digest so the G4 confirmation pins the exact applied bytes.
export function readApplyFileDocuments(text: string, format: 'yaml' | 'json'): readonly ApplyFileDocument[] {
  const bundle = analyseManifestBundle(text, format, { strictNamespace: false });
  const nonEmpty = bundle.documents.filter(document => document.shape !== 'empty');
  if (!nonEmpty.length) throw new BoundaryError('CONTENT_INVALID');
  const documents: ApplyFileDocument[] = [];
  const push = (candidate: { text: string; apiVersion: string; kind: string; name?: string | undefined; namespace?: string | undefined }) => {
    if (documents.length >= applyFileMaxDocuments) throw new BoundaryError('BUDGET_EXCEEDED');
    const bytes = Buffer.byteLength(candidate.text);
    if (!bytes || bytes > applyFileDocumentBytes) throw new BoundaryError('BUDGET_EXCEEDED');
    documents.push(Object.freeze({ index: documents.length, text: candidate.text,
      locator: locatorOf(candidate.apiVersion, candidate.kind, candidate.name, candidate.namespace) }));
  };
  for (const document of nonEmpty) {
    const slice = text.slice(document.start, document.end);
    if (document.kind?.endsWith('List')) {
      if (format !== 'json') throw new BoundaryError('CONTENT_INVALID'); // YAML List expansion is a fixed rejection, never a silent partial apply.
      const items = documentProperty(parseDocumentJson(slice), 'items');
      if (items?.kind !== 'array' || !items.items.length) throw new BoundaryError('CONTENT_INVALID');
      for (const item of items.items) {
        const apiVersion = documentString(documentProperty(item, 'apiVersion')), kind = documentString(documentProperty(item, 'kind'));
        const metadata = documentProperty(item, 'metadata');
        if (!apiVersion || !kind || kind.endsWith('List')) throw new BoundaryError('CONTENT_INVALID'); // nested Lists never expand
        push({ text: renderDocumentJson(item, 'json', applyFileDocumentBytes), apiVersion, kind,
          name: documentString(documentProperty(metadata, 'name')), namespace: documentString(documentProperty(metadata, 'namespace')) });
      }
    } else push({ text: slice, apiVersion: document.apiVersion ?? '', kind: document.kind ?? '', name: document.name, namespace: document.namespace });
  }
  return Object.freeze(documents);
}
export { documentBytes };
