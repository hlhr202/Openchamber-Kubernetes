import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName, namespaceName } from './identity.ts';
import { MAX_PORT_COUNT } from './port-forward-protocol.ts';

// Upstream PortForwardStatusBarManager (components/kubectl/port-forward-ui.ts#L5-L90): sessions are
// keyed `PFSESSIONKEY/<pod>/<namespace>/<localPort>`, listed as `local:<L> -> <ns>/<pod>:<R>` (pod
// display falls back to the bare name when the namespace is absent), terminated only after the
// explicit 'Stop Forwarding' confirm on the warning `This will stop forwarding local port <L> to
// <display> (<description>)`, and the status bar shows 'Kubectl Port Forwarding' with the exact
// session-count tooltip while any session is live. DELIVERY NOTE: this increment ships the bounded
// protocol and the upstream-verbatim pure projections under static review; SERVER-SIDE EXECUTION IS
// DELIBERATELY DEFERRED — the session registry, quick pick and warning dialogs run in the HUMAN
// package environment (ownership per the package's OWNERSHIP case: same-name sessions across
// contexts/devices never collide or adopt each other's session ID, and stopping another device's
// process is never attempted). No automated execution exists anywhere.
export const portForwardSessionSchema = z.object({
  pod: boundedName,
  namespace: namespaceName.optional(),
  localPort: z.number().int().min(1).max(MAX_PORT_COUNT),
  remotePort: z.number().int().min(1).max(MAX_PORT_COUNT),
  description: z.string().min(1).max(256).optional(),
}).strict();
export type PortForwardSessionView = z.infer<typeof portForwardSessionSchema>;
export const showSessionsRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('read') }).strict(),
]);
export type ShowSessionsRequest = z.infer<typeof showSessionsRequestSchema>;
export const showSessionsResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('port-forward-sessions'), sessions: z.array(z.object({ key: z.string().min(1).max(1536), label: z.string().min(1).max(2048) }).strict()).max(64) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('port-forward-sessions-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type ShowSessionsResponse = z.infer<typeof showSessionsResponseSchema>;
// Upstream keyOf verbatim: the empty namespace is part of the key, so same-name pods across
// namespaces never collide.
export function sessionKey(session: PortForwardSessionView): string {
  return `PFSESSIONKEY/${session.pod}/${session.namespace || ''}/${session.localPort}`;
}
// Upstream podDisplayName verbatim.
export function podDisplayName(session: PortForwardSessionView): string {
  if (session.namespace) {
    return `${session.namespace}/${session.pod}`;
  }
  return session.pod;
}
// Upstream quick-pick label verbatim.
export function sessionLabel(session: PortForwardSessionView): string {
  return `local:${session.localPort} -> ${podDisplayName(session)}:${session.remotePort}`;
}
// Upstream confirm warning verbatim (the description suffix only when present).
export function stopForwardingWarning(session: PortForwardSessionView): string {
  const description = session.description ? ` (${session.description})` : '';
  return `This will stop forwarding local port ${session.localPort} to ${podDisplayName(session)}${description}`;
}
// Upstream status bar projections verbatim (shown only when at least one session is live).
export function statusBarText(sessionCount: number): string {
  return sessionCount > 0 ? 'Kubectl Port Forwarding' : '';
}
export function statusBarTooltip(sessionCount: number): string {
  return `kubectl is currently running ${sessionCount} port forwarding session(s) in the background.  Click to view and terminate.`;
}
