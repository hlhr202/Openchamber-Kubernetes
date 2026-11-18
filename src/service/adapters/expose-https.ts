// Actual WRITE transport for Expose. Never imported, constructed or invoked by automatic functional tests.
// Pinned kubectl expose semantics: MapBasedSelectorForObject + PortsForObject derivation + createService
// (selector map, explicit-or-derived single port, TCP default, targetPort defaults to port), then ONE POST.
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';
import { documentProperty, documentString, parseDocumentJson, renderDocumentJson } from '../../shared/document-json.ts';
import type { JsonToken } from '../../shared/document-json.ts';
import { exposeParametersSchema } from '../../shared/expose-protocol.ts';
import type { ExposeParameters } from '../../shared/expose-protocol.ts';
import { resourceObjectPath } from '../queries/parent-resource.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { onceRequest } from './https-once.ts';
import { directConnection } from './manifest-apply-https.ts';
export type ExposeDispatch = { readonly target: import('../../shared/identity.ts').TargetIdentity; readonly selection: import('../../shared/configuration.ts').ConfigSelection; readonly parameters: ExposeParameters; readonly notAfter: number };
export type ExposeResult = { readonly outcome: 'accepted' | 'rejected' | 'not-submitted' | 'unknown'; readonly code?: ErrorCode };
const object = (node: JsonToken | undefined) => { if (node?.kind !== 'object') throw new BoundaryError('CONTENT_INVALID'); return node; };
const stringMap = (node: JsonToken | undefined): readonly (readonly [string, JsonToken])[] => {
  if (node === undefined || node.kind === 'atom' && node.text === 'null') return [];
  const value = object(node); if (value.entries.some(([, entry]) => entry.kind !== 'string')) throw new BoundaryError('CONTENT_INVALID'); return value.entries;
};
const selectorFrom = (node: JsonToken | undefined): readonly (readonly [string, JsonToken])[] => {
  const value = object(node), entries = stringEntries(value); if (!entries.length) throw new BoundaryError('CONTENT_INVALID'); return entries;
};
function stringEntries(value: JsonToken): readonly (readonly [string, JsonToken])[] { if (value.kind !== 'object') throw new BoundaryError('CONTENT_INVALID'); return value.entries; }
// Pinned mapBasedSelectorForObject: pod -> metadata.labels (error when empty); service -> spec.selector
// (error when nil); apps/v1 deployment -> spec.selector.matchLabels (error on empty or matchExpressions).
export function deriveExposeSelector(kind: string, body: JsonToken): readonly (readonly [string, JsonToken])[] {
  const metadata = object(documentProperty(body, 'metadata')), spec = documentProperty(body, 'spec');
  if (kind === 'Pod') { const labels = stringMap(documentProperty(metadata, 'labels')); if (!labels.length) throw new BoundaryError('CONTENT_INVALID'); return labels; }
  if (kind === 'Service') { const selector = documentProperty(object(spec), 'selector'); if (selector === undefined) throw new BoundaryError('CONTENT_INVALID'); return selectorFrom(selector); }
  const selector = object(documentProperty(object(spec), 'selector'));
  if (documentProperty(selector, 'matchExpressions') !== undefined) throw new BoundaryError('CONTENT_INVALID'); // Set-based selectors stay unconverted, exactly like kubectl.
  return selectorFrom(documentProperty(selector, 'matchLabels'));
}
// Pinned portsForObject: pod/deployment -> container ports (dedup); service -> spec.ports[*].port (dedup).
export function deriveExposePorts(kind: string, body: JsonToken): number[] {
  const found: number[] = [];
  const add = (raw: string) => { const value = Number(raw); if (!found.includes(value)) found.push(value); };
  if (kind === 'Service') {
    const ports = documentProperty(object(documentProperty(body, 'spec')), 'ports');
    if (ports?.kind !== 'array') throw new BoundaryError('CONTENT_INVALID');
    for (const port of ports.items) { const number = documentProperty(object(port), 'port'); if (number?.kind !== 'atom' || !/^[1-9]\d*$/.test(number.text)) throw new BoundaryError('CONTENT_INVALID'); add(number.text); }
    return found;
  }
  const podSpec = kind === 'Pod' ? object(documentProperty(body, 'spec')) : object(documentProperty(object(documentProperty(object(documentProperty(body, 'spec')), 'template')), 'spec'));
  const containers = documentProperty(podSpec, 'containers');
  if (containers?.kind !== 'array') throw new BoundaryError('CONTENT_INVALID');
  for (const container of containers.items) {
    const ports = documentProperty(object(container), 'ports');
    if (ports === undefined) continue;
    if (ports.kind !== 'array') throw new BoundaryError('CONTENT_INVALID');
    for (const port of ports.items) { const number = documentProperty(object(port), 'containerPort'); if (number?.kind !== 'atom' || !/^[1-9]\d*$/.test(number.text)) throw new BoundaryError('CONTENT_INVALID'); add(number.text); }
  }
  return found;
}
export function buildExposedService(targetRaw: string, parameters: ExposeParameters): Buffer {
  const parsed = exposeParametersSchema.parse(parameters), reference = parsed.reference;
  const body = parseDocumentJson(targetRaw), metadata = object(documentProperty(body, 'metadata'));
  const kind = documentString(documentProperty(body, 'kind'));
  if (documentString(documentProperty(body, 'apiVersion')) !== (reference.type.group ? `${reference.type.group}/${reference.type.version}` : reference.type.version)
    || kind !== reference.type.kind || documentString(documentProperty(metadata, 'name')) !== reference.name
    || documentString(documentProperty(metadata, 'uid')) !== reference.uid || documentString(documentProperty(metadata, 'resourceVersion')) !== reference.resourceVersion
    || documentString(documentProperty(metadata, 'namespace')) !== reference.namespace) throw new BoundaryError('STALE_TARGET');
  const selector = deriveExposeSelector(reference.type.kind, body);
  // Explicit --port wins; otherwise the pinned single-derived-port rule (0 or >1 needs an explicit port; no headless flag here).
  const derived = deriveExposePorts(reference.type.kind, body);
  const port = parsed.port ?? (derived.length === 1 ? derived[0] : undefined);
  if (port === undefined) throw new BoundaryError('CONTENT_INVALID');
  const protocol = parsed.protocol ?? 'TCP', targetPort = parsed.targetPort ?? port;
  if (reference.namespace === undefined) throw new BoundaryError('STALE_TARGET');
  const namespace = reference.namespace;
  const servicePort: JsonToken = { kind: 'object', entries: [['port', { kind: 'atom', text: String(port) }], ['protocol', { kind: 'string', value: protocol }], ['targetPort', { kind: 'atom', text: String(targetPort) }]] };
  const specEntries: (readonly [string, JsonToken])[] = [['selector', { kind: 'object', entries: selector }], ['ports', { kind: 'array', items: [servicePort] }]];
  if (parsed.type) specEntries.push(['type', { kind: 'string', value: parsed.type }]);
  const service: JsonToken = { kind: 'object', entries: [
    ['apiVersion', { kind: 'string', value: 'v1' }], ['kind', { kind: 'string', value: 'Service' }],
    ['metadata', { kind: 'object', entries: [['name', { kind: 'string', value: parsed.name }], ['namespace', { kind: 'string', value: namespace }],
      ...(() => { const labels = stringMap(documentProperty(metadata, 'labels')); return labels.length ? [['labels', { kind: 'object', entries: labels }] as const] : []; })()] }],
    ['spec', { kind: 'object', entries: specEntries }]] };
  const text = renderDocumentJson(service, 'json', 1_048_576), built = object(parseDocumentJson(text)), builtMetadata = object(documentProperty(built, 'metadata')), builtPorts = documentProperty(object(documentProperty(built, 'spec')), 'ports');
  if (builtPorts?.kind !== 'array' || builtPorts.items.length !== 1) throw new BoundaryError('CONFLICT');
  if (documentString(documentProperty(built, 'kind')) !== 'Service' || documentString(documentProperty(builtMetadata, 'name')) !== parsed.name
    || documentString(documentProperty(builtMetadata, 'namespace')) !== namespace || documentProperty(builtMetadata, 'uid') !== undefined) throw new BoundaryError('CONFLICT');
  return Buffer.from(text);
}
export function createExposeHttpsAdapter(config: ReturnType<typeof createConfigReader>) {
  return async (request: ExposeDispatch, beforeDispatch: () => void, signal: AbortSignal): Promise<ExposeResult> => {
    const parameters = exposeParametersSchema.parse(request.parameters);
    if (parameters.reference.namespace === undefined) throw new BoundaryError('STALE_TARGET');
    const namespace = parameters.reference.namespace;
    const transport = await directConnection(config, request, signal);
    const targetPath = resourceObjectPath(parameters.reference.type, parameters.reference.name, namespace);
    const servicesCollection = `/api/v1/namespaces/${namespace}/services`;
    let body: Buffer | undefined, dispatched = false;
    try {
      const current = await onceRequest<string | undefined>(transport, new URL(targetPath, transport.server), 'GET', 'application/json', 200, undefined, signal, undefined, () => undefined,
        (_value, raw) => { try { const metadata = object(documentProperty(parseDocumentJson(raw), 'metadata')); return documentString(documentProperty(metadata, 'uid')) === parameters.reference.uid && documentString(documentProperty(metadata, 'resourceVersion')) === parameters.reference.resourceVersion ? raw : undefined; } catch { return undefined; } });
      if (current === undefined) throw new BoundaryError('NOT_FOUND'); // 404 or a same-name replacement: fixed rejection, never silently re-derived.
      body = buildExposedService(current, parameters);
      await beforeDispatch();
      if (signal.aborted || Date.now() >= request.notAfter) throw new BoundaryError('CONFIRMATION_EXPIRED');
      dispatched = true;
      const created = await onceRequest<boolean>(transport, new URL(servicesCollection, transport.server), 'POST', 'application/json', 201, body, signal, false, () => false, (_value, raw) => {
        try { const value = parseDocumentJson(raw), metadata = object(documentProperty(value, 'metadata')), uid = documentString(documentProperty(metadata, 'uid')), rv = documentString(documentProperty(metadata, 'resourceVersion'));
          return documentString(documentProperty(value, 'apiVersion')) === 'v1' && documentString(documentProperty(value, 'kind')) === 'Service'
            && documentString(documentProperty(metadata, 'name')) === parameters.name && documentString(documentProperty(metadata, 'namespace')) === namespace
            && !!uid && boundedName.safeParse(uid).success && !!rv && boundedName.safeParse(rv).success; } catch { return false; }
      });
      return created ? { outcome: 'accepted' } : { outcome: 'unknown', code: 'OPERATION_UNKNOWN' };
    } catch (error) {
      if (error instanceof BoundaryError && ['CONFLICT', 'NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED', 'CONTENT_INVALID', 'CONFIRMATION_EXPIRED'].includes(error.code) && !dispatched) return { outcome: 'rejected', code: error.code };
      return { outcome: dispatched ? 'unknown' : 'not-submitted', code: dispatched ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' };
    } finally { body?.fill(0); transport.ca?.fill(0); }
  };
}
