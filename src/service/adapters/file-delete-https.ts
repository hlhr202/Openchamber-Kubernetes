// Actual WRITE transport for file-based delete. Never imported/constructed/invoked by automatic tests.
// One pinned-UID/RV DELETE with DeleteOptions preconditions (uid/resourceVersion) and Background
// propagation — the E002 delete semantics, dispatched directly instead of via `delete -f` (no bare-name delete).
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';
import { documentProperty, documentString, parseDocumentJson, renderDocumentJson } from '../../shared/document-json.ts';
import { fileDeleteParametersSchema } from '../../shared/file-delete-protocol.ts';
import type { FileDeleteParameters } from '../../shared/file-delete-protocol.ts';
import { documentReferenceSchema } from '../../shared/document-protocol.ts';
import type { DocumentReference } from '../../shared/document-protocol.ts';
import { resourceDescriptors } from '../../shared/tree.ts';
import { resourceObjectPath } from '../queries/parent-resource.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { onceRequest } from './https-once.ts';
import { directConnection } from './manifest-apply-https.ts';
export type FileDeleteDispatch = { readonly target: import('../../shared/identity.ts').TargetIdentity; readonly selection: import('../../shared/configuration.ts').ConfigSelection; readonly parameters: FileDeleteParameters; readonly reference: DocumentReference; readonly notAfter: number };
export type FileDeleteResult = { readonly outcome: 'accepted' | 'rejected' | 'not-submitted' | 'unknown'; readonly code?: ErrorCode };
const object = (node: import('../../shared/document-json.ts').JsonToken | undefined) => { if (node?.kind !== 'object') throw new BoundaryError('CONTENT_INVALID'); return node; };
const apiVersion = z.string().regex(/^(?:[a-z0-9.-]+\/)?v[a-z0-9.-]+$/);
// Resolve the file's single document to an exact descriptor reference: name required, namespace
// defaults to the target namespace exactly like `delete -f` (cluster-scoped kinds reject a namespace).
export function resolveFileDeleteReference(text: string, target: import('../../shared/identity.ts').TargetIdentity): DocumentReference {
  const documents = text.split(/^---$/m).map(part => part.trim()).filter(Boolean);
  if (documents.length !== 1) throw new BoundaryError('CONTENT_INVALID'); // Single-document narrow entry.
  const value = parseDocumentJson(documents[0] ?? ''), metadata = object(documentProperty(value, 'metadata'));
  const rawApiVersion = documentString(documentProperty(value, 'apiVersion')) ?? '', parts = rawApiVersion.split('/');
  const group = parts.length === 2 ? (parts[0] ?? '') : '', version = parts.length === 2 ? (parts[1] ?? '') : parts[0] ?? '';
  const kind = documentString(documentProperty(value, 'kind'));
  if (!apiVersion.safeParse(rawApiVersion).success || !version || !kind) throw new BoundaryError('CONTENT_INVALID');
  const namespaceNode = documentProperty(metadata, 'namespace'), namespace = documentString(namespaceNode);
  if (namespaceNode !== undefined && namespace === undefined) throw new BoundaryError('CONTENT_INVALID');
  // Only the exact descriptor plane is deletable this way; an ambiguous or unknown kind is a fixed failure.
  const matches = Object.values(resourceDescriptors).filter(type => type.kind === kind && type.group === group);
  if (matches.length !== 1) throw new BoundaryError('RESOURCE_INVALID');
  const type = matches[0];
  if (!type || type.version !== version) throw new BoundaryError('RESOURCE_INVALID'); // no served-version guessing
  const name = documentString(documentProperty(metadata, 'name'));
  if (!name) throw new BoundaryError('CONTENT_INVALID');
  const resolvedType = type; // narrowed: exactly one descriptor kind/group match
  const reference = { type: resolvedType, name, ...(resolvedType.scope === 'namespace' ? { namespace: namespace ?? target.namespace } : {}) };
  return documentReferenceSchema.parse(reference); // rejects cluster/namespace mismatches and non-descriptor kinds
}
export function buildDeleteOptionsBody(reference: DocumentReference): Buffer {
  const body = renderDocumentJson({ kind: 'object', entries: [
    ['apiVersion', { kind: 'string', value: 'v1' }], ['kind', { kind: 'string', value: 'DeleteOptions' }],
    ['preconditions', { kind: 'object', entries: [['uid', { kind: 'string', value: reference.uid }], ['resourceVersion', { kind: 'string', value: reference.resourceVersion }]] }],
    ['propagationPolicy', { kind: 'string', value: 'Background' }]] }, 'json', 65_536);
  const check = object(parseDocumentJson(body));
  if (documentString(documentProperty(check, 'kind')) !== 'DeleteOptions'
    || documentString(documentProperty(object(documentProperty(check, 'preconditions')), 'uid')) !== reference.uid
    || documentString(documentProperty(object(documentProperty(check, 'preconditions')), 'resourceVersion')) !== reference.resourceVersion) throw new BoundaryError('CONFLICT');
  return Buffer.from(body);
}
export function createFileDeleteHttpsAdapter(config: ReturnType<typeof createConfigReader>) {
  return async (request: FileDeleteDispatch, beforeDispatch: () => void, signal: AbortSignal): Promise<FileDeleteResult> => {
    fileDeleteParametersSchema.parse(request.parameters);
    const reference = request.reference;
    if (reference.namespace === undefined && reference.type.scope === 'namespace') throw new BoundaryError('STALE_TARGET');
    const transport = await directConnection(config, request, signal);
    const path = resourceObjectPath(reference.type, reference.name, reference.namespace);
    let body: Buffer | undefined, dispatched = false;
    try {
      // The GET half of the pin: the live object must still be the exact UID/RV the confirmation bound.
      const current = await onceRequest<string | undefined>(transport, new URL(path, transport.server), 'GET', 'application/json', 200, undefined, signal, undefined, () => undefined,
        (_value, raw) => { try { const metadata = object(documentProperty(parseDocumentJson(raw), 'metadata')); return documentString(documentProperty(metadata, 'uid')) === reference.uid && documentString(documentProperty(metadata, 'resourceVersion')) === reference.resourceVersion ? raw : undefined; } catch { return undefined; } });
      if (current === undefined) throw new BoundaryError('NOT_FOUND'); // 404 or a same-name replacement: fixed rejection, never a bare-name delete.
      body = buildDeleteOptionsBody(reference);
      await beforeDispatch();
      if (signal.aborted || Date.now() >= request.notAfter) throw new BoundaryError('CONFIRMATION_EXPIRED');
      dispatched = true;
      const deleted = await onceRequest<boolean>(transport, new URL(path, transport.server), 'DELETE', 'application/json', 200, body, signal, false, () => false, (_value, raw) => {
        try { const value = parseDocumentJson(raw), kind = documentString(documentProperty(value, 'kind'));
          // The API answers with the deleted object or a Status; both end the exact pinned object.
          if (kind === 'Status') return documentString(documentProperty(value, 'status')) === 'Success';
          const metadata = object(documentProperty(value, 'metadata')), uid = documentString(documentProperty(metadata, 'uid')), name = documentString(documentProperty(metadata, 'name'));
          return !!uid && boundedName.safeParse(uid).success && name === reference.name; } catch { return false; }
      });
      return deleted ? { outcome: 'accepted' } : { outcome: 'unknown', code: 'OPERATION_UNKNOWN' };
    } catch (error) {
      if (error instanceof BoundaryError && ['CONFLICT', 'NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED', 'CONTENT_INVALID', 'CONFIRMATION_EXPIRED'].includes(error.code) && !dispatched) return { outcome: 'rejected', code: error.code };
      return { outcome: dispatched ? 'unknown' : 'not-submitted', code: dispatched ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' };
    } finally { body?.fill(0); transport.ca?.fill(0); }
  };
}
