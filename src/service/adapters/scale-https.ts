// Actual WRITE transport for Scale. Never imported, constructed or invoked by automatic functional tests.
// Uses the pinned kubectl precondition branch: GET the scale subresource, pin its resourceVersion, then ONE full PUT.
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';
import { documentProperty, documentString, parseDocumentJson, renderDocumentJson } from '../../shared/document-json.ts';
import type { JsonToken } from '../../shared/document-json.ts';
import { scaleParametersSchema } from '../../shared/scale-protocol.ts';
import type { ScaleParameters } from '../../shared/scale-protocol.ts';
import { resourceObjectPath } from '../queries/parent-resource.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { onceRequest } from './https-once.ts';
import { directConnection } from './manifest-apply-https.ts';
export type ScaleDispatch = { readonly target: import('../../shared/identity.ts').TargetIdentity; readonly selection: import('../../shared/configuration.ts').ConfigSelection; readonly parameters: ScaleParameters; readonly notAfter: number };
export type ScaleResult = { readonly outcome: 'accepted' | 'rejected' | 'not-submitted' | 'unknown'; readonly code?: import('../../shared/errors.ts').ErrorCode };
type Scale = { readonly apiVersion: 'autoscaling/v1'; readonly kind: 'Scale'; readonly name: string; readonly namespace: string; readonly resourceVersion: string; readonly replicas: number; readonly token: JsonToken };const scaleJson = z.object({ apiVersion: z.literal('autoscaling/v1'), kind: z.literal('Scale'),
  metadata: z.object({ name: boundedName, namespace: boundedName, resourceVersion: boundedName }).strict(),
  spec: z.object({ replicas: z.number().int().min(0).max(2147483647) }).strict() }).strict();
function parseScale(raw: string, parameters: ScaleParameters): Scale {
  const value = parseDocumentJson(raw), metadata = documentProperty(value, 'metadata'), spec = documentProperty(value, 'spec'), replicas = documentProperty(spec, 'replicas');
  const parsed = scaleJson.safeParse({ apiVersion: documentString(documentProperty(value, 'apiVersion')), kind: documentString(documentProperty(value, 'kind')),
    metadata: { name: documentString(documentProperty(metadata, 'name')), namespace: documentString(documentProperty(metadata, 'namespace')), resourceVersion: documentString(documentProperty(metadata, 'resourceVersion')) },
    spec: { replicas: replicas?.kind === 'atom' && /^-?(?:0|[1-9]\d*)$/.test(replicas.text) ? Number(replicas.text) : Number.NaN } });
  if (!parsed.success || parsed.data.metadata.name !== parameters.reference.name || parsed.data.metadata.namespace !== parameters.reference.namespace) throw new BoundaryError('STALE_TARGET');
  return { apiVersion: parsed.data.apiVersion, kind: parsed.data.kind, name: parsed.data.metadata.name, namespace: parsed.data.metadata.namespace,
    resourceVersion: parsed.data.metadata.resourceVersion, replicas: parsed.data.spec.replicas, token: value };
}
function scalePutBody(scale: Scale, parameters: ScaleParameters): Buffer {
  // One full PUT of the GET'd Scale with spec.replicas replaced (autoscaling/v1 Scale.spec carries only replicas);
  // metadata.resourceVersion stays exactly as GET'd, which IS the optimistic-concurrency gate.
  const withoutSpec: readonly (readonly [string, JsonToken])[] = scale.token.kind === 'object' ? scale.token.entries.filter(([key]) => key !== 'spec') : [];
  const spec: JsonToken = { kind: 'object', entries: [['replicas', { kind: 'atom', text: String(parameters.replicas) }]] };
  const mutated: JsonToken = { kind: 'object', entries: [...withoutSpec, ['spec', spec]] };
  const text = renderDocumentJson(mutated, 'json', 1_048_576), check = parseScale(text, parameters);
  if (check.replicas !== parameters.replicas || check.resourceVersion !== scale.resourceVersion) throw new BoundaryError('CONFLICT');
  return Buffer.from(text);
}
export function createScaleHttpsAdapter(config: ReturnType<typeof createConfigReader>) {
  return async (request: ScaleDispatch, beforeDispatch: () => void, signal: AbortSignal): Promise<ScaleResult> => {
    scaleParametersSchema.parse(request.parameters);
    const transport = await directConnection(config, request, signal), path = `${resourceObjectPath(request.parameters.reference.type, request.parameters.reference.name, request.parameters.reference.namespace)}/scale`;
    type ScaleGet = { readonly kind: 'ok'; readonly scale: Scale } | { readonly kind: 'missing' } | { readonly kind: 'rejected'; readonly code: import('../../shared/errors.ts').ErrorCode } | { readonly kind: 'unknown' };
    let body: Buffer | undefined, dispatched = false;
    try {
      // The GET half of kubectl's precondition branch: exact scale identity plus the pinned RV for the PUT.
      const current = await onceRequest<ScaleGet>(transport, new URL(path, transport.server), 'GET', 'application/json', 200, undefined, signal, { kind: 'unknown' },
        code => code === 'NOT_FOUND' ? { kind: 'missing' } : { kind: 'rejected', code },
        (_value, raw) => { try { return { kind: 'ok', scale: parseScale(raw, request.parameters) } as const; } catch { return undefined; } });
      if (current.kind === 'missing') throw new BoundaryError('NOT_FOUND'); // Including a Job whose server has no scale subresource: fixed failure, never a rebuild.
      if (current.kind === 'rejected') throw new BoundaryError(current.code);
      if (current.kind !== 'ok') return { outcome: 'not-submitted', code: 'STATE_UNAVAILABLE' }; // Unknown GET: the PUT was never sent.
      body = scalePutBody(current.scale, request.parameters);
      await beforeDispatch();
      if (signal.aborted || Date.now() >= request.notAfter) throw new BoundaryError('CONFIRMATION_EXPIRED');
      dispatched = true;
      const result = await onceRequest<boolean>(transport, new URL(path, transport.server), 'PUT', 'application/json', 200, body, signal, false, () => false, (_value, raw) => {
        try { const updated = parseScale(raw, request.parameters); return updated.replicas === request.parameters.replicas && updated.resourceVersion !== current.scale.resourceVersion; } catch { return false; }
      });
      return result ? { outcome: 'accepted' } : { outcome: 'unknown', code: 'OPERATION_UNKNOWN' };
    } catch (error) {
      if (error instanceof BoundaryError && ['CONFLICT', 'NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED', 'CONTENT_INVALID', 'CONFIRMATION_EXPIRED'].includes(error.code) && !dispatched) return { outcome: 'rejected', code: error.code };
      return { outcome: dispatched ? 'unknown' : 'not-submitted', code: dispatched ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' };
    } finally { body?.fill(0); transport.ca?.fill(0); }
  };
}
