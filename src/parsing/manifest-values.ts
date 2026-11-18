import { Composer, Parser, isMap, isScalar, isSeq } from 'yaml';
import { BoundaryError } from '../shared/errors.ts';
import { hasWellFormedUnicode, utf8ByteLength } from '../shared/identity.ts';
import { parseDocumentJson } from '../shared/document-json.ts';
import type { JsonToken } from '../shared/document-json.ts';
import { analyseManifestBundle } from './manifest-bundle.ts';
// Pure lossless value parsing, shared by local comparisons and explicit Create source encoding.
// No execution plan, callbacks, grant, transport, SDK, file access or import-time effects.
export function parseManifestValues(text: string, format: 'yaml' | 'json', selection?: { start: number; end: number }): readonly JsonToken[] {
  if (!hasWellFormedUnicode(text) || text.includes('\0') || utf8ByteLength(text) > 1_048_576) throw new BoundaryError('CONTENT_INVALID');
  if (selection) {
    if (!Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end) || selection.start < 0 || selection.end <= selection.start || selection.end > text.length) throw new BoundaryError('INVALID_INPUT');
    text = text.slice(selection.start, selection.end); if (!hasWellFormedUnicode(text)) throw new BoundaryError('CONTENT_INVALID');
  }
  analyseManifestBundle(text, format, { strictNamespace: true });
  if (format === 'json') return [parseDocumentJson(text)];
  const values: JsonToken[] = []; let count = 0;
  function convert(node: unknown, depth: number): JsonToken {
    if (++count > 20_000 || depth > 32) throw new BoundaryError('BUDGET_EXCEEDED');
    if (isMap(node)) return { kind: 'object', entries: node.items.map(pair => {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new BoundaryError('CONTENT_INVALID'); return [pair.key.value, convert(pair.value, depth + 1)] as const;
    }) };
    if (isSeq(node)) return { kind: 'array', items: node.items.map(item => convert(item, depth + 1)) };
    if (node === null) return { kind: 'atom', text: 'null' };
    if (!isScalar(node)) throw new BoundaryError('CONTENT_INVALID');
    if (typeof node.value === 'string') return { kind: 'string', value: node.value };
    if (typeof node.value === 'boolean' || node.value === null) return { kind: 'atom', text: String(node.value) };
    if (typeof node.value === 'bigint' || typeof node.value === 'number') {
      const original = node.source ?? '', numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
      if (numeric.test(original)) return { kind: 'atom', text: original };
      if (typeof node.value === 'bigint') return { kind: 'atom', text: node.value.toString() };
      // Never serialize the rounded JS float. Normalize only known decimal YAML lexemes.
      let value = original.replace(/^\+/, '').replaceAll('_', '');
      value = value.replace(/^(-?)\./, '$10.').replace(/\.(?=[eE]|$)/, '.0').replace(/^(-?)0+(?=\d)/, '$1');
      if (!Number.isFinite(node.value) || !numeric.test(value)) throw new BoundaryError('CONTENT_INVALID'); return { kind: 'atom', text: value };
    }
    throw new BoundaryError('CONTENT_INVALID');
  }
  const composer = new Composer({ version: '1.2', strict: true, uniqueKeys: true, intAsBigInt: true, prettyErrors: false, logLevel: 'silent' });
  for (const document of composer.compose(new Parser().parse(text), true, text.length)) {
    if (document.contents === null || isScalar(document.contents) && document.contents.value === null && document.contents.source === '') continue;
    if (values.length >= 32) throw new BoundaryError('BUDGET_EXCEEDED'); values.push(convert(document.contents, 0));
  }
  return values;
}
