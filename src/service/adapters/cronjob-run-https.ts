// Actual WRITE transport for CronJob Run Now. Never imported, constructed or invoked by automatic functional tests.
// Pinned kubectl createJobFromCronJob semantics: instantiate=manual annotation, jobTemplate labels/spec,
// ownerReference Controller=true WITHOUT BlockOwnerDeletion; two one-shot requests total (GET cronjob, POST job).
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { boundedName } from '../../shared/identity.ts';
import { documentProperty, documentString, parseDocumentJson, renderDocumentJson } from '../../shared/document-json.ts';
import type { JsonToken } from '../../shared/document-json.ts';
import { cronJobRunParametersSchema } from '../../shared/cronjob-run-protocol.ts';
import type { CronJobRunParameters } from '../../shared/cronjob-run-protocol.ts';
import { resourceObjectPath } from '../queries/parent-resource.ts';
import type { createConfigReader } from '../queries/config-source.ts';
import { onceRequest } from './https-once.ts';
import { directConnection } from './manifest-apply-https.ts';
export type CronJobRunDispatch = { readonly target: import('../../shared/identity.ts').TargetIdentity; readonly selection: import('../../shared/configuration.ts').ConfigSelection; readonly parameters: CronJobRunParameters; readonly notAfter: number };
export type CronJobRunResult = { readonly outcome: 'accepted' | 'rejected' | 'not-submitted' | 'unknown'; readonly code?: ErrorCode };
const annotation = 'cronjob.kubernetes.io/instantiate';
const object = (node: JsonToken | undefined) => { if (node?.kind !== 'object') throw new BoundaryError('CONTENT_INVALID'); return node; };
const stringEntries = (node: JsonToken | undefined): readonly (readonly [string, JsonToken])[] => {
  if (node === undefined || node.kind === 'atom' && node.text === 'null') return [];
  const value = object(node); if (value.entries.some(([, entry]) => entry.kind !== 'string')) throw new BoundaryError('CONTENT_INVALID'); return value.entries;
};
export function buildInstantiatedJob(cronJobRaw: string, parameters: CronJobRunParameters): Buffer {
  const cronJob = parseDocumentJson(cronJobRaw), spec = object(documentProperty(cronJob, 'spec')), jobTemplate = object(documentProperty(spec, 'jobTemplate'));
  const templateMetadata = documentProperty(jobTemplate, 'metadata'), templateSpec = documentProperty(jobTemplate, 'spec');
  if (templateSpec === undefined) throw new BoundaryError('CONTENT_INVALID');
  const reference = cronJobRunParametersSchema.parse(parameters).reference;
  if (reference.namespace === undefined) throw new BoundaryError('STALE_TARGET');
  const namespace = reference.namespace;
  const cronMetadata = object(documentProperty(cronJob, 'metadata'));
  const cronName = documentString(documentProperty(cronMetadata, 'name')), cronUid = documentString(documentProperty(cronMetadata, 'uid'));
  const cronApiVersion = documentString(documentProperty(cronJob, 'apiVersion')), cronKind = documentString(documentProperty(cronJob, 'kind'));
  if (cronApiVersion !== 'batch/v1' || cronKind !== 'CronJob' || cronName !== reference.name || !cronName || !cronUid || !boundedName.safeParse(cronUid).success
    || documentString(documentProperty(cronMetadata, 'namespace')) !== namespace) throw new BoundaryError('STALE_TARGET');
  // kubectl: annotations = {"cronjob.kubernetes.io/instantiate":"manual"} + jobTemplate.metadata.annotations (template wins per map copy order).
  const templateMetadataObject = object(templateMetadata ?? { kind: 'object', entries: [] });
  const annotations: (readonly [string, JsonToken])[] = [[annotation, { kind: 'string', value: 'manual' }], ...stringEntries(documentProperty(templateMetadataObject, 'annotations')).filter(([key]) => key !== annotation)];
  const labels = stringEntries(documentProperty(templateMetadataObject, 'labels'));
  const owner: JsonToken = { kind: 'object', entries: [['apiVersion', { kind: 'string', value: 'batch/v1' }], ['kind', { kind: 'string', value: 'CronJob' }],
    ['name', { kind: 'string', value: cronName }], ['uid', { kind: 'string', value: cronUid }], ['controller', { kind: 'atom', text: 'true' }]] }; // No BlockOwnerDeletion (pinned comment: not backwards-compatible).
  const metadataEntries: (readonly [string, JsonToken])[] = [['name', { kind: 'string', value: parameters.jobName }], ['namespace', { kind: 'string', value: namespace }]];
  if (labels.length) metadataEntries.push(['labels', { kind: 'object', entries: labels }]);
  metadataEntries.push(['annotations', { kind: 'object', entries: annotations }], ['ownerReferences', { kind: 'array', items: [owner] }]);
  const metadata: JsonToken = { kind: 'object', entries: metadataEntries };
  const job: JsonToken = { kind: 'object', entries: [
    ['apiVersion', { kind: 'string', value: 'batch/v1' }], ['kind', { kind: 'string', value: 'Job' }], ['metadata', metadata], ['spec', templateSpec]] };
  const text = renderDocumentJson(job, 'json', 1_048_576), built = parseDocumentJson(text), builtMetadata = object(documentProperty(built, 'metadata'));
  if (documentString(documentProperty(built, 'kind')) !== 'Job' || documentString(documentProperty(builtMetadata, 'name')) !== parameters.jobName
    || documentString(documentProperty(builtMetadata, 'namespace')) !== namespace
    || documentString(documentProperty(object(documentProperty(builtMetadata, 'annotations')), annotation)) !== 'manual'
    || documentProperty(built, 'spec') === undefined) throw new BoundaryError('CONFLICT');
  if (documentProperty(builtMetadata, 'uid') !== undefined || documentProperty(builtMetadata, 'resourceVersion') !== undefined) throw new BoundaryError('CONFLICT');
  return Buffer.from(text);
}
export function createCronJobRunHttpsAdapter(config: ReturnType<typeof createConfigReader>) {
  return async (request: CronJobRunDispatch, beforeDispatch: () => void, signal: AbortSignal): Promise<CronJobRunResult> => {
    const parameters = cronJobRunParametersSchema.parse(request.parameters);
    const transport = await directConnection(config, request, signal);
    const cronPath = resourceObjectPath(parameters.reference.type, parameters.reference.name, parameters.reference.namespace);
    const jobsCollection = `/apis/batch/v1/namespaces/${parameters.reference.namespace}/jobs`; // exact sibling collection of the pinned cronjob
    let body: Buffer | undefined, dispatched = false;
    try {
      // Fresh GET of the exact CronJob: the jobTemplate used for instantiation is the one the confirmation pinned.
      const current = await onceRequest<string | undefined>(transport, new URL(cronPath, transport.server), 'GET', 'application/json', 200, undefined, signal, undefined, () => undefined,
        (_value, raw) => { try { const metadata = object(documentProperty(parseDocumentJson(raw), 'metadata')); return documentString(documentProperty(metadata, 'uid')) === parameters.reference.uid && documentString(documentProperty(metadata, 'resourceVersion')) === parameters.reference.resourceVersion ? raw : undefined; } catch { return undefined; } });
      if (current === undefined) throw new BoundaryError('NOT_FOUND'); // 404 or a same-name replacement: both are fixed rejections, never instantiated.
      body = buildInstantiatedJob(current, parameters);
      await beforeDispatch();
      if (signal.aborted || Date.now() >= request.notAfter) throw new BoundaryError('CONFIRMATION_EXPIRED');
      dispatched = true;
      const created = await onceRequest<boolean>(transport, new URL(jobsCollection, transport.server), 'POST', 'application/json', 201, body, signal, false, () => false, (_value, raw) => {
        try { const value = parseDocumentJson(raw), metadata = object(documentProperty(value, 'metadata')), uid = documentString(documentProperty(metadata, 'uid')), rv = documentString(documentProperty(metadata, 'resourceVersion'));
          return documentString(documentProperty(value, 'apiVersion')) === 'batch/v1' && documentString(documentProperty(value, 'kind')) === 'Job'
            && documentString(documentProperty(metadata, 'name')) === parameters.jobName && documentString(documentProperty(metadata, 'namespace')) === parameters.reference.namespace
            && !!uid && boundedName.safeParse(uid).success && !!rv && boundedName.safeParse(rv).success; } catch { return false; }
      });
      return created ? { outcome: 'accepted' } : { outcome: 'unknown', code: 'OPERATION_UNKNOWN' };
    } catch (error) {
      if (error instanceof BoundaryError && ['CONFLICT', 'NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED', 'CONTENT_INVALID', 'CONFIRMATION_EXPIRED'].includes(error.code) && !dispatched) return { outcome: 'rejected', code: error.code };
      return { outcome: dispatched ? 'unknown' : 'not-submitted', code: dispatched ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE' };
    } finally { body?.fill(0); transport.ca?.fill(0); }
  };
}
