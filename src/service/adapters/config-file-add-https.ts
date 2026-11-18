// Actual WRITE transport for ConfigMap/Secret data-key add. Never imported/constructed/invoked by automatic tests.
// Pinned upstream addKubernetesConfigFile: ConfigMap stores the file TEXT, Secret stores BASE64;
// the parent is fetched, the key set, and the whole object PUT once (kubectl replace -f -).
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';
import { documentProperty, documentString, parseDocumentJson, renderDocumentJson } from '../../shared/document-json.ts';
import type { JsonToken } from '../../shared/document-json.ts';
import { configFileAddParametersSchema } from '../../shared/config-file-add-protocol.ts';
import type { ConfigFileAddParameters } from '../../shared/config-file-add-protocol.ts';
import { resourceObjectPath } from '../queries/parent-resource.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { onceRequest } from './https-once.ts';
import { directConnection } from './manifest-apply-https.ts';
export type ConfigFileAddDispatch = { readonly target: import('../../shared/identity.ts').TargetIdentity; readonly selection: import('../../shared/configuration.ts').ConfigSelection; readonly parameters: ConfigFileAddParameters; readonly value: string; readonly notAfter: number };
export type ConfigFileAddResult = { readonly outcome: 'accepted' | 'rejected' | 'not-submitted' | 'unknown'; readonly code?: ErrorCode };
const object = (node: JsonToken | undefined) => { if (node?.kind !== 'object') throw new BoundaryError('CONTENT_INVALID'); return node; };
const stringEntries = (node: JsonToken | undefined): readonly (readonly [string, JsonToken])[] => {
  if (node === undefined || node.kind === 'atom' && node.text === 'null') return [];
  const value = object(node); if (value.entries.some(([, entry]) => entry.kind !== 'string')) throw new BoundaryError('CONTENT_INVALID'); return value.entries;
};
export function encodeConfigFileValue(kind: 'ConfigMap' | 'Secret', text: string): string {
  // Upstream: ConfigMap keeps the decoded text; Secret stores standard base64 (no whitespace).
  return kind === 'ConfigMap' ? text : Buffer.from(text, 'utf8').toString('base64');
}
export function buildKeyAddedObject(parentRaw: string, parameters: ConfigFileAddParameters, value: string): Buffer {
  const parsed = configFileAddParametersSchema.parse(parameters), reference = parsed.reference;
  const body = parseDocumentJson(parentRaw), metadata = object(documentProperty(body, 'metadata'));
  if (documentString(documentProperty(body, 'apiVersion')) !== 'v1' || documentString(documentProperty(body, 'kind')) !== reference.type.kind
    || documentString(documentProperty(metadata, 'name')) !== reference.name || documentString(documentProperty(metadata, 'uid')) !== reference.uid
    || documentString(documentProperty(metadata, 'resourceVersion')) !== reference.resourceVersion
    || documentString(documentProperty(metadata, 'namespace')) !== reference.namespace) throw new BoundaryError('STALE_TARGET');
  const encoded = encodeConfigFileValue(reference.type.kind === 'Secret' ? 'Secret' : 'ConfigMap', value);
  const existing = stringEntries(documentProperty(body, 'data')); // An existing key is overwritten by the user's explicit confirm (the upstream per-key warning).
  const merged: readonly (readonly [string, JsonToken])[] = [...existing.filter(([key]) => key !== parsed.key).map(([key, entry]) => [key, entry] as const), [parsed.key, { kind: 'string', value: encoded }] as const]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const bodyObject = object(body); // binaryData and every other field pass through untouched; only data gains the key.
  const mutated: JsonToken = { kind: 'object', entries: bodyObject.entries.map(([key, entry]) => key === 'data' ? ([key, { kind: 'object', entries: merged }] as const) : ([key, entry] as const)) };
  const text = renderDocumentJson(mutated, 'json', 1_048_576), check = object(parseDocumentJson(text)), checkData = stringEntries(documentProperty(check, 'data'));
  if (checkData.find(([key]) => key === parsed.key)?.[1].kind !== 'string' || documentString(checkData.find(([key]) => key === parsed.key)?.[1]) !== encoded
    || checkData.length !== merged.length || documentString(documentProperty(object(documentProperty(check, 'metadata')), 'resourceVersion')) !== reference.resourceVersion) throw new BoundaryError('CONFLICT');
  return Buffer.from(text);
}
export function createConfigFileAddHttpsAdapter(config: ReturnType<typeof createConfigReader>) {
  return async (request: ConfigFileAddDispatch, beforeDispatch: () => void, signal: AbortSignal): Promise<ConfigFileAddResult> => {
    const parameters = configFileAddParametersSchema.parse(request.parameters);
    if (parameters.reference.namespace === undefined) throw new BoundaryError('STALE_TARGET');
    const namespace = parameters.reference.namespace;
    const transport = await directConnection(config, request, signal);
    const path = resourceObjectPath(parameters.reference.type, parameters.reference.name, namespace);
    let body: Buffer | undefined, dispatched = false;
    try {
      const current = await onceRequest<string | undefined>(transport, new URL(path, transport.server), 'GET', 'application/json', 200, undefined, signal, undefined, () => undefined,
        (_value, raw) => { try { const metadata = object(documentProperty(parseDocumentJson(raw), 'metadata')); return documentString(documentProperty(metadata, 'uid')) === parameters.reference.uid && documentString(documentProperty(metadata, 'resourceVersion')) === parameters.reference.resourceVersion ? raw : undefined; } catch { return undefined; } });
      if (current === undefined) throw new BoundaryError('NOT_FOUND'); // 404 or a same-name replacement: fixed rejection, never a silent add.
      const built = buildKeyAddedObject(current, parameters, request.value);
      body = built;
      await beforeDispatch();
      if (signal.aborted || Date.now() >= request.notAfter) throw new BoundaryError('CONFIRMATION_EXPIRED');
      dispatched = true;
      const added = await onceRequest<boolean>(transport, new URL(path, transport.server), 'PUT', 'application/json', 200, body, signal, false, () => false, (_value, raw) => {
        try { const value = parseDocumentJson(raw), metadata = object(documentProperty(value, 'metadata')), rv = documentString(documentProperty(metadata, 'resourceVersion'));
          const entry = stringEntries(documentProperty(value, 'data')).find(([key]) => key === parameters.key)?.[1];
          return documentString(documentProperty(value, 'kind')) === parameters.reference.type.kind && documentString(documentProperty(metadata, 'name')) === parameters.reference.name
            && documentString(documentProperty(metadata, 'uid')) === parameters.reference.uid
            && !!rv && boundedName.safeParse(rv).success && rv !== parameters.reference.resourceVersion
            && entry?.kind === 'string' && entry.value === encodeConfigFileValue(parameters.reference.type.kind === 'Secret' ? 'Secret' : 'ConfigMap', request.value); } catch { return false; }
      });
      return added ? { outcome: 'accepted' } : { outcome: 'unknown', code: 'OPERATION_UNKNOWN' };
    } catch (error) {
      if (error instanceof BoundaryError && ['CONFLICT', 'NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED', 'CONTENT_INVALID', 'CONFIRMATION_EXPIRED'].includes(error.code) && !dispatched) return { outcome: 'rejected', code: error.code };
      return { outcome: dispatched ? 'unknown' : 'not-submitted', code: dispatched ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' };
    } finally { body?.fill(0); transport.ca?.fill(0); }
  };
}
