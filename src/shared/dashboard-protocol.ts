import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName } from './identity.ts';

// Upstream dashboardKubernetes (components/kubectl/dashboard.ts#L14-L189): open
// http://localhost:8001/ui/ by running `kubectl proxy` in a terminal named 'Kubernetes Dashboard'
// and waiting for the proxy to report readiness from its stdout stream; for AKS clusters (detected
// by the every-node heuristic: name starts with 'aks-' AND role label 'agent') the dashboard is
// reached instead by port-forwarding straight to the kube-system dashboard pod found via
// `get pod -n kube-system -l k8s-app=kubernetes-dashboard -o json` (first item's livenessProbe
// httpGet port/scheme). DELIVERY NOTE: this increment ships the bounded protocol and the
// upstream-verbatim pure projections under static review; SERVER-SIDE EXECUTION IS DELIBERATELY
// DEFERRED — the chain needs a terminal/proxy lifecycle plus cluster reads, and it runs in the
// HUMAN package environment. DEVIATION DISCLOSED UP FRONT: the upstream pipes proxy output through
// `tee proxy.out`; this port NEVER writes a proxy.out/tee log (the package's STALE case forbids
// it), and the upstream's non-null `!` assumptions on the pod JSON are replaced by explicit
// rejection of malformed responses.
export const KUBE_DASHBOARD_URL = 'http://localhost:8001/ui/';
export const TERMINAL_NAME = 'Kubernetes Dashboard';
const nodeName = z.string().min(1).max(253);
export const dashboardNodeSchema = z.object({ name: nodeName, roleLabel: nodeName }).strict();
export type DashboardNode = z.infer<typeof dashboardNodeSchema>;
// Upstream isNodeAKS verbatim: name starts with 'aks-' AND the kubernetes.io/role label is 'agent'.
export function isNodeAKS(node: DashboardNode): boolean {
  return node.name.startsWith('aks-') && node.roleLabel === 'agent';
}
// Upstream isAKSCluster verbatim: EVERY node must match (empty list → upstream for-loop returns true; quirk preserved and disclosed).
export function isAKSCluster(nodes: readonly DashboardNode[]): boolean {
  for (const node of nodes) { if (!isNodeAKS(node)) return false; }
  return true;
}
// Upstream findDashboardPod invocation verbatim.
export function findDashboardPodArguments(): readonly string[] {
  return ['get', 'pod', '-n', 'kube-system', '-l', 'k8s-app=kubernetes-dashboard', '-o', 'json'];
}
// The upstream pod-info projection with the non-null assumptions replaced by explicit errors.
export type DashboardPodInfo = { readonly name: string; readonly port: number; readonly scheme: string };
export function projectDashboardPod(items: readonly unknown[]): DashboardPodInfo {
  const first = items[0] as { metadata?: { name?: unknown }; spec?: { containers?: readonly { livenessProbe?: { httpGet?: { port?: unknown; scheme?: unknown } } }[] } } | undefined;
  const name = first?.metadata?.name;
  const httpGet = first?.spec?.containers?.[0]?.livenessProbe?.httpGet;
  const port = httpGet?.port;
  const scheme = httpGet?.scheme;
  if (typeof name !== 'string' || !boundedName.safeParse(name).success || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535 || typeof scheme !== 'string' || (scheme !== 'HTTP' && scheme !== 'HTTPS')) throw new Error('DASHBOARD_POD_MALFORMED');
  return { name, port, scheme };
}
export const dashboardRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('read'), nodes: z.array(dashboardNodeSchema).max(512) }).strict(),
]);
export type DashboardRequest = z.infer<typeof dashboardRequestSchema>;
export const dashboardResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('dashboard-checked'), aks: z.boolean(), url: z.string().max(128) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('dashboard-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
