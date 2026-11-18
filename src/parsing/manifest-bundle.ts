import { Composer, Parser, isAlias, isMap, isScalar, isSeq } from 'yaml';
import { BoundaryError } from '../shared/errors.ts';
import { documentBytes } from '../shared/document-protocol.ts';
import { containsControlCharacters, hasWellFormedUnicode, utf8ByteLength } from '../shared/identity.ts';
import { parseDocumentJson } from '../shared/document-json.ts';
import { readManifestBundle } from '../shared/manifest-bundle.ts';
import type { ManifestBundle, ManifestDocument } from '../shared/manifest-bundle.ts';
// Portable pure syntax/AST inventory only. Not Apply validation, GVR resolution or an execution plan.
export function analyseManifestBundle(text: string, format: 'yaml' | 'json', options?: { readonly strictNamespace: boolean }): ManifestBundle {
  if (!hasWellFormedUnicode(text)) throw new BoundaryError('CONTENT_INVALID');
  if (utf8ByteLength(text) > documentBytes) throw new BoundaryError('BUDGET_EXCEEDED');
  if (format !== 'yaml' && format !== 'json') throw new BoundaryError('INVALID_INPUT');
  if (format === 'json') parseDocumentJson(text); // Strict JSON, decoded duplicate keys and numeric lexemes stay exact.
  const documents: ManifestDocument[] = []; let nodes = 0, previousEnd = 0;
  try {
    const composer = new Composer({ version: '1.2', uniqueKeys: true, strict: true, prettyErrors: false, intAsBigInt: true, logLevel: 'silent' });
    // Lazy composition stops at document 33; unlike parseAllDocuments it need not allocate the whole stream first.
    for (const doc of composer.compose(new Parser().parse(text), true, text.length)) {
      if (documents.length >= 32) throw new BoundaryError('BUDGET_EXCEEDED');
      if (doc.errors.length || doc.warnings.length || doc.directives?.yaml.version !== '1.2') throw new BoundaryError('CONTENT_INVALID');
      const [start, , end] = doc.range;
      if (start < previousEnd || start < 0 || end < start || end > text.length) throw new BoundaryError('CONTENT_INVALID'); previousEnd = end;
      const stack: Array<{ node: unknown; depth: number }> = [{ node: doc.contents, depth: 0 }];
      while (stack.length) {
        const item = stack.pop(); if (!item) break;
        if (++nodes > 20_000 || item.depth > 32) throw new BoundaryError('BUDGET_EXCEEDED');
        if (isAlias(item.node) || item.node && typeof item.node === 'object' && ('tag' in item.node && item.node.tag || 'anchor' in item.node && item.node.anchor)) throw new BoundaryError('CONTENT_INVALID');
        if (isMap(item.node)) for (const pair of item.node.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !hasWellFormedUnicode(pair.key.value) || containsControlCharacters(pair.key.value) || pair.key.value.length > 256) throw new BoundaryError('CONTENT_INVALID');
          stack.push({ node: pair.key, depth: item.depth + 1 }, { node: pair.value, depth: item.depth + 1 });
        }
        else if (isSeq(item.node)) for (const node of item.node.items) stack.push({ node, depth: item.depth + 1 });
        else if (isScalar(item.node) && typeof item.node.value === 'string' && !hasWellFormedUnicode(item.node.value)) throw new BoundaryError('CONTENT_INVALID');
        if (stack.length + nodes > 20_000) throw new BoundaryError('BUDGET_EXCEEDED');
      }
      const property = (node: unknown, key: string): unknown => isMap(node) ? node.items.find(pair => isScalar(pair.key) && pair.key.value === key)?.value : undefined;
      const scalar = (node: unknown) => isScalar(node) && typeof node.value === 'string' && node.value.length > 0 && node.value.length <= 1024 && !containsControlCharacters(node.value) ? node.value : undefined;
      const metadata = property(doc.contents, 'metadata'), apiVersion = scalar(property(doc.contents, 'apiVersion')), kind = scalar(property(doc.contents, 'kind')),
        name = scalar(property(metadata, 'name')), namespace = scalar(property(metadata, 'namespace'));
      // A present non-string/empty namespace must never become an omitted namespace/default-target read.
      if (options?.strictNamespace && isMap(metadata) && metadata.items.some(pair => isScalar(pair.key) && pair.key.value === 'namespace') && namespace === undefined) throw new BoundaryError('CONTENT_INVALID');
      const empty = doc.contents === null || isScalar(doc.contents) && doc.contents.value === null && doc.contents.source === '';
      documents.push(Object.freeze({ index: documents.length, start, end, shape: isMap(doc.contents) ? 'mapping' : isSeq(doc.contents) ? 'sequence' : empty ? 'empty' : 'scalar',
        ...(apiVersion ? { apiVersion } : {}), ...(kind ? { kind } : {}), ...(name ? { name } : {}), ...(namespace ? { namespace } : {}) }));
    }
  } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONTENT_INVALID'); }
  return readManifestBundle({ format, characters: text.length, documents });
}
