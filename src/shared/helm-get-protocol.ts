import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName, targetSchema } from './identity.ts';
import { configSelectionSchema } from './configuration.ts';
import type { HelmSyntax } from './helm-version-protocol.ts';

// Upstream helmGet (helm.exec.ts#L330-L348 + kuberesources.virtualfs.ts#L17,L100-L110): from a
// release/history tree node, open a virtual document that runs `helm get [all] <release>
// [--revision=<n>]` — the `all` scope for v3+ (omitted on v2) — reading the release from the
// CLUSTER via the current kubeconfig. DELIVERY NOTE: this increment ships the bounded protocol and
// the upstream-verbatim argument projection under static review; SERVER-SIDE EXECUTION IS
// DELIBERATELY DEFERRED. Every existing chain keeps credentials inline (the direct HTTPS
// transports embed the bearer/CA from the resolved config and never materialize files), while the
// Helm CLI can only take a kubeconfig FILE — running it server-side would write credentials to
// disk, a new sensitive surface that needs its own design decision. Until then the chain runs in
// the HUMAN package environment, where helm reads the user's own kubeconfig natively.
export const helmGetRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('read'), selection: configSelectionSchema, target: targetSchema, release: boundedName.max(128).refine(value => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)), revision: z.number().int().min(1).max(10_000).optional() }).strict(),
]);
export type HelmGetRequest = z.infer<typeof helmGetRequestSchema>;
export const helmGetResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-release-read'), release: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), revision: z.number().int().min(1).max(10_000).optional(), syntax: z.enum(['v2', 'v3', 'v4', 'unknown']), content: z.string().max(32_768) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-get-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmGetResponse = z.infer<typeof helmGetResponseSchema>;
// Upstream argument shape verbatim: only v2 omits the `all` scope; the release is read through the
// ambient kubeconfig context (no namespace flag upstream).
export const getScope = (syntax: HelmSyntax): 'none' | 'all' => (syntax === 'v2' ? 'none' : 'all');
export function helmGetArguments(syntax: HelmSyntax, release: string, revision: number | undefined, kubeconfigPath: string): readonly string[] {
  const scope = getScope(syntax);
  return ['--kubeconfig', kubeconfigPath, 'get', ...(scope === 'all' ? ['all'] : []), release, ...(revision ? [`--revision=${revision}`] : [])];
}
