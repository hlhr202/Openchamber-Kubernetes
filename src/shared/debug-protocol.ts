import { z } from 'zod';
import { errorCodes } from './errors.ts';

// Upstream debugKubernetes (extension.ts#L1800-L1820, registered at #L202) picks a workspace
// folder (hostutils#L3-L11: no folders shows 'This command requires an open folder.'), offers the
// provider debugger types plus the legacy ['node'] with placeHolder 'Select the environment'
// (a cancellation starts nothing), routes a provider type to DebugSession.launch and otherwise
// runs the LEGACY leg buildPushThenExec(debugInternal) (extension.ts#L1007-L1042: 'Building an
// image...' / '<image> built.' / 'Pushing the image...' / '<image> pushed.' and the three
// build/push failure messages plus `Failed building/pushing an image: <errorMessage>`), then
// debugInternal prompts 'Debug command for your container:' with placeHolder
// 'Example: node debug server.js' (cancel writes nothing; `Error getting input: <err>`), and
// doDebug (extension.ts#L1875-L1955) runs `run <name>-debug --image=<image> -i --attach=false --
// <cmd>` ('Failed to start debug container' on failure), finds the debug pod ('Failed to find
// debug pod.'; 'Debug pod running as: <podName>'), polls
// ` get pods <name> -o jsonpath --template="{.status.phase}"` every 1000ms until stdout is
// 'Running', port-forwards ` port-forward <podName> 5858:5858 8000:8000`, attaches the fixed
// node launch configuration (type 'node', request 'attach', name 'Attach to Process', port 5858,
// remoteRoot '/'), reports 'Debug session established' with the optional 'Expose Service' button
// (prompt 'Expose on which port?', placeHolder '80',
// `expose deployment <name>-debug --type=LoadBalancer --port=<port>`,
// 'Failed to expose deployment: <detail>',
// `Deployment exposed. Run Kubernetes Get > service <name>-debug for IP address`,
// `Error getting port info: <err>` / `Error getting expose info: <message>`); the provider
// launch leg (debugSession.ts#L56-L138) requires the image prefix ("No Docker image prefix set
// for image push. Please set 'vsdocker.imageUser' in your Kubernetes extension settings."),
// reports 'Building Docker image...' / 'Running Docker image on Kubernetes...', and its cleanup
// stays behind the explicit Clean Up choices. DELIVERY NOTE: this increment ships the bounded
// protocol and the upstream-verbatim pure projections under static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the build/push, debug workload creation, readiness wait,
// port-forward and the REAL debug adapter run in the HUMAN package environment (NORMAL case:
// after the workspace/language pick a build+push precedes the debug workload creation, readiness
// wait, port-forward and the REAL adapter — generating a launch configuration alone is never the
// run; LEGACY case: the legacy node path stays reachable — the explicit debug command and the
// later OPTIONAL Expose are separate write steps, and a failed or unknown dependency never
// silently becomes Attach; CANCEL_PARTIAL case: a cancelled early pick starts nothing, and a
// cancel after build/push or creation never impersonates a rollback — every step keeps its result
// and its pending business cleanup; CLEANUP case: resources of this run's original UID are
// deleted only on the user's explicit choice or setting — an unknown service exit never
// auto-clears, and a Compose stop never triggers the deletion). No automated execution exists
// anywhere.
export const debugRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('debug') }).strict(),
]);
export type DebugRequest = z.infer<typeof debugRequestSchema>;
export const debugResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('workspace-required') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('environment-required') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('legacy-build-initiated') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('debug-workload-started') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('debug-session-established') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('debug-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type DebugResponse = z.infer<typeof debugResponseSchema>;
// Upstream picks and gates verbatim.
export function selectEnvironmentPlaceholder(): string {
  return 'Select the environment';
}
export function legacyDebuggerTypes(): readonly string[] {
  return ['node'];
}
export function workspaceRequiredMessage(): string {
  return 'This command requires an open folder.';
}
// Upstream legacy build/push texts verbatim.
export function buildingImageProgress(): string {
  return 'Building an image...';
}
export function imageBuiltMessage(image: string): string {
  return image + ' built.';
}
export function pushingImageProgress(): string {
  return 'Pushing the image...';
}
export function imagePushedMessage(image: string): string {
  return image + ' pushed.';
}
export function pushFailedUnableMessage(buildTool: string): string {
  return `Image push failed; unable to call ${buildTool}.`;
}
export function pushDiagnosticMessage(diagnostic: string, buildTool: string): string {
  return `${diagnostic} See Output window for ${buildTool} push error message.`;
}
export function buildFailedUnableMessage(buildTool: string): string {
  return `Image build failed; unable to call ${buildTool}.`;
}
export function buildFailedMessage(): string {
  return 'Image build failed. See Output window for details.';
}
export function failedBuildingPushingMessage(errorMessage: string): string {
  return `Failed building/pushing an image: ${errorMessage}`;
}
// Upstream debug command input verbatim.
export function debugCommandPrompt(): string {
  return 'Debug command for your container:';
}
export function debugCommandPlaceholder(): string {
  return 'Example: node debug server.js';
}
export function inputErrorMessage(err: string): string {
  return `Error getting input: ${err}`;
}
// Upstream debug workload invocation and messages verbatim.
export function debugDeploymentName(name: string): string {
  return `${name}-debug`;
}
export function debugRunCommand(name: string, image: string, cmd: string): string {
  return `run ${name}-debug --image=${image} -i --attach=false -- ${cmd}`;
}
export function failedToStartDebugContainerMessage(): string {
  return 'Failed to start debug container';
}
export function failedToFindDebugPodMessage(): string {
  return 'Failed to find debug pod.';
}
export function debugPodRunningMessage(podName: string): string {
  return 'Debug pod running as: ' + podName;
}
// Upstream readiness poll verbatim (leading space included exactly as upstream invokes it).
export function podPhaseCommand(name: string): string {
  return ` get pods ${name} -o jsonpath --template="{.status.phase}"`;
}
export function isPodRunning(stdout: string): boolean {
  return stdout === 'Running';
}
export const POD_READY_RETRY_MS = 1000;
// Upstream port-forward invocation verbatim (leading space included) and the fixed attach config.
export function debugPortForwardCommand(podName: string): string {
  return ` port-forward ${podName} 5858:5858 8000:8000`;
}
export function attachConfiguration(localRoot: string): { type: string; request: string; name: string; port: number; localRoot: string; remoteRoot: string } {
  return { type: 'node', request: 'attach', name: 'Attach to Process', port: 5858, localRoot, remoteRoot: '/' };
}
export function debugSessionEstablishedMessage(): string {
  return 'Debug session established';
}
export const EXPOSE_SERVICE_BUTTON = 'Expose Service';
export function exposePortPrompt(): string {
  return 'Expose on which port?';
}
export function exposePortPlaceholder(): string {
  return '80';
}
export function exposeCommand(deploymentName: string, port: string): string {
  return `expose deployment ${deploymentName} --type=LoadBalancer --port=${port}`;
}
export function failedToExposeMessage(detail: string): string {
  return 'Failed to expose deployment: ' + detail;
}
export function deploymentExposedMessage(deploymentName: string): string {
  return `Deployment exposed. Run Kubernetes Get > service ${deploymentName} for IP address`;
}
export function portInfoErrorMessage(err: string): string {
  return `Error getting port info: ${err}`;
}
export function exposeInfoErrorMessage(message: string): string {
  return `Error getting expose info: ${message}`;
}
// Upstream provider launch leg texts verbatim.
export function noImagePrefixMessage(): string {
  return "No Docker image prefix set for image push. Please set 'vsdocker.imageUser' in your Kubernetes extension settings.";
}
export function buildingDockerImageProgress(): string {
  return 'Building Docker image...';
}
export function runningImageProgress(): string {
  return 'Running Docker image on Kubernetes...';
}
