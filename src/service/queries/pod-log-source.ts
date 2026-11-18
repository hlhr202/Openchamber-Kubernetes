import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName, namespaceName } from '../../shared/identity.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { podLogReferenceSchema } from '../../shared/pod-log-protocol.ts';
import type { PodLogReference } from '../../shared/pod-log-protocol.ts';
import { planParentResource, verifyResourceObject } from './parent-resource.ts';
import { resourceDescriptors } from '../../shared/tree.ts';

const container = z.object({ name: namespaceName });
const podSchema = z.object({ spec: z.object({ initContainers: z.array(container).max(128).optional(), containers: z.array(container).min(1).max(128) }) });
export function planPodLogReference(input: unknown, target: TargetIdentity) {
  const parsed = podLogReferenceSchema.safeParse(input);
  if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
  return planParentResource(parsed.data, target);
}
export function projectLogContainers(input: unknown, reference: PodLogReference) {
  verifyResourceObject(input, resourceDescriptors.pods, reference);
  const parsed = podSchema.safeParse(input);
  if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID');
  const result = [...(parsed.data.spec.initContainers ?? []).map(value => ({ name: value.name, kind: 'init' as const })),
    ...parsed.data.spec.containers.map(value => ({ name: value.name, kind: 'regular' as const }))];
  if (result.length > 128 || new Set(result.map(value => value.name)).size !== result.length) throw new BoundaryError('RESOURCE_INVALID');
  return result;
}
export function logRuntimeIdentity(input: unknown, reference: PodLogReference, name: string): string {
  const containers = projectLogContainers(input, reference), selected = containers.find(value => value.name === name);
  if (!selected) throw new BoundaryError('NOT_FOUND');
  const status = z.object({ status: z.object({ initContainerStatuses: z.array(z.unknown()).max(128).optional(), containerStatuses: z.array(z.unknown()).max(128).optional() }).optional() }).safeParse(input);
  if (!status.success) throw new BoundaryError('RESOURCE_INVALID');
  const entries = selected.kind === 'init' ? status.data.status?.initContainerStatuses : status.data.status?.containerStatuses;
  const shape = z.object({ name: namespaceName, containerID: boundedName.optional(), restartCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    state: z.object({ running: z.object({ startedAt: boundedName.optional() }).optional(), terminated: z.object({ startedAt: boundedName.optional(), finishedAt: boundedName.optional(), containerID: boundedName.optional() }).optional(), waiting: z.object({ reason: boundedName.optional() }).optional() }).optional() });
  const parsed = (entries ?? []).map(value => shape.safeParse(value));
  if (parsed.some(value => !value.success)) throw new BoundaryError('RESOURCE_INVALID');
  const matches = parsed.flatMap(value => value.success && value.data.name === name ? [value.data] : []);
  if (matches.length > 1) throw new BoundaryError('RESOURCE_INVALID');
  return JSON.stringify([selected, matches[0] ?? null]); // Private comparison only; never a public log/tree field.
}
