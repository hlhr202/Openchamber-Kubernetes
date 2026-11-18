import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName } from './identity.ts';

// Upstream selectPodKubernetes (extension.ts#L1830-L1848, registered at #L207 as
// 'extension.vsKubernetesSelectPod', selection only): read the pod collection of the CURRENT
// namespace via getResourceAsJson(kubectl, "pods") — if the read yields nothing, show
// 'Unable to list any pods. No pod found in the current namespace.' and return undefined; map each
// item to a quick-pick entry labelled `${pod.metadata.name} (on ${pod.spec.nodeName})` carrying
// only the pod name, open showQuickPick with placeHolder `Select a pod`, and return the selected
// name, or undefined when the picker is cancelled/empty. DELIVERY NOTE: this increment ships the
// bounded protocol and the upstream-verbatim pure projections under static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the cluster pod read and the interactive quick-pick session
// run in the HUMAN package environment (PRIVACY case: only the pick metadata name/nodeName crosses
// the boundary — never credentials, a full pod spec, or a persisted selection history; STALE case:
// a previously selected name is never reused for a later session without re-verifying its
// identity; CANCEL_EMPTY case: a cancelled picker and a failed read stay distinguishable, a failed
// read is never faked as an empty namespace). No automated execution exists anywhere.
const podPickEntry = z.object({ name: boundedName.max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), nodeName: boundedName.max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional() }).strict();
export const selectPodRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('select') }).strict(),
]);
export type SelectPodRequest = z.infer<typeof selectPodRequestSchema>;
export const selectPodResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('pods-listed'), pods: z.array(podPickEntry).max(500) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('pod-selected'), name: boundedName.max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('selection-cancelled') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('pods-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type SelectPodResponse = z.infer<typeof selectPodResponseSchema>;
// Upstream messages/placeholders verbatim.
export function unableToListPodsMessage(): string {
  return 'Unable to list any pods. No pod found in the current namespace.';
}
export function quickPickPlaceholder(): string {
  return 'Select a pod';
}
// Upstream label template verbatim: `${pod.metadata.name} (on ${pod.spec.nodeName})` — a missing
// nodeName interpolates as the literal text 'undefined', exactly as upstream renders it.
export function podPickLabel(name: string, nodeName: string | undefined): string {
  return `${name} (on ${nodeName})`;
}
// Upstream pick-item mapping verbatim: label plus the bare pod name, nothing else.
export function podPickItems(pods: readonly { name: string; nodeName?: string }[]): { label: string; name: string }[] {
  return pods.map((pod) => ({ label: podPickLabel(pod.name, pod.nodeName), name: pod.name }));
}
