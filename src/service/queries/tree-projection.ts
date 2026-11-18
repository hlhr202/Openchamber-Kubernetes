import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { boundedName, containsControlCharacters, namespaceName, stableNodeId } from '../../shared/identity.ts';
import type { ResourceIdentity, TargetIdentity } from '../../shared/identity.ts';
import type { ResourceDescriptor, TreeIcon, TreeNode } from '../../shared/tree.ts';

const metadataSchema = z.object({
  name: boundedName,
  namespace: namespaceName.optional(), uid: boundedName.optional(), resourceVersion: boundedName.optional(),
});
const metadataOnlySchema = z.object({ metadata: metadataSchema });
const podStatusSchema = z.object({ status: z.object({
  phase: boundedName.optional(), podIP: boundedName.optional(),
  containerStatuses: z.array(z.object({ ready: z.boolean(), state: z.object({ waiting: z.object({ reason: boundedName.optional() }).optional(),
    terminated: z.object({ exitCode: z.number().int() }).optional() }).optional() })).max(1024).optional(),
  initContainerStatuses: z.array(z.object({ ready: z.boolean(), state: z.object({ terminated: z.object({ exitCode: z.number().int() }).optional() }).optional() })).max(1024).optional(),
}).optional() });
const configKeysSchema = z.object({ data: z.unknown().optional() });

function parseResourceIdentity(value: unknown, descriptor: ResourceDescriptor): ResourceIdentity {
  const result = metadataOnlySchema.safeParse(value);
  if (!result.success) throw new BoundaryError('RESOURCE_INVALID');
  const metadata = result.data.metadata;
  if (descriptor.scope === 'namespace' && !metadata.namespace) throw new BoundaryError('RESOURCE_INVALID');
  if (descriptor.scope === 'cluster' && metadata.namespace !== undefined) throw new BoundaryError('RESOURCE_INVALID');
  return {
    group: descriptor.group, version: descriptor.version, resource: descriptor.resource, scope: descriptor.scope, kind: descriptor.kind,
    name: metadata.name,
    ...(descriptor.scope === 'namespace' && metadata.namespace ? { namespace: metadata.namespace } : {}),
    ...(metadata.uid ? { uid: metadata.uid } : {}),
    ...(metadata.resourceVersion ? { resourceVersion: metadata.resourceVersion } : {}),
  };
}

function podIcon(value: unknown): TreeIcon | undefined {
  const result = podStatusSchema.safeParse(value);
  if (!result.success) return undefined;
  const status = result.data.status;
  if (!status?.phase) return undefined;
  const phase = status.phase.toLowerCase();
  if (phase === 'succeeded' || phase === 'completed') return 'pod-completed';
  if (phase === 'failed') return 'pod-error';
  if (status.initContainerStatuses?.some(container => container.state?.terminated && container.state.terminated.exitCode !== 0)
    || status.containerStatuses?.some(container => container.state?.terminated && container.state.terminated.exitCode !== 0)) return 'pod-error';
  const waiting = status.containerStatuses?.filter(container => container.state?.waiting);
  if (waiting?.some(container => /BackOff|Error|ErrImagePull|InvalidImageName/.test(container.state?.waiting?.reason ?? ''))) return 'pod-error';
  if (waiting?.length || status.initContainerStatuses?.some(container => !container.ready && container.state?.terminated?.exitCode !== 0)) return 'pod-not-ready';
  if (phase === 'running') {
    if (!status.containerStatuses?.length) return undefined;
    return status.containerStatuses.every(container => container.ready) ? 'pod-running' : 'pod-not-ready';
  }
  return phase === 'pending' ? 'pod-not-ready' : undefined;
}

const replicas = z.number().int().nonnegative();
const deploymentStatusSchema = z.object({
  metadata: z.object({ generation: replicas }),
  spec: z.object({ replicas: replicas.optional(), paused: z.boolean().optional() }),
  status: z.object({ observedGeneration: replicas.optional(), readyReplicas: replicas.optional(),
    availableReplicas: replicas.optional(), updatedReplicas: replicas.optional(),
    conditions: z.array(z.object({ type: boundedName, status: boundedName })).max(64).optional() }).optional(),
});
function deploymentIcon(value: unknown): TreeIcon | undefined {
  const result = deploymentStatusSchema.safeParse(value);
  if (!result.success) return undefined; // Unknown is never shown as a successful deployment.
  const { metadata, spec, status } = result.data, desired = spec.replicas ?? 1;
  if (spec.paused || desired === 0) return 'workload-paused';
  if (!status || status.observedGeneration === undefined) return undefined;
  if (status.observedGeneration < metadata.generation) return 'workload-progressing';
  if (status.conditions?.some(condition => condition.type === 'ReplicaFailure' && condition.status === 'True'
    || condition.type === 'Progressing' && condition.status === 'False')) return 'workload-error';
  return (status.readyReplicas ?? 0) >= desired && (status.availableReplicas ?? 0) >= desired && (status.updatedReplicas ?? 0) >= desired
    ? 'workload-ready' : 'workload-progressing';
}

function requireSameResource(value: unknown, parent: TreeNode): void {
  const result = metadataOnlySchema.safeParse(value);
  if (!result.success || !parent.resource) throw new BoundaryError('RESOURCE_INVALID');
  const current = result.data.metadata;
  const expected = parent.resource;
  if (current.name !== expected.name || current.namespace !== expected.namespace
    || (expected.uid !== undefined && current.uid !== expected.uid)
    || (expected.resourceVersion !== undefined && current.resourceVersion !== expected.resourceVersion)) throw new BoundaryError('STALE_TARGET');
}

// This is the only resource -> default-tree projection; never spreads a Kubernetes object.
export function projectResource(value: unknown, descriptor: ResourceDescriptor, target: TargetIdentity): TreeNode {
  const identity = parseResourceIdentity(value, descriptor);
  const icon = descriptor.group === '' && descriptor.resource === 'pods' && descriptor.kind === 'Pod' ? podIcon(value)
    : descriptor.group === 'apps' && descriptor.version === 'v1' && descriptor.resource === 'deployments' && descriptor.kind === 'Deployment' ? deploymentIcon(value) : undefined;
  const label = descriptor.group === '' && descriptor.resource === 'namespaces' && descriptor.kind === 'Namespace' && identity.name === target.namespace ? `* ${identity.name}` : identity.name;
  const portResource = descriptor.group === '' && descriptor.version === 'v1'
    ? descriptor.resource === 'pods' && descriptor.kind === 'Pod' ? 'pods'
      : descriptor.resource === 'services' && descriptor.kind === 'Service' ? 'services' : undefined : undefined;
  return {
    id: stableNodeId(target, identity.group, identity.version, identity.resource, identity.namespace ?? '', identity.name, identity.uid ?? ''),
    type: 'resource', label, expandable: descriptor.children !== 'none', resource: identity, children: descriptor.children,
    tooltip: `${descriptor.kind}: ${identity.name}`,
    ...(icon ? { icon } : {}),
    ...(portResource ? { forwardPorts: projectForwardPortHints(value, portResource) } : {}),
  };
}

export function projectConfigurationKeys(value: unknown, parent: TreeNode): readonly TreeNode[] {
  if (parent.type !== 'resource' || parent.children !== 'config-keys' || !parent.resource) throw new BoundaryError('INVALID_INPUT');
  requireSameResource(value, parent);
  const parsed = configKeysSchema.safeParse(value);
  if (!parsed.success) throw new BoundaryError('RESOURCE_INVALID');
  const data = parsed.data.data ?? {};
  if (typeof data !== 'object' || Array.isArray(data) || ![Object.prototype, null].includes(Object.getPrototypeOf(data))) throw new BoundaryError('RESOURCE_INVALID');
  const keys = Object.keys(data);
  if (keys.length > 2000 || keys.some(key => key.length === 0 || key.length > 1024 || containsControlCharacters(key))) throw new BoundaryError('BUDGET_EXCEEDED');
  const resource = parent.resource;
  return keys.map(key => ({ type: 'config-key', id: JSON.stringify([parent.id, key]), label: key, key, resource, expandable: false }));
}

export function projectPodInformation(value: unknown, parent: TreeNode): readonly TreeNode[] {
  if (parent.type !== 'resource' || parent.children !== 'pod-info') throw new BoundaryError('INVALID_INPUT');
  requireSameResource(value, parent);
  const result = podStatusSchema.safeParse(value);
  if (!result.success) throw new BoundaryError('RESOURCE_INVALID');
  const status = result.data.status;
  if (!status?.phase) return [{ type: 'message', id: `${parent.id}:status-unavailable`, label: 'STATE_UNAVAILABLE', expandable: false }];
  const containers = status.containerStatuses;
  const readiness = containers?.length ? `${containers.filter(container => container.ready).length}/${containers.length}` : 'unknown';
  const rows: TreeNode[] = [{ type: 'info', id: `${parent.id}:status`, label: `${status.phase} (${readiness})`, expandable: false }];
  if (status.podIP) rows.push({ type: 'info', id: `${parent.id}:ip`, label: status.podIP, expandable: false });
  return rows;
}
import { projectForwardPortHints } from '../../shared/forward-port-hints.ts';
