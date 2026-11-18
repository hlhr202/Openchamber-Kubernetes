import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { BoundaryError } from '../shared/errors.ts';
import { documentBytes } from '../shared/document-protocol.ts';
import { hasWellFormedUnicode, sameTarget, utf8ByteLength } from '../shared/identity.ts';
import type { ResourceType } from '../shared/identity.ts';
import { explainField, explainRequestSchema } from '../shared/explain-protocol.ts';
import type { DocumentState } from './document-client.ts';
import { bufferDocumentText } from '../shared/document-buffer.ts';
import { documentReferenceId, loadDocumentReferenceSchema } from '../shared/document-protocol.ts';

export type DocumentField = { id: string; label: string; path: string[] };
// Local-only AST walk: exposes field names/path, never scalar values. No toJS, alias expansion, callbacks, I/O or evaluation.
export function documentFields(text: string, type: ResourceType): DocumentField[] {
  if (!hasWellFormedUnicode(text)) throw new BoundaryError('CONTENT_INVALID');
  if (utf8ByteLength(text) > documentBytes) throw new BoundaryError('BUDGET_EXCEEDED');
  let doc: ReturnType<typeof parseDocument>;
  try { doc = parseDocument(text, { uniqueKeys: true, strict: true }); } catch { throw new BoundaryError('CONTENT_INVALID'); }
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) throw new BoundaryError('CONTENT_INVALID');
  const root = doc.contents;
  const string = (key: string) => { const pair = root.items.find(pair => isScalar(pair.key) && pair.key.value === key); return pair && isScalar(pair.value) ? pair.value.value : undefined; };
  if (string('kind') !== type.kind || string('apiVersion') !== (type.group ? `${type.group}/${type.version}` : type.version)) throw new BoundaryError('CONTENT_INVALID');
  const fields: DocumentField[] = [{ id: '0', label: `(${type.kind})`, path: [] }]; let count = 0;
  const stack: Array<{ node: unknown; path: string[]; label: string; depth: number }> = [{ node: root, path: [], label: '$', depth: 0 }];
  while (stack.length) {
    const item = stack.pop(); if (!item) break;
    if (++count > 20_000 || item.depth > 32) throw new BoundaryError('BUDGET_EXCEEDED');
    if (isAlias(item.node) || (item.node && typeof item.node === 'object' && 'tag' in item.node && item.node.tag)) throw new BoundaryError('CONTENT_INVALID');
    if (isMap(item.node)) {
      for (const pair of item.node.items) {
        if (!isScalar(pair.key) || !explainField.safeParse(pair.key.value).success || typeof pair.key.value !== 'string') throw new BoundaryError('CONTENT_INVALID');
        const path = [...item.path, pair.key.value], label = `${item.label}[${JSON.stringify(pair.key.value)}]`;
        if (fields.length >= 2000 || label.length > 2048 || path.length > 32) throw new BoundaryError('BUDGET_EXCEEDED');
        fields.push({ id: String(fields.length), label, path }); stack.push({ node: pair.value, path, label, depth: item.depth + 1 });
      }
    } else if (isSeq(item.node)) {
      if (stack.length + item.node.items.length + count > 20_000) throw new BoundaryError('BUDGET_EXCEEDED');
      for (let index = 0; index < item.node.items.length; index++) stack.push({ node: item.node.items[index], path: item.path, label: `${item.label}[${index}]`, depth: item.depth + 1 });
    }
  }
  return fields;
}
export function explanationRequest(state: DocumentState, fieldId: string, revision: number) {
  if (state.phase !== 'ready' || state.stale || !state.complete || !state.editor || !state.page || !state.source) throw new BoundaryError('CONTENT_INVALID');
  if (!loadDocumentReferenceSchema.safeParse(state.source.reference).success) throw new BoundaryError('CONTENT_INVALID');
  if (documentReferenceId(state.source.reference) !== documentReferenceId(state.page.reference) || documentReferenceId(state.source.reference) !== documentReferenceId(state.editor.origin.reference)
    || !sameTarget(state.source.target, state.page.target) || !sameTarget(state.source.target, state.editor.origin.target)) throw new BoundaryError('STALE_TARGET');
  if (revision !== state.editor.revision) throw new BoundaryError('STALE_TARGET');
   const field = documentFields(bufferDocumentText(state.editor), state.source.reference.type).find(field => field.id === fieldId); if (!field) throw new BoundaryError('INVALID_INPUT');
  return explainRequestSchema.parse({ protocol: 2, target: state.source.target, selection: state.source.selection, type: state.source.reference.type,
    ...('definition' in state.source.reference ? { definition: state.source.reference.definition } : {}),
    fieldPath: field.path, documentIdentity: state.page.contentIdentity, revision }); // NO document text/values leave this local helper.
}
