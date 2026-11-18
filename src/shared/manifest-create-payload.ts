// Pure lossless JSON payload validation. No write controller, SDK, parser IO or execution plan.
import { BoundaryError } from './errors.ts';
import { dnsName } from './identity.ts';
import { documentProperty, documentString, parseDocumentJson, renderDocumentJson } from './document-json.ts';
import type { JsonToken } from './document-json.ts';
import { manifestLocatorSchema } from './manifest-diff-protocol.ts';
import type { ManifestLocator } from './manifest-diff-protocol.ts';
import { hasWellFormedUnicode, utf8ByteLength } from './identity.ts';
export const manifestCreateBytes = 1_048_576;
export type CreatePayloadItem = { readonly locator: ManifestLocator; readonly text: string; readonly generated?: true };
// Approved batch-2 upgrade: a document carries EITHER metadata.name (named create with a fresh
// by-name non-existence proof) OR metadata.generateName (POST to the collection; the server
// assigns the suffix, no by-name precheck exists and the generated name is backfilled from the
// API response). Both at once or neither is invalid, matching the API server's own rules.
function createNameShape(name: string | undefined, generateName: string | undefined): 'named' | 'generated' {
  if ((name === undefined) === (generateName === undefined)) throw new BoundaryError('CONTENT_INVALID');
  return name !== undefined ? 'named' : 'generated';
}
// Bounded disclosed constraint of this G4 chain: a generateName prefix must itself be a valid
// DNS name with room for the server suffix (final names stay <= 253); trailing-dash prefixes
// keep running through the human package's real kubectl instead.
export function inspectCreateObject(node: JsonToken): CreatePayloadItem {
  const metadata = documentProperty(node, 'metadata'), api = documentString(documentProperty(node, 'apiVersion'))?.split('/') ?? [];
  if (node.kind !== 'object' || metadata?.kind !== 'object' || api.length < 1 || api.length > 2
    || ['uid', 'resourceVersion', 'managedFields', 'deletionTimestamp'].some(key => documentProperty(metadata, key) !== undefined)) throw new BoundaryError('CONTENT_INVALID');
  const namespace = documentProperty(metadata, 'namespace'), kind = documentString(documentProperty(node, 'kind'));
  const name = documentString(documentProperty(metadata, 'name')), generateName = documentString(documentProperty(metadata, 'generateName'));
  const shape = createNameShape(name, generateName);
  if (kind === 'List' || kind?.endsWith('List')) throw new BoundaryError('CONTENT_INVALID'); // top-level List wrappers expand in readCreatePayload, never here
  // For a generated create the locator carries the PREFIX as its name; the created object's
  // final name (prefix + server suffix) is backfilled into the step result.
  const locatorParsed = manifestLocatorSchema.safeParse({ group: api.length === 1 ? '' : api[0], version: api.at(-1), kind,
    name: shape === 'named' ? name ?? '' : generateName ?? '', ...(namespace !== undefined ? { namespace: documentString(namespace) ?? null } : {}) });
  if (!locatorParsed.success) throw new BoundaryError('CONTENT_INVALID');
  const item: CreatePayloadItem = { locator: locatorParsed.data, text: renderDocumentJson(node, 'json', manifestCreateBytes) };
  return shape === 'generated' ? { ...item, generated: true } : item;
}
export function readCreatePayload(text: string): readonly CreatePayloadItem[] {
  if (!hasWellFormedUnicode(text) || text.includes('\0') || utf8ByteLength(text) > manifestCreateBytes) throw new BoundaryError('CONTENT_INVALID');
  const envelope = parseDocumentJson(text), documents = documentProperty(envelope, 'documents');
  if (envelope.kind !== 'object' || envelope.entries.length !== 1 || documents?.kind !== 'array' || !documents.items.length || documents.items.length > 32) throw new BoundaryError('CONTENT_INVALID');
  const items: CreatePayloadItem[] = [];
  // Approved batch-2 upgrade: ONE top-level typed List (PodList/ServiceList/DeploymentList/...)
  // expands its items array into individually validated documents; nested Lists and the generic
  // untyped List never expand (explicit CONTENT_INVALID, never a silent partial create).
  const expand = (item: JsonToken): void => {
    const kind = documentString(documentProperty(item, 'kind'));
    if (kind !== undefined && kind !== 'List' && kind.endsWith('List')) {
      const entries = documentProperty(item, 'items');
      if (entries?.kind !== 'array' || !entries.items.length) throw new BoundaryError('CONTENT_INVALID');
      for (const entry of entries.items) {
        const entryKind = documentString(documentProperty(entry, 'kind'));
        if (entryKind === undefined || entryKind.endsWith('List')) throw new BoundaryError('CONTENT_INVALID'); // nested List never expands
        items.push(inspectCreateObject(entry));
      }
      return;
    }
    items.push(inspectCreateObject(item));
  };
  for (const item of documents.items) expand(item);
  if (!items.length || items.length > 32) throw new BoundaryError('CONTENT_INVALID');
  return Object.freeze(items);
}
export const createPayloadDnsName = dnsName;
