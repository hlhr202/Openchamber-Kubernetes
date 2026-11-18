import { BoundaryError } from '../shared/errors.ts';
import { analyseManifestBundle } from './manifest-bundle.ts';
import { manifestLocatorSchema } from '../shared/manifest-diff-protocol.ts';
import type { ManifestLocator } from '../shared/manifest-diff-protocol.ts';
import { hasWellFormedUnicode, utf8ByteLength } from '../shared/identity.ts';
export type LocalComparisonDocument = { readonly index: number; readonly text: string; readonly locator?: ManifestLocator };
// Pure local parsing only. No local body upload, file save, execution plan or GVR guess/pluralization.
export function localComparisonDocuments(text: string, format: 'yaml' | 'json', selection?: { start: number; end: number }): readonly LocalComparisonDocument[] {
  if (!hasWellFormedUnicode(text) || text.includes('\0') || utf8ByteLength(text) > 1_048_576) throw new BoundaryError('CONTENT_INVALID');
  if (selection) {
    if (!Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end) || selection.start < 0 || selection.end <= selection.start || selection.end > text.length) throw new BoundaryError('INVALID_INPUT');
    text = text.slice(selection.start, selection.end); if (!hasWellFormedUnicode(text)) throw new BoundaryError('CONTENT_INVALID');
  }
  if (!text.trim()) return [];
  const bundle = analyseManifestBundle(text, format, { strictNamespace: true });
  return bundle.documents.map((document, index) => {
    const parts = document.apiVersion?.split('/') ?? [], group = parts.length === 2 ? parts[0] : parts.length === 1 ? '' : undefined, version = parts.at(-1);
    const locator = manifestLocatorSchema.safeParse({ group, version, kind: document.kind, name: document.name, ...(document.namespace ? { namespace: document.namespace } : {}) });
    // AST node starts exclude leading comments/directives/BOM. Preserve every source byte by assigning
    // inter-document trivia to the following document, without reparsing or splitting on YAML markers.
    const start = index === 0 ? 0 : bundle.documents[index - 1]?.end ?? document.start;
    const end = index === bundle.documents.length - 1 ? text.length : document.end;
    return Object.freeze({ index: document.index, text: text.slice(start, end), ...(locator.success && document.shape === 'mapping' ? { locator: Object.freeze(locator.data) } : {}) });
  }).filter(document => bundle.documents[document.index]?.shape !== 'empty');
}
