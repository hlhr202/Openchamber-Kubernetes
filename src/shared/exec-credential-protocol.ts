import { z } from 'zod';
import { boundedName } from './identity.ts';

// R-08 kubeconfig exec credential plugin protocol (client.authentication.k8s.io v1 / v1beta1).
// Pure portable shapes only: the executor lives in src/service/adapters/exec-credential.ts and
// is never imported by read paths or functional tests. Credential VALUES (token, client key)
// are secrets: they exist in memory only, never in logs, DTO defaults, storage or telemetry.
export const execCredentialApiVersions = ['client.authentication.k8s.io/v1', 'client.authentication.k8s.io/v1beta1'] as const;
export type ExecCredentialApiVersion = typeof execCredentialApiVersions[number];
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
// Upstream kubeconfig exec plugin declaration surface (clientcmd v1 ExecConfig), bounded:
// command path, bounded argument array, declared NAME=VALUE env entries and an install hint
// (display text only; the plugin NEVER auto-installs anything).
export const execPluginSpecSchema = z.object({
  apiVersion: z.enum(execCredentialApiVersions),
  command: z.string().min(1).max(1024),
  args: z.array(z.string().min(1).max(1024)).max(64).optional(),
  env: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256), value: z.string().max(4096) }).strict()).max(64).optional(),
  interactiveMode: z.enum(['Never', 'IfAvailable', 'Always']).optional(),
  provideClusterInfo: z.boolean().optional(),
}).strict();
export type ExecPluginSpec = z.infer<typeof execPluginSpecSchema>;
// The status object a plugin prints on stdout (non-interactive). At least one credential kind.
export const execCredentialStatusSchema = z.object({
  expirationTimestamp: z.string().regex(rfc3339).optional(),
  token: z.string().min(1).max(8192).optional(),
  clientCertificateData: z.string().min(1).max(65_536).optional(),
  clientKeyData: z.string().min(1).max(65_536).optional(),
}).strict().refine(status => (status.clientCertificateData === undefined) === (status.clientKeyData === undefined)
  && (status.token !== undefined || status.clientCertificateData !== undefined), { message: 'invalid credential' });
export const execCredentialSchema = z.object({
  apiVersion: z.enum(execCredentialApiVersions),
  kind: z.literal('ExecCredential'),
  spec: z.object({ interactive: z.boolean().optional() }).strict().optional(),
  status: execCredentialStatusSchema,
}).strict();
export type ExecCredential = z.infer<typeof execCredentialSchema>;
// In-memory cache policy: entries live ONLY in process memory (zero disk), keyed by the spec
// identity, capped, and expire at min(expirationTimestamp - 30s safety margin, now + 15 min).
export const execCredentialCacheLimits = Object.freeze({ maxEntries: 8, safetyMarginMs: 30_000, maxLifetimeMs: 900_000, stdoutMaxBytes: 262_144, runTimeoutMs: 10_000 });
// Private memory-only key. Arguments/environment can contain secrets: never log or publish it.
export function execCredentialCacheKey(spec: ExecPluginSpec): string {
  return JSON.stringify([spec.apiVersion, spec.command, spec.args ?? [], spec.env ?? [], spec.interactiveMode, spec.provideClusterInfo]);
}
// Expiry math: parse the RFC3339 timestamp to epoch ms; invalid/missing means no caching.
export function execCredentialExpiryMs(status: { readonly expirationTimestamp?: string | undefined }, now: number): number | undefined {
  if (!status.expirationTimestamp) return undefined;
  const parsed = Date.parse(status.expirationTimestamp);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(parsed - execCredentialCacheLimits.safetyMarginMs, now + execCredentialCacheLimits.maxLifetimeMs);
}
// The KUBERNETES_EXEC_INFO document handed to the plugin (non-interactive request).
export function execCredentialRequestDocument(apiVersion: ExecCredentialApiVersion, cluster?: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ apiVersion, kind: 'ExecCredential', spec: { interactive: false, ...(cluster ? { cluster } : {}) } });
}
export const execCredentialBoundedName = boundedName;
