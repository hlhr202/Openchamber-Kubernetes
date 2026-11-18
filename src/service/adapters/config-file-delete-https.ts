// Actual WRITE transport for ConfigMap/Secret data-key deletion. Never imported/constructed/invoked by automatic tests.
// Pinned upstream removeKey semantics: exactly ONE key removed from the data map; the parent object, every other
// key and the pinned RV are preserved and the whole object is PUT once (kubectl replace -f -).
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';
import { documentProperty, documentString, parseDocumentJson, renderDocumentJson } from '../../shared/document-json.ts';
import type { JsonToken } from '../../shared/document-json.ts';
import { configFileDeleteParametersSchema } from '../../shared/config-file-protocol.ts';
import type { ConfigFileDeleteParameters } from '../../shared/config-file-protocol.ts';
import { resourceObjectPath } from '../queries/parent-resource.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { onceRequest } from './https-once.ts';
import { directConnection } from './manifest-apply-https.ts';
export type ConfigFileDeleteDispatch = { readonly target: import('../../shared/identity.ts').TargetIdentity; readonly selection: import('../../shared/configuration.ts').ConfigSelection; readonly parameters: ConfigFileDeleteParameters; readonly notAfter: number };
export type ConfigFileDeleteResult = { readonly outcome: 'accepted' | 'rejected' | 'not-submitted' | 'unknown'; readonly code?: ErrorCode };
const object = (node: JsonToken | undefined) => { if (node?.kind !== 'object') throw new BoundaryError('CONTENT_INVALID'); return node; };
const stringEntries = (node: JsonToken | undefined): readonly (readonly [string, JsonToken])[] => {
  if (node === undefined || node.kind === 'atom' && node.text === 'null') return [];
  const value = object(node); if (value.entries.some(([, entry]) => entry.kind !== 'string')) throw new BoundaryError('CONTENT_INVALID'); return value.entries;
};
export function buildKeyDeletedObject(parentRaw: string, parameters: ConfigFileDeleteParameters): Buffer {
  const parsed = configFileDeleteParametersSchema.parse(parameters), reference = parsed.reference;
  const body = parseDocumentJson(parentRaw), metadata = object(documentProperty(body, 'metadata'));
  if (documentString(documentProperty(body, 'apiVersion')) !== 'v1' || documentString(documentProperty(body, 'kind')) !== reference.type.kind
    || documentString(documentProperty(metadata, 'name')) !== reference.name || documentString(documentProperty(metadata, 'uid')) !== reference.uid
    || documentString(documentProperty(metadata, 'resourceVersion')) !== reference.resourceVersion
    || documentString(documentProperty(metadata, 'namespace')) !== reference.namespace) throw new BoundaryError('STALE_TARGET');
  const data = documentProperty(body, 'data'), entries = stringEntries(data);
  if (!entries.some(([key]) => key === parsed.key)) throw new BoundaryError('NOT_FOUND'); // A vanished key is a fixed failure, never an empty success.
  const kept = entries.filter(([key]) => key !== parsed.key);
  const bodyObject = object(body); // binaryData and every other field pass through untouched; only data is filtered.
  const mutated: JsonToken = { kind: 'object', entries: bodyObject.entries.map(([key, value]) => key === 'data' ? ([key, { kind: 'object', entries: kept }] as const) : ([key, value] as const)) };
  const text = renderDocumentJson(mutated, 'json', 1_048_576), check = object(parseDocumentJson(text)), checkData = documentProperty(check, 'data');
  if (stringEntries(checkData).some(([key]) => key === parsed.key) || kept.length !== stringEntries(checkData).length
    || documentString(documentProperty(object(documentProperty(check, 'metadata')), 'resourceVersion')) !== reference.resourceVersion) throw new BoundaryError('CONFLICT');
  return Buffer.from(text);
}
export function createConfigFileDeleteHttpsAdapter(config: ReturnType<typeof createConfigReader>) {
  return async (request: ConfigFileDeleteDispatch, beforeDispatch: () => void, signal: AbortSignal): Promise<ConfigFileDeleteResult> => {
    const parameters = configFileDeleteParametersSchema.parse(request.parameters);
    if (parameters.reference.namespace === undefined) throw new BoundaryError('STALE_TARGET');
    const namespace = parameters.reference.namespace;
    const transport = await directConnection(config, request, signal);
    const path = resourceObjectPath(parameters.reference.type, parameters.reference.name, namespace);
    let body: Buffer | undefined, dispatched = false;
    try {
      const current = await onceRequest<string | undefined>(transport, new URL(path, transport.server), 'GET', 'application/json', 200, undefined, signal, undefined, () => undefined,
        (_value, raw) => { try { const metadata = object(documentProperty(parseDocumentJson(raw), 'metadata')); return documentString(documentProperty(metadata, 'uid')) === parameters.reference.uid && documentString(documentProperty(metadata, 'resourceVersion')) === parameters.reference.resourceVersion ? raw : undefined; } catch { return undefined; } });
      if (current === undefined) throw new BoundaryError('NOT_FOUND'); // 404 or a same-name replacement: fixed rejection, never a key delete.
      body = buildKeyDeletedObject(current, parameters);
      await beforeDispatch();
      if (signal.aborted || Date.now() >= request.notAfter) throw new BoundaryError('CONFIRMATION_EXPIRED');
      dispatched = true;
      const deleted = await onceRequest<boolean>(transport, new URL(path, transport.server), 'PUT', 'application/json', 200, body, signal, false, () => false, (_value, raw) => {
        try { const value = parseDocumentJson(raw), metadata = object(documentProperty(value, 'metadata')), rv = documentString(documentProperty(metadata, 'resourceVersion'));
          const keys = stringEntries(documentProperty(value, 'data'));
          return documentString(documentProperty(value, 'kind')) === parameters.reference.type.kind && documentString(documentProperty(metadata, 'name')) === parameters.reference.name
            && documentString(documentProperty(metadata, 'uid')) === parameters.reference.uid
            && !!rv && boundedName.safeParse(rv).success && rv !== parameters.reference.resourceVersion
            && !keys.some(([key]) => key === parameters.key); } catch { return false; }
      });
      return deleted ? { outcome: 'accepted' } : { outcome: 'unknown', code: 'OPERATION_UNKNOWN' };
    } catch (error) {
      if (error instanceof BoundaryError && ['CONFLICT', 'NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED', 'CONTENT_INVALID', 'CONFIRMATION_EXPIRED'].includes(error.code) && !dispatched) return { outcome: 'rejected', code: error.code };
      return { outcome: dispatched ? 'unknown' : 'not-submitted', code: dispatched ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' };
    } finally { body?.fill(0); transport.ca?.fill(0); }
  };
}
