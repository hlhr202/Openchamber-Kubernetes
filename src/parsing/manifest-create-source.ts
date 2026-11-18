import { BoundaryError } from '../shared/errors.ts';
import { documentProperty, documentString, renderDocumentJson } from '../shared/document-json.ts';
import type { JsonToken } from '../shared/document-json.ts';
import { inspectCreateObject, manifestCreateBytes, readCreatePayload } from '../shared/manifest-create-payload.ts';
import { parseManifestValues } from './manifest-values.ts';
// Portable pure syntax conversion. It cannot prepare/confirm/upload or dispatch an operation.
export function encodeCreateSource(text: string, format: 'yaml' | 'json', selection?: { start: number; end: number }): string {
  const nodes: JsonToken[] = [];
  function append(node: JsonToken, depth: number) {
    if (depth > 4) throw new BoundaryError('BUDGET_EXCEEDED');
    if (documentString(documentProperty(node, 'kind')) === 'List' && documentString(documentProperty(node, 'apiVersion')) === 'v1') {
      const items = documentProperty(node, 'items'); if (items?.kind !== 'array' || !items.items.length) throw new BoundaryError('CONTENT_INVALID');
      for (const item of items.items) append(item, depth + 1); return;
    }
    if (nodes.length >= 32) throw new BoundaryError('BUDGET_EXCEEDED'); inspectCreateObject(node); nodes.push(node);
  }
  for (const node of parseManifestValues(text, format, selection)) append(node, 0);
  const envelope: JsonToken = { kind: 'object', entries: [['documents', { kind: 'array', items: nodes }]] };
  const result = renderDocumentJson(envelope, 'json', manifestCreateBytes); readCreatePayload(result); return result;
}
