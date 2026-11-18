import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { targetSchema } from './identity.ts';
import { configSelectionSchema } from './configuration.ts';
import { helmChartReference, helmChartVersion } from './helm-inspect-protocol.ts';
import type { HelmSyntax } from './helm-version-protocol.ts';

// Upstream helmInstall (helm.exec.ts#L526-L579): from an input box or repo chart/version node,
// `helm install <chartId> [--version <v>] [--namespace <ns>] [--generate-name]` — the namespace is
// resolved from the CURRENT kubectl context, --generate-name only on v3/v4, and the release name is
// extracted from the stdout NAME: line. DELIVERY NOTE: like helmGet (E051), this increment ships
// the bounded protocol and the upstream-verbatim argument/release-name projections under static
// review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — credentials stay inline in every
// existing chain while the Helm CLI needs a kubeconfig FILE, so running it server-side would
// materialize credentials to disk, a new sensitive surface needing its own design decision. The
// namespace comes from the bound target identity (resolved context namespace), never a free field.
export const helmInstallRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), selection: configSelectionSchema, target: targetSchema, chart: helmChartReference, version: helmChartVersion.optional() }).strict(),
]);
export type HelmInstallRequest = z.infer<typeof helmInstallRequestSchema>;
export const helmInstallResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-installed'), chart: helmChartReference, releaseName: z.string().min(1).max(128), syntax: z.enum(['v2', 'v3', 'v4', 'unknown']) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-install-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmInstallResponse = z.infer<typeof helmInstallResponseSchema>;
// Upstream argument shape verbatim: --generate-name only on v3/v4; namespace from the resolved
// current context (here: the bound target's namespace field).
export function installGenerateName(syntax: HelmSyntax): boolean {
  return syntax === 'v3' || syntax === 'v4';
}
export function helmInstallArguments(syntax: HelmSyntax, chart: string, version: string | undefined, namespace: string, kubeconfigPath: string): readonly string[] {
  return ['--kubeconfig', kubeconfigPath, 'install', chart, ...(version ? ['--version', version] : []), '--namespace', namespace, ...(installGenerateName(syntax) ? ['--generate-name'] : [])];
}
// Upstream extractReleaseName: the trimmed line starting with NAME: carries the release name;
// upstream falls back to the literal '(unknown)' — kept verbatim here.
const HELM_INSTALL_NAME_HEADER = 'NAME:';
export function extractReleaseName(helmOutput: string): string {
  const lines = helmOutput.split('\n').map(line => line.trim());
  const nameLine = lines.find(line => line.startsWith(HELM_INSTALL_NAME_HEADER));
  if (!nameLine) return '(unknown)';
  return nameLine.substring(HELM_INSTALL_NAME_HEADER.length + 1).trim() || '(unknown)';
}
