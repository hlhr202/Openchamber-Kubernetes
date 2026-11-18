import { BoundaryError } from '../../shared/errors.ts';
import { documentBytes, documentReferenceSchema } from '../../shared/document-protocol.ts';
import type { DocumentReference } from '../../shared/document-protocol.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { documentProperty, documentString, parseDocumentJson, renderDocumentJson } from '../../shared/document-json.ts';
import { resourceObjectPath } from './parent-resource.ts';

export function planResourceDocument(input: unknown, target: TargetIdentity) {
  const parsed = documentReferenceSchema.safeParse(input);
  if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
  const reference = parsed.data;
  if (reference.type.scope === 'namespace' && reference.type.resource !== 'pods' && reference.namespace !== target.namespace) throw new BoundaryError('STALE_TARGET');
  return { reference, path: resourceObjectPath(reference.type, reference.name, reference.namespace) };
}
export function projectResourceDocument(text: string, reference: DocumentReference, format: 'json' | 'yaml') {
  const node = parseDocumentJson(text), metadata = documentProperty(node, 'metadata');
  const expectedVersion = reference.type.group ? `${reference.type.group}/${reference.type.version}` : reference.type.version;
  if (node.kind !== 'object' || metadata?.kind !== 'object') throw new BoundaryError('CONTENT_INVALID');
  if (documentString(documentProperty(node, 'apiVersion')) !== expectedVersion || documentString(documentProperty(node, 'kind')) !== reference.type.kind
    || documentString(documentProperty(metadata, 'name')) !== reference.name || documentString(documentProperty(metadata, 'uid')) !== reference.uid
    || documentString(documentProperty(metadata, 'resourceVersion')) !== reference.resourceVersion
    || (reference.namespace === undefined ? documentProperty(metadata, 'namespace') !== undefined : documentString(documentProperty(metadata, 'namespace')) !== reference.namespace)) throw new BoundaryError('STALE_TARGET');
  // Match normal get output's managedFields omission, without turning int64/decimals into JS Number.
  const projected = { ...node, entries: node.entries.map(([key, value]) => [key, key === 'metadata' ? { ...metadata, entries: metadata.entries.filter(([key]) => key !== 'managedFields') } : value] as const) };
  const output = renderDocumentJson(projected, format, documentBytes);
  return { text: output, bytes: Buffer.byteLength(output) };
}
