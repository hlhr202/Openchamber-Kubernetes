// READ ONLY. Forward target union (M5 spec L41-67): resolve a Service/Deployment ORIGINAL
// resource to its actual backend Pod before any forwarding session opens. The original is
// re-read fresh (uid/resourceVersion proof), its label selector extracted (upstream shapes:
// Service.spec.selector / Deployment.spec.selector.matchLabels), and the pods of the target
// namespace listed with that selector through the SAME gated generic list purpose. Exactly one
// live backend pod resolves; zero or many are fixed rejections (never a silent pick).
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import type { TargetIdentity } from '../../shared/identity.ts';
import { dnsName, namespaceName, boundedName } from '../../shared/identity.ts';
import { readResponseJson } from './bounded-response.ts';
import type { ResourceReadTransport } from './resource-reader.ts';

export const forwardOriginalSchema = z.object({
  resource: z.enum(['services', 'deployments']),
  name: dnsName, namespace: namespaceName,
  uid: boundedName, resourceVersion: boundedName,
}).strict();
export type ForwardOriginal = z.infer<typeof forwardOriginalSchema>;
export type ResolvedForwardPod = { readonly name: string; readonly uid: string; readonly resourceVersion: string; readonly servicePorts?: readonly { service: number; backend: number }[] };
const metadata = z.object({ name: z.string().min(1).max(253), namespace: z.string().min(1).max(63), uid: z.string().min(1).max(256), resourceVersion: z.string().min(1).max(256) }).passthrough();
const port = z.number().int().min(1).max(65535);
const podListSchema = z.object({
  kind: z.literal('PodList'), apiVersion: z.literal('v1'),
  items: z.array(z.object({ metadata, spec: z.object({ containers: z.array(z.object({ ports: z.array(z.object({
    name: z.string().optional(), containerPort: port, protocol: z.string().optional(),
  }).passthrough()).optional() }).passthrough()).max(128) }).passthrough().optional() }).passthrough()).max(100),
}).passthrough();
const serviceSchema = z.object({
  metadata,
  spec: z.object({ selector: z.record(z.string().min(1).max(516), z.string().min(1).max(516)),
    ports: z.array(z.object({ port, targetPort: z.union([port, z.string().min(1).max(63)]).optional(), protocol: z.string().optional() }).passthrough()).max(128),
  }).passthrough(),
}).passthrough();
const deploymentSchema = z.object({
  metadata,
  spec: z.object({ selector: z.object({ matchLabels: z.record(z.string().min(1).max(516), z.string().min(1).max(516)).optional() }).passthrough() }).passthrough(),
}).passthrough();
// Kubernetes label selector serialization for equality-only selectors (the only shape the
// upstream workload/service selectors use here); values are validated, never interpolated raw.
export function selectorQuery(selector: Readonly<Record<string, string>>): string {
  const entries = Object.entries(selector);
  if (!entries.length || entries.length > 8) throw new BoundaryError('SELECTOR_INVALID');
  return entries.map(([key, value]) => `${key}=${value}`).join(',');
}
export function forwardOriginalPaths(original: ForwardOriginal): { readonly objectPath: string; readonly group: string; readonly version: string } {
  if (original.resource === 'services') return { objectPath: `/api/v1/namespaces/${original.namespace}/services/${original.name}`, group: '', version: 'v1' };
  return { objectPath: `/apis/apps/v1/namespaces/${original.namespace}/deployments/${original.name}`, group: 'apps', version: 'v1' };
}
export async function readForwardTarget(target: TargetIdentity, original: ForwardOriginal, signal: AbortSignal, read: ResourceReadTransport, verify: () => Promise<void>): Promise<ResolvedForwardPod> {
  const parsed = forwardOriginalSchema.parse(original);
  await verify();
  const { objectPath } = forwardOriginalPaths(parsed);
  const object = await readResponseJson(await read({ method: 'GET', purpose: 'resource-object', target, path: objectPath, query: {}, maximumBytes: 2_000_000 }, signal), signal);
  const shape = parsed.resource === 'services' ? serviceSchema.safeParse(object) : deploymentSchema.safeParse(object);
  if (!shape.success
    || shape.data.metadata.name !== parsed.name || shape.data.metadata.namespace !== parsed.namespace
    || shape.data.metadata.uid !== parsed.uid || shape.data.metadata.resourceVersion !== parsed.resourceVersion) throw new BoundaryError('STALE_TARGET'); // the original moved: never forward to a same-name newcomer
  const selector: Readonly<Record<string, string>> | undefined = parsed.resource === 'services'
    ? (shape.data as z.infer<typeof serviceSchema>).spec.selector
    : (shape.data as unknown as z.infer<typeof deploymentSchema>).spec.selector.matchLabels;
  if (!selector || !Object.keys(selector).length) throw new BoundaryError('SELECTOR_INVALID');
  const pods = await readResponseJson(await read({ method: 'GET', purpose: 'resource-list', target,
    path: `/api/v1/namespaces/${parsed.namespace}/pods`, query: { limit: '100', labelSelector: selectorQuery(selector) }, maximumBytes: 2_000_000 }, signal), signal);
  const page = podListSchema.safeParse(pods);
  if (!page.success) throw new BoundaryError('RESOURCE_INVALID');
  if (page.data.items.length === 0) throw new BoundaryError('NOT_FOUND'); // zero backend pods: fixed rejection, never a fabricated forward
  if (page.data.items.length > 1) throw new BoundaryError('CONFLICT'); // many backends: the user picks a pod row directly, never a silent pick
  const pod = page.data.items[0]!;
  if (pod.metadata.namespace !== parsed.namespace || pod.metadata.deletionTimestamp) throw new BoundaryError('STALE_TARGET');
  let servicePorts: { service: number; backend: number }[] | undefined;
  if (parsed.resource === 'services') {
    servicePorts = [];
    for (const entry of (shape.data as z.infer<typeof serviceSchema>).spec.ports) {
      if (entry.protocol && entry.protocol !== 'TCP') continue;
      let backend = entry.targetPort ?? entry.port;
      if (typeof backend === 'string') {
        const candidates = (pod.spec?.containers ?? []).flatMap(container => container.ports ?? [])
          .filter(value => value.name === backend && (!value.protocol || value.protocol === 'TCP'));
        const distinct = [...new Set(candidates.map(value => value.containerPort))];
        if (distinct.length !== 1) throw new BoundaryError('SELECTOR_INVALID');
        backend = distinct[0]!;
      }
      servicePorts.push({ service: entry.port, backend });
    }
  }
  await verify();
  return Object.freeze({ name: pod.metadata.name, uid: pod.metadata.uid, resourceVersion: pod.metadata.resourceVersion, ...(servicePorts ? { servicePorts } : {}) });
}
