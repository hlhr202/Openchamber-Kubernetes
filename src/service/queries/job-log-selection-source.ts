import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName, dnsName, namespaceName, containsControlCharacters } from '../../shared/identity.ts';
import type { JobLogSelectionSource } from '../../shared/job-log-selection-protocol.ts';
import type { PodLogReference } from '../../shared/pod-log-protocol.ts';
import { projectParentResource } from './parent-resource.ts';
import { jobLogMembership } from './job-log-source.ts';
import { podSelection } from './selectors.ts';
import type { ResourceReadRequest } from './resource-reader.ts';

// Private ranking keys only; never expose spec/status/labels/selector or timestamps in public choice DTOs.
export type JobLogCandidate = { reference: PodLogReference; assigned: boolean; phase: number; ready: boolean; readyAt: bigint | null; regularRestarts: number; sidecarRestarts: number; createdAt: bigint | null };
const status = z.object({ name: namespaceName, restartCount: z.number().int().nonnegative().max(2_147_483_647).default(0) });
const time = z.string().max(64).nullable().optional();
function timestamp(value: string | null | undefined): bigint | null {
  if (!value || value === '0001-01-01T00:00:00Z') return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new BoundaryError('RESOURCE_INVALID'); const seconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(seconds)) throw new BoundaryError('RESOURCE_INVALID'); return BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}
export function jobLogSelector(job: unknown, source: JobLogSelectionSource): string {
  const parent = projectParentResource(job, source.origin, source.target);
  if (parent.kind !== 'selected-pods') throw new BoundaryError('INVALID_INPUT'); const value = podSelection(parent.selector, 'workload');
  if (value.kind === 'empty') throw new BoundaryError('SELECTOR_INVALID'); if (value.query.length > 8192) throw new BoundaryError('BUDGET_EXCEEDED'); return value.query;
}
export function projectJobLogCandidate(input: unknown, job: unknown, source: JobLogSelectionSource): JobLogCandidate {
  const parsed = z.object({ apiVersion: z.literal('v1'), kind: z.literal('Pod'), metadata: z.object({ name: dnsName, namespace: namespaceName, uid: boundedName, resourceVersion: boundedName, creationTimestamp: time }),
    spec: z.object({ nodeName: z.union([z.literal(''), dnsName]).optional(), initContainers: z.array(z.object({ name: namespaceName, restartPolicy: z.enum(['Always']).optional() })).max(128).optional() }),
    status: z.object({ phase: z.enum(['Running', 'Unknown', 'Pending', 'Succeeded', 'Failed']).optional(), conditions: z.array(z.object({ type: boundedName, status: z.enum(['True', 'False', 'Unknown']), lastTransitionTime: time })).max(128).optional(),
      containerStatuses: z.array(status).max(128).optional(), initContainerStatuses: z.array(status).max(128).optional() }).optional() }).safeParse(input);
  if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID'); const pod = parsed.data;
  const reference: PodLogReference = { resource: 'pods', name: pod.metadata.name, namespace: pod.metadata.namespace, uid: pod.metadata.uid, resourceVersion: pod.metadata.resourceVersion };
  jobLogMembership(job, input, source.target, source.origin, reference);
  const ready = pod.status?.conditions?.find(condition => condition.type === 'Ready'), sidecars = new Set((pod.spec.initContainers ?? []).filter(container => container.restartPolicy === 'Always').map(container => container.name));
  return { reference, assigned: !!pod.spec.nodeName, phase: pod.status?.phase === 'Unknown' ? 1 : pod.status?.phase === 'Pending' ? 2 : 0,
    ready: ready?.status === 'True', readyAt: ready?.status === 'True' ? timestamp(ready.lastTransitionTime) : null,
    regularRestarts: Math.max(0, ...(pod.status?.containerStatuses ?? []).map(container => container.restartCount)),
    sidecarRestarts: Math.max(0, ...(pod.status?.initContainerStatuses ?? []).filter(container => sidecars.has(container.name)).map(container => container.restartCount)), createdAt: timestamp(pod.metadata.creationTimestamp) };
}
const earlier = (a: bigint | null, b: bigint | null) => a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
// kubectl v0.37.0 podutils.ByLogging, NOT ActivePods/deletion sorting. Succeeded/Failed map to Go's zero rank.
export function compareJobLogCandidates(a: JobLogCandidate, b: JobLogCandidate): number {
  return Number(b.assigned) - Number(a.assigned) || a.phase - b.phase || Number(b.ready) - Number(a.ready)
    || (a.ready && b.ready ? earlier(a.readyAt, b.readyAt) : 0) || b.regularRestarts - a.regularRestarts || b.sidecarRestarts - a.sidecarRestarts || earlier(a.createdAt, b.createdAt);
}
export function projectJobLogCandidatePage(input: unknown, job: unknown, source: JobLogSelectionSource) {
  const parsed = z.object({ apiVersion: z.literal('v1'), kind: z.literal('PodList'), metadata: z.object({ resourceVersion: boundedName, continue: z.string().max(8192).refine(value => !containsControlCharacters(value)).optional() }), items: z.array(z.unknown()).max(100) }).safeParse(input);
  if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID');
  return { resourceVersion: parsed.data.metadata.resourceVersion, continuation: parsed.data.metadata.continue || null, candidates: parsed.data.items.map(pod => projectJobLogCandidate(pod, job, source)) };
}
export function planJobPodWatch(source: JobLogSelectionSource, selector: string, resourceVersion: string): ResourceReadRequest {
  if (!selector || selector.length > 8192 || containsControlCharacters(selector) || !boundedName.safeParse(resourceVersion).success || resourceVersion === '0') throw new BoundaryError('INVALID_INPUT');
  return { method: 'GET', purpose: 'job-pod-watch', target: source.target, path: `/api/v1/namespaces/${source.origin.namespace}/pods`, maximumBytes: 2_000_000,
    query: { watch: 'true', resourceVersion, timeoutSeconds: '5', labelSelector: selector } };
}
