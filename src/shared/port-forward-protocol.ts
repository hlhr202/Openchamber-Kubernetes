import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName, namespaceName } from './identity.ts';

// Upstream portForwardKubernetes (components/kubectl/port-forward.ts#L58-L363): from a pod-level
// tree node (or an open-document pod, else a current-namespace pod picker) prompt for a port
// mapping, validate each space-separated pair against the container's named ports and the
// 1–65535 range, build the mapping, then forward. The pure validation/build core is ported
// VERBATIM here: named-port resolution, `REMOTE`, `LOCAL:REMOTE`, `:REMOTE` and `0:REMOTE`
// (Server auto-port) shapes, MAX_PORT_COUNT = 65535, and the exact error strings. DISCLOSED
// HARDENING: the upstream accepts duplicate LOCAL ports across pairs (last silently wins at the
// listener); this port rejects duplicates explicitly per the package's PORTS case. DELIVERY NOTE:
// this increment ships the bounded protocol and the upstream-verbatim pure projections under
// static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the local listener and the
// cluster read run in the HUMAN package environment (Server loopback only; a remote cluster's
// localhost is never claimed client-reachable). No automated execution exists anywhere.
export const MAX_PORT_COUNT = 65535;
export type ExtractedPort = { readonly name: string; readonly port: number };
export type PortMapping = { readonly localPort: number | undefined; readonly targetPort: number };
export type ValidationResult = { readonly valid: true } | { readonly valid: false; readonly error: string };
const PortSpecifier = { Required: 0, AllowEmpty: 1 } as const;
// Upstream isPortValid verbatim: named ports resolve, empty/zero allowed only where specified,
// otherwise the numeric range 1..MAX_PORT_COUNT.
export function isPortValid(validPorts: readonly ExtractedPort[], port: string, portSpecifier: typeof PortSpecifier[keyof typeof PortSpecifier]): boolean {
  if (validPorts.map(({ name }) => name).includes(port)) {
    return true;
  }
  if (portSpecifier === PortSpecifier.AllowEmpty && ['', '0'].includes(port)) {
    return true;
  }
  return 0 < Number(port) && Number(port) <= MAX_PORT_COUNT;
}
// Upstream validatePortPair verbatim (message strings exact, including the double space before the
// range and the en dash) plus the disclosed duplicate-local-port hardening at the mapping level.
export function validatePortPair(validPorts: readonly ExtractedPort[], portPair: string): ValidationResult {
  const splitMapping = portPair.split(':');
  if (!portPair.includes(':') && isPortValid(validPorts, portPair, PortSpecifier.Required)) {
    return { valid: true };
  }
  if (splitMapping.length > 2) {
    return { valid: false, error: `Invalid port mapping: ${portPair}` };
  }
  const localPort = splitMapping[0] ?? '';
  const targetPort = splitMapping[1] ?? '';
  if (isPortValid(validPorts, localPort, PortSpecifier.AllowEmpty) && isPortValid(validPorts, targetPort, PortSpecifier.Required)) {
    return { valid: true };
  }
  return { valid: false, error: `Invalid ports. Please enter a valid port mapping ie: 8888:5000 or 5000. Valid port range:  1 – ${MAX_PORT_COUNT}` };
}
export function validatePortMapping(portMapping: string, validPorts: readonly ExtractedPort[] = []): ValidationResult | undefined {
  const portPairs = portMapping.split(' ');
  const validationResults = portPairs.map(pair => validatePortPair(validPorts, pair));
  return validationResults.find(result => !result.valid);
}
// Disclosed hardening: duplicate explicit LOCAL ports are rejected before any listener exists.
export function hasDuplicateLocalPorts(portMapping: string): boolean {
  const locals = portMapping.split(' ').map(pair => pair.includes(':') ? pair.split(':')[0] : undefined).filter((port): port is string => port !== undefined && !['', '0'].includes(port));
  return new Set(locals).size !== locals.length;
}
// Upstream buildPortMapping/buildPortPair/buildPort/buildNullablePort verbatim.
function buildPort(validPorts: readonly ExtractedPort[], port: string): number {
  const validPort = validPorts.find(({ name }) => name === port);
  if (validPort) {
    return validPort.port;
  }
  return Number(port);
}
function buildNullablePort(validPorts: readonly ExtractedPort[], port: string): number | undefined {
  if (['', '0'].includes(port)) {
    return undefined;
  }
  return buildPort(validPorts, port);
}
function buildPortPair(validPorts: readonly ExtractedPort[], portPair: string): PortMapping {
  if (!portPair.includes(':')) {
    return { targetPort: buildPort(validPorts, portPair), localPort: undefined };
  }
  const splitString = portPair.split(':');
  const localPort = splitString[0] ?? '';
  const targetPort = splitString[1] ?? '';
  return { localPort: buildNullablePort(validPorts, localPort), targetPort: buildPort(validPorts, targetPort) };
}
export function buildPortMapping(portString: string, namedPorts: readonly ExtractedPort[] = []): readonly PortMapping[] {
  const portPairs = portString.split(' ');
  return portPairs.map(pair => buildPortPair(namedPorts, pair));
}
// Bounded protocol: the pod-level target identity plus the raw port-mapping text.
export const portForwardRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), pod: boundedName, namespace: namespaceName, ports: z.string().min(1).max(512) }).strict(),
]);
export type PortForwardRequest = z.infer<typeof portForwardRequestSchema>;
export const portForwardResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('port-forward-validated'), mappings: z.array(z.object({ localPort: z.number().int().min(1).max(MAX_PORT_COUNT).nullable(), targetPort: z.number().int().min(1).max(MAX_PORT_COUNT) })).max(16) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('port-forward-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type PortForwardResponse = z.infer<typeof portForwardResponseSchema>;
