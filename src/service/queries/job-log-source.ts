import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import type { JobLogOrigin, PodLogReference } from '../../shared/pod-log-protocol.ts';
import { resourceDescriptors } from '../../shared/tree.ts';
import { planParentResource, verifyResourceObject } from './parent-resource.ts';
import { matchesPodSelector, normalizePodSelector, podSelection } from './selectors.ts';

export function jobLogMembership(job: unknown, pod: unknown, target: TargetIdentity, origin: JobLogOrigin, reference: PodLogReference): string {
  planParentResource(origin, target);
  if (origin.namespace !== reference.namespace) throw new BoundaryError('STALE_TARGET');
  verifyResourceObject(job, resourceDescriptors.jobs, origin); verifyResourceObject(pod, resourceDescriptors.pods, reference);
  const parsed = z.object({ spec: z.object({ selector: z.unknown() }) }).safeParse(job);
  const metadata = z.object({ metadata: z.object({ labels: z.unknown().optional() }) }).safeParse(pod);
  if (!parsed.success || !metadata.success) throw new BoundaryError('RESOURCE_INVALID');
  const selector = normalizePodSelector(parsed.data.spec.selector, 'workload');
  if (!matchesPodSelector(selector, metadata.data.metadata.labels)) throw new BoundaryError('STALE_TARGET');
  // A selector match is not a claim that ownerReferences names this Job. Keep the query proof private.
  return JSON.stringify(podSelection(selector, 'workload'));
}
