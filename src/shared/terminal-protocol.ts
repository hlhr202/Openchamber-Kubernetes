import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName } from './identity.ts';
import { namespaceName } from './identity.ts';

// Upstream terminalKubernetes (extension.ts#L1444-L1504 + utils/container-shell.ts#L4-L16 +
// kubectl.ts#L420-L431): from a pod node pick the container, probe for /bin/bash (falling back to
// sh for Busybox-style images), then open a real interactive terminal running
// `kubectl exec -it <pod> [--namespace <ns>] [--container <c>] -- <shell>` with the terminal named
// `<shell> on <pod>[/<container>]`; the picker path prompts for a command defaulting to 'bash'.
// DELIVERY NOTE: this increment ships the bounded protocol and the upstream-verbatim pure
// projections under static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — a real -it PTY
// terminal plus the cluster exec surface run in the HUMAN package environment (real exec/provider
// paths remain unverified per the standing R-09 risk). No automated execution exists anywhere.
export const terminalRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), pod: boundedName, namespace: namespaceName, container: boundedName.max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional(), command: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/) }).strict(),
]);
export type TerminalRequest = z.infer<typeof terminalRequestSchema>;
export const terminalResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('terminal-opened'), shell: z.enum(['bash', 'sh']) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('terminal-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type TerminalResponse = z.infer<typeof terminalResponseSchema>;
// Upstream execTerminalOnContainer argument array verbatim.
export function terminalExecArguments(pod: string, namespace: string | undefined, container: string | undefined, terminalCmd: string): readonly string[] {
  const args = ['exec', '-it', pod] as string[];
  if (namespace) args.push('--namespace', namespace);
  if (container) args.push('--container', container);
  args.push('--', terminalCmd);
  return args;
}
// Upstream terminal name verbatim.
export function terminalName(terminalCmd: string, pod: string, container: string | undefined): string {
  return `${terminalCmd} on ${pod}${container ? `/${container}` : ''}`;
}
// Upstream isBashOnContainer invocation verbatim: `exec <pod> [--namespace <ns>] [-c <c>] -- ls -la /bin/bash`.
export function bashProbeArguments(pod: string, namespace: string | undefined, container: string | undefined): readonly string[] {
  const args = ['exec', pod] as string[];
  if (namespace) args.push('--namespace', namespace);
  if (container) args.push('-c', container);
  args.push('--', 'ls', '-la', '/bin/bash');
  return args;
}
// Upstream suggestedShellForContainer verbatim: bash when the probe succeeds, otherwise sh.
export function suggestedShell(bashPresent: boolean): 'bash' | 'sh' {
  return bashPresent ? 'bash' : 'sh';
}
