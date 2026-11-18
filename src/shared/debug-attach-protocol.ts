import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName } from './identity.ts';

// Upstream debugAttachKubernetes (extension.ts#L1823-L1828, registered at #L201) picks a workspace
// folder, then DebugSession.attach (debugSession.ts#L146-L294) picks a pod with placeHolder
// `Please select a pod to attach` and a container with 'Please select a container to attach'
// (cancellations start nothing), lists processes via
// `exec <pod> <nsarg> <containerCommand> -- ps -o pid,command -e -w -w` (debugUtils.ts#L61-L91)
// narrowing to a pid only when exactly ONE supported process remains, resolves the debug ports —
// a failure opens 'Cannot resolve the debug port to attach. See the documentation for how to use
// this command.' — reports 'Setting up port forwarding...' before the forward and
// `Starting <type> debug session...` before the REAL adapter session, whose providers carry the
// attach configurations and probes verbatim: node resolves port 9229 (or the configured override)
// and may send `exec <pod> <nsarg> <containerCommand> -- <shell> -c "kill -s USR1 1"`; .NET
// attaches with request 'attach' and reports
// `<type> debug attach failed for pod <pod>.` with the troubleshooting link on the channel
// 'Failed to attach'; python attaches with type 'debugpy', go with type 'go' (placeHolder
// '/go/src/'), java with type 'java'. DELIVERY NOTE: this increment ships the bounded protocol
// and the upstream-verbatim pure projections under static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the process/language/port probing, the port forward and the REAL adapter
// breakpoints/stack/variables run in the HUMAN package environment (NORMAL case: after picking
// the Server workspace, pod and plain container the process, language, port and path are probed
// and the REAL adapter provides breakpoints, stack and variables — forwarding alone is never the
// attach; SIDE_EFFECT case: Node attach may Exec `kill -s USR1 1`, and other process/shell/readlink
// probes are not automatic reads either — VS Code extensions are never silently installed;
// CANCEL_FAILURE case: a cancellation at any step starts no next step, and a language missing its
// dependency, an unsupported case or a DAP start failure is reported on its own — a signal
// already sent is never claimed undone; IDENTITY case: the namespace and container reach the
// final adapter, fixing the .NET omission and the name-matched cleanup — a stale identity never
// attaches to a same-name new pod and never takes over across views). No automated execution
// exists anywhere.
const token253 = boundedName.max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const debugAttachRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('attach'), pod: token253.optional(), namespace: token253.optional(), container: token253.optional() }).strict(),
]);
export type DebugAttachRequest = z.infer<typeof debugAttachRequestSchema>;
export const debugAttachResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('workspace-required') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('pod-required') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('container-required') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('port-unresolvable') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('attach-session-started'), debuggerType: boundedName.max(64) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('attach-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type DebugAttachResponse = z.infer<typeof debugAttachResponseSchema>;
// Upstream pick placeholders and progress texts verbatim.
export function pleaseSelectPodPlaceholder(): string {
  return 'Please select a pod to attach';
}
export function pleaseSelectContainerPlaceholder(): string {
  return 'Please select a container to attach';
}
export function settingUpPortForwardingProgress(): string {
  return 'Setting up port forwarding...';
}
export function startingDebugSessionProgress(debuggerType: string): string {
  return `Starting ${debuggerType} debug session...`;
}
export function cannotResolveDebugPortMessage(): string {
  return 'Cannot resolve the debug port to attach. See the documentation for how to use this command.';
}
export function learnMoreOutput(url: string): string {
  return `\nTo learn more about the usage of the debug feature, take a look at ${url}`;
}
// Upstream process probe verbatim: ps with wide columns, not an automatic read of the cluster.
export function psCommand(pod: string, nsarg: string, containerCommand: string): string {
  return `exec ${pod} ${nsarg} ${containerCommand} -- ps -o pid,command -e -w -w`;
}
export function singleSupportedProcessPid(processes: { pid: number }[] | undefined): number | undefined {
  return processes && processes.length === 1 ? +processes[0]!.pid : undefined;
}
// Upstream node probe verbatim: the USR1 signal enables inspector mode — a real side effect.
export const NODE_DEFAULT_DEBUG_PORT = 9229;
export function nodeUsr1Command(pod: string, nsarg: string, containerCommand: string, shell: string): string {
  return `exec ${pod} ${nsarg} ${containerCommand} -- ${shell} -c "kill -s USR1 1"`;
}
// Upstream provider attach configurations verbatim.
export function pythonAttachConfiguration(port: number): { type: string; request: string; port: number } {
  return { type: 'debugpy', request: 'attach', port };
}
export function goAttachConfiguration(port: number): { type: string; request: string; port: number } {
  return { type: 'go', request: 'attach', port };
}
export function goSourcePlaceholder(): string {
  return '/go/src/';
}
export function javaAttachConfiguration(port: number): { type: string; request: string; port: number } {
  return { type: 'java', request: 'attach', port };
}
export function dotnetAttachRequestKind(): string {
  return 'attach';
}
export function dotnetAttachFailedOutput(debuggerType: string, pod: string): string {
  return `${debuggerType} debug attach failed for pod ${pod}.\nSee https://github.com/Azure/vscode-kubernetes-tools/blob/master/debug-on-kubernetes.md for troubleshooting.`;
}
export const DOTNET_FAILED_CHANNEL_TITLE = 'Failed to attach';
