// Actual WRITE transport. Never imported, constructed or invoked by automatic functional tests.
// Each operation performs exactly one low-level HTTPS request via the shared one-shot core in https-once.ts.
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { boundedName, targetSchema } from '../../shared/identity.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import type { ConfigSelection } from '../../shared/configuration.ts';
import { documentProperty, documentString, parseDocumentJson } from '../../shared/document-json.ts';
import { manifestComparisonPath } from '../../shared/manifest-diff-protocol.ts';
import { customDocumentReferenceSchema } from '../../shared/document-protocol.ts';
import { applyComparisonReference } from '../../shared/manifest-apply-protocol.ts';
import { privateKubectlConfiguration } from '../queries/kubectl-configuration.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { onceRequest, knownRejection } from './https-once.ts';
import type { OnceConnection } from './https-once.ts';
import type { ManifestApplyDispatch, ManifestApplyResult, ManifestApplyCreateDispatch, ManifestApplyCreateResult } from '../operations/manifest-apply.ts';
const snapshotSchema = z.object({ apiVersion: z.literal('v1'), kind: z.literal('Config'), 'current-context': boundedName,
  clusters: z.array(z.object({ name: boundedName, cluster: z.object({ server: z.string().max(8192), 'certificate-authority-data': z.string().max(2_000_000).optional(), 'disable-compression': z.boolean().optional() }).strict() }).strict()).length(1),
  users: z.array(z.object({ name: boundedName, user: z.object({ token: z.string().min(1).max(16_384).regex(/^[\x21-\x7e]+$/) }).strict() }).strict()).length(1),
  contexts: z.array(z.object({ name: boundedName, context: z.object({ cluster: boundedName, user: boundedName, namespace: z.string() }).strict() }).strict()).length(1),
}).strict();
export async function directConnection(config: ReturnType<typeof createConfigReader>, input: { target: TargetIdentity; selection: ConfigSelection }, signal: AbortSignal): Promise<OnceConnection> {
  targetSchema.parse(input.target);
  if (!((process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'))) throw new BoundaryError('CLI_INCOMPATIBLE');
  // Refuse process-wide HTTP/TLS diagnostics or injected runtime options; never mutate the host environment.
  if (process.env.NODE_DEBUG || process.env.NODE_OPTIONS || process.execArgv.some(arg => arg.startsWith('--tls-keylog'))) throw new BoundaryError('AUTHENTICATION_UNAVAILABLE');
   const value = await config.transportRead(input.selection, input.target.configIdentity, signal, input.target), bytes = privateKubectlConfiguration(value.merged, input.target);
  try {
    const parsed = snapshotSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
    if (!parsed.success) throw new BoundaryError('AUTHENTICATION_UNAVAILABLE');
    const cluster = parsed.data.clusters[0], user = parsed.data.users[0], context = parsed.data.contexts[0];
    if (!cluster || !user || !context || context.context.cluster !== cluster.name || context.context.user !== user.name) throw new BoundaryError('CONFIG_REFERENCE_MISSING');
    const server = new URL(cluster.cluster.server);
    // Initial direct transport is intentionally narrower than kubectl: no path prefix, proxy, insecure TLS,
    // file credentials, impersonation, exec/provider, mTLS/basic or environment credential fallback.
    if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash || server.pathname !== '/') throw new BoundaryError('AUTHENTICATION_UNAVAILABLE');
    const encoded = cluster.cluster['certificate-authority-data']; let ca: Buffer | undefined;
    if (encoded !== undefined) { ca = Buffer.from(encoded, 'base64'); if (!ca.length || ca.toString('base64') !== encoded || ca.length > 1_000_000) { ca.fill(0); throw new BoundaryError('CONFIG_INVALID'); } }
    return { server, token: user.user.token, ...(ca ? { ca } : {}),
      credentialsRejected: () => config.credentialsRejected(value.merged, input.target.configIdentity) };
  } finally { bytes.fill(0); }
}
const fail = (code: ErrorCode) => ({ phase: 'failed' as const, code });
export function createManifestApplyHttpsAdapter(config: ReturnType<typeof createConfigReader>) {
  return {
    async check(input: Pick<ManifestApplyDispatch, 'target' | 'selection'>, signal: AbortSignal) { const value = await directConnection(config, input, signal); value.ca?.fill(0); },
    async execute(input: ManifestApplyDispatch, beforeDispatch: () => Promise<void>, signal: AbortSignal): Promise<ManifestApplyResult> {
      const reference = customDocumentReferenceSchema.parse(input.reference), transport = await directConnection(config, input, signal), body = Buffer.from(input.body);
      let dispatched = false;
      try {
        if (!body.length || body.length > 1_048_576) throw new BoundaryError('CONTENT_INVALID');
        const metadata = documentProperty(parseDocumentJson(input.body), 'metadata');
        if (documentString(documentProperty(metadata, 'uid')) !== reference.uid || documentString(documentProperty(metadata, 'resourceVersion')) !== reference.resourceVersion) throw new BoundaryError('CONFLICT');
        await beforeDispatch();
        if (signal.aborted || Date.now() >= input.notAfter) throw new BoundaryError('CONFIRMATION_EXPIRED');
        dispatched = true;
        const url = new URL(manifestComparisonPath(applyComparisonReference(reference)), transport.server); url.search = '?fieldManager=kubectl-client-side-apply&fieldValidation=Strict';
        return await onceRequest<ManifestApplyResult>(transport, url, 'PATCH', 'application/merge-patch+json', 200, body, signal, { phase: 'unknown', code: 'OPERATION_UNKNOWN' }, fail, (_value, raw) => {
          const value = parseDocumentJson(raw), metadata = documentProperty(value, 'metadata'), rv = documentString(documentProperty(metadata, 'resourceVersion'));
          if (documentString(documentProperty(value, 'apiVersion')) !== `${reference.type.group}/${reference.type.version}` || documentString(documentProperty(value, 'kind')) !== reference.type.kind
            || documentString(documentProperty(metadata, 'name')) !== reference.name || documentString(documentProperty(metadata, 'uid')) !== reference.uid
            || (reference.namespace ? documentString(documentProperty(metadata, 'namespace')) !== reference.namespace : documentProperty(metadata, 'namespace') !== undefined)
            || !rv || !boundedName.safeParse(rv).success) return undefined;
          return { phase: 'succeeded', resourceVersion: rv };
        });
      } catch (error) { return { phase: dispatched ? 'unknown' : 'not-submitted', code: dispatched ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' }; }
      finally { body.fill(0); transport.ca?.fill(0); }
    },
    // The explicitly confirmed missing->Create branch: one POST of the prepared body to the collection,
    // with kubectl-create semantics (upstream runs create in this branch, never a hidden apply).
    async create(input: ManifestApplyCreateDispatch, beforeDispatch: () => Promise<void>, signal: AbortSignal): Promise<ManifestApplyCreateResult> {
      const reference = customDocumentReferenceSchema.parse(input.reference), transport = await directConnection(config, input, signal), body = Buffer.from(input.body);
      let dispatched = false;
      try {
        if (!body.length || body.length > 1_048_576) throw new BoundaryError('CONTENT_INVALID');
        const metadata = documentProperty(parseDocumentJson(input.body), 'metadata');
        // The prepared Create body must carry the exact intended name/namespace and NO stale identity fields.
        if (documentString(documentProperty(metadata, 'name')) !== reference.name || documentProperty(metadata, 'uid') !== undefined || documentProperty(metadata, 'resourceVersion') !== undefined
          || (reference.namespace ? documentString(documentProperty(metadata, 'namespace')) !== reference.namespace : documentProperty(metadata, 'namespace') !== undefined)) throw new BoundaryError('CONFLICT');
        await beforeDispatch();
        if (signal.aborted || Date.now() >= input.notAfter) throw new BoundaryError('CONFIRMATION_EXPIRED');
        dispatched = true;
        const objectPath = manifestComparisonPath(applyComparisonReference(reference)), url = new URL(objectPath.slice(0, objectPath.lastIndexOf('/')), transport.server);
        url.search = '?fieldManager=kubectl-create&fieldValidation=Strict';
        return await onceRequest<ManifestApplyCreateResult>(transport, url, 'POST', 'application/json', 201, body, signal, { phase: 'unknown', code: 'OPERATION_UNKNOWN' }, fail, (_value, raw) => {
          const value = parseDocumentJson(raw), metadata = documentProperty(value, 'metadata'), rv = documentString(documentProperty(metadata, 'resourceVersion')), uid = documentString(documentProperty(metadata, 'uid'));
          if (documentString(documentProperty(value, 'apiVersion')) !== `${reference.type.group}/${reference.type.version}` || documentString(documentProperty(value, 'kind')) !== reference.type.kind
            || documentString(documentProperty(metadata, 'name')) !== reference.name
            || (reference.namespace ? documentString(documentProperty(metadata, 'namespace')) !== reference.namespace : documentProperty(metadata, 'namespace') !== undefined)
            || !uid || !boundedName.safeParse(uid).success || uid === reference.uid || !rv || !boundedName.safeParse(rv).success) return undefined; // Same-name replacement is never adopted as this Create.
          return { phase: 'succeeded', uid, resourceVersion: rv };
        });
      } catch (error) { return { phase: dispatched ? 'unknown' : 'not-submitted', code: dispatched ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' }; }
      finally { body.fill(0); transport.ca?.fill(0); }
    },
  };
}
export { knownRejection };
