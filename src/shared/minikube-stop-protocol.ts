import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName } from './identity.ts';

// Upstream stopMinikube (components/clusterprovider/minikube/minikube.ts#L212-L238): Alert tool
// check, status-bar 'minikube-stopping', status probe — if NOT running, warn 'Minikube cluster is
// already stopped.' and return; otherwise run `"<binPath>" stop` (STOP, never delete), on exit 0
// show 'Cluster stopped.' and hide the status bar, on failure 'Error stopping cluster <stderr|
// Unable to run Minikube>' / 'Error stopping cluster: <err>' and hide. DELIVERY NOTE: this
// increment ships the bounded protocol and the upstream-verbatim pure projections under static
// review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the Minikube CLI stop runs in the HUMAN
// package environment (ENVIRONMENT case: a Compose stop or adapter exit can NEVER run Minikube
// stop, and an empty `ps`/stale state never proves an unattended window; FAILURE_UNKNOWN: a failed
// or unknown stop is never reported as stopped and never replayed, and another device's session is
// never terminated). No automated execution exists anywhere.
export const minikubeStopRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), profile: boundedName.max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional() }).strict(),
]);
export type MinikubeStopRequest = z.infer<typeof minikubeStopRequestSchema>;
export const minikubeStopResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-stopped') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-stop-already-stopped') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-stop-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type MinikubeStopResponse = z.infer<typeof minikubeStopResponseSchema>;
// Upstream invocation verbatim: `"<binPath>" stop` — stop only, never delete.
export function minikubeStopArguments(): readonly string[] {
  return ['stop'];
}
// Upstream messages verbatim.
export function alreadyStoppedMessage(): string {
  return 'Minikube cluster is already stopped.';
}
export function stoppedMessage(): string {
  return 'Cluster stopped.';
}
export function stopFailedMessage(stderr: string | undefined): string {
  return `Error stopping cluster ${stderr ?? 'Unable to run Minikube'}`;
}
export function stopThrewMessage(err: string): string {
  return `Error stopping cluster: ${err}`;
}
// Upstream status-bar text verbatim.
export const STOPPING_STATUS_TEXT = 'minikube-stopping';
