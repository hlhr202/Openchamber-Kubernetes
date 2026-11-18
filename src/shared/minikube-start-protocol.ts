import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName } from './identity.ts';

// Upstream startMinikube (components/clusterprovider/minikube/minikube.ts#L180-L210): Alert tool
// check, status-bar 'minikube-starting', status probe — if running, warn 'Minikube cluster is
// already started.' and return; otherwise build flags from additionalFlags plus
// ` --vm-driver=<driver> ` when set, run `"<binPath>" <flags> start`, on exit 0 show
// 'Cluster started.' and set 'minikube-running', on failure 'Failed to start cluster <stderr|
// Unable to run Minikube>' / 'Failed to start cluster: <err>' and hide the item. The command
// registration passes EMPTY options ({} as MinikubeOptions). DELIVERY NOTE: this increment ships
// the bounded protocol and the upstream-verbatim pure projections under static review;
// SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the Minikube CLI, VM driver and cluster start
// run in the HUMAN package environment (NO_INSTALL case: no install dependencies/update-check/
// upgrade; missing tooling is reported for the human to prepare; no privilege/socket/host network).
export const minikubeStartRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), profile: boundedName.max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional(), vmDriver: boundedName.max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional(), additionalFlags: z.string().min(1).max(256).refine(value => { for (let index = 0; index < value.length; index++) { const code = value.charCodeAt(index); if (code < 32 || code === 127) return false; } return true; }).optional() }).strict(),
]);
export type MinikubeStartRequest = z.infer<typeof minikubeStartRequestSchema>;
export const minikubeStartResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-started') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-start-already-running') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-start-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type MinikubeStartResponse = z.infer<typeof minikubeStartResponseSchema>;
// Upstream flag assembly verbatim: additionalFlags (or empty) plus ` --vm-driver=<driver> ` when
// a non-empty driver is set.
export function startFlags(additionalFlags: string | undefined, vmDriver: string | undefined): string {
  let flags = additionalFlags ? additionalFlags : '';
  if (vmDriver && vmDriver.length > 0) {
    flags += ` --vm-driver=${vmDriver} `;
  }
  return flags;
}
// Upstream invocation verbatim: `"<binPath>" <flags> start` — flags are a raw prefix (upstream
// interpolates them; the human package supplies them, never the automated surface).
export function minikubeStartArguments(flags: string): readonly string[] {
  return [...(flags ? flags.split(' ').filter(part => part.length > 0) : []), 'start'];
}
// Upstream messages verbatim.
export function alreadyStartedMessage(): string {
  return 'Minikube cluster is already started.';
}
export function startedMessage(): string {
  return 'Cluster started.';
}
export function startFailedMessage(stderr: string | undefined): string {
  return `Failed to start cluster ${stderr ?? 'Unable to run Minikube'}`;
}
export function startThrewMessage(err: string): string {
  return `Failed to start cluster: ${err}`;
}
// Upstream status-bar texts verbatim.
export const STARTING_STATUS_TEXT = 'minikube-starting';
export const RUNNING_STATUS_TEXT = 'minikube-running';
