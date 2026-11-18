import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName } from './identity.ts';

// Upstream minikubeStatus (components/clusterprovider/minikube/minikube.ts#L240-L277 +
// binutil.ts#L82-L113): after a Silent binary check, run `"<binPath>" status`; on a clean exit
// (empty stderr) the host line `host: <state>` is located, lowercased, and running is everything
// except 'stopped'; the full stdout becomes the message. Failures throw fixed messages — 'Minikube
// executable could not be found!', 'Failed to get host status: Unable to run Minikube' when no
// host line exists, and 'Failed to get status: <stderr|Unable to run Minikube>'. DELIVERY NOTE:
// this increment ships the bounded protocol and the upstream-verbatim pure projections under
// static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the Minikube CLI runs in the
// HUMAN package environment (per the package's SAFETY case: a status name never implies absence of
// cache/auth side effects, and a result never authorizes environment stop/recreate). DISCLOSED
// GUARD: the upstream host-state slice is `host: ` split with a non-null assertion; malformed
// lines are rejected explicitly here.
export const minikubeStatusRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('read'), profile: boundedName.max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional() }).strict(),
]);
export type MinikubeStatusRequest = z.infer<typeof minikubeStatusRequestSchema>;
export const minikubeStatusResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-status'), running: z.boolean(), message: z.string().max(16_384) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('minikube-status-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type MinikubeStatusResponse = z.infer<typeof minikubeStatusResponseSchema>;
// Upstream invocation verbatim: the quoted binary path plus `status`.
export function minikubeStatusArguments(): readonly string[] {
  return ['status'];
}
// Upstream error messages verbatim.
export function minikubeNotFoundMessage(): string {
  return 'Minikube executable could not be found!';
}
export function hostStatusMissingMessage(): string {
  return 'Failed to get host status: Unable to run Minikube';
}
export function statusFailedMessage(stderr: string | undefined): string {
  return `Failed to get status: ${stderr ?? 'Unable to run Minikube'}`;
}
// Upstream host-line projection with the non-null assertion replaced by an explicit rejection.
export function projectHostLine(stdout: string): { readonly running: boolean; readonly message: string } {
  const hostItem = stdout.split('\n').find(status => status.includes('host'));
  if (!hostItem) {
    throw new Error(hostStatusMissingMessage());
  }
  const segments = hostItem.split(': ');
  const state = segments[1];
  if (state === undefined) {
    throw new Error(hostStatusMissingMessage()); // upstream `!` assumption made explicit
  }
  return { running: state.toLowerCase() !== 'stopped', message: stdout };
}
