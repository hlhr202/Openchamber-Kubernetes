import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName, namespaceName } from './identity.ts';

// Upstream execKubernetesCore(false) (extension.ts#L1440-L1491 + kubectl.ts#L407-L417): prompt for a
// command (NO default on the exec path — only the terminal path defaults to 'bash'), pick an app
// pod with fallback to the current namespace, pick a container, then run the NON-interactive
// `kubectl exec <pod> -c <container> -- <command>` in the shared terminal and report stdout/stderr/
// exit separately. DISCLOSED FIX: the upstream non-interactive invocation OMITS the namespace (the
// terminal path passes it), so a pod from a non-current namespace silently misses; this port binds
// the ORIGINAL pod namespace explicitly (never the ambient global target) — the coverage package's
// NAMESPACE case. DELIVERY NOTE: this increment ships the bounded protocol and the upstream-verbatim
// pure projections under static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the cluster
// exec surface runs in the HUMAN package environment (real exec/provider paths remain unverified per
// the standing R-09 risk). No automated execution exists anywhere.
// Free-form single-line command text (spaces legitimate); control characters are rejected by code
// point (not a regex literal, which trips no-control-regex) — newline, tab and all C0/DEL codes.
export const execCommandText = z.string().min(1).max(256).refine(value => { for (let index = 0; index < value.length; index++) { const code = value.charCodeAt(index); if (code < 32 || code === 127) return false; } return true; });
export const execRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), pod: boundedName, namespace: namespaceName, container: boundedName.max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), command: execCommandText }).strict(),
]);
export type ExecRequest = z.infer<typeof execRequestSchema>;
export const execResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('exec-completed'), exitCode: z.number().int().min(0).max(255) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('exec-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type ExecResponse = z.infer<typeof execResponseSchema>;
// Upstream exec invocation verbatim EXCEPT the disclosed fix: the original pod namespace is bound
// explicitly (--namespace, long flag as in the terminal path) and never taken from the global target.
export function execArguments(pod: string, namespace: string, container: string, command: string): readonly string[] {
  return ['exec', pod, '--namespace', namespace, '-c', container, '--', command];
}
// Upstream shared-terminal wrapper verbatim: `kubectl <command>` typed into the shared terminal
// (no pipe on the exec path).
export function sharedTerminalCommand(command: readonly string[]): string {
  return `kubectl ${command.join(' ')}`;
}
// Upstream prompt shapes verbatim: the exec path has NO default; only the terminal path does.
export function execPromptDefault(isTerminal: boolean): string | undefined {
  return isTerminal ? 'bash' : undefined;
}
