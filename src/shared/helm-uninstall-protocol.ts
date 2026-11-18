import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { targetSchema } from './identity.ts';
import { configSelectionSchema } from './configuration.ts';

// Upstream helmUninstall (helm.exec.ts#L350-L368): from a release tree node only, an explicit
// warning confirm ("You are about to uninstall <name>. This action cannot be undone." with the
// single 'Uninstall' action) precedes `helm del <release>` — the upstream uses the DEL alias
// verbatim. DELIVERY NOTE: like helmGet/helmInstall, this increment ships the bounded protocol and
// the upstream-verbatim argument projection under static review; SERVER-SIDE EXECUTION IS
// DELIBERATELY DEFERRED — credentials stay inline in every existing chain while the Helm CLI
// needs a kubeconfig FILE (materializing credentials to disk is a new sensitive surface needing
// its own design decision). The confirmation gate is the HUMAN package's explicit step (the
// upstream confirm dialog is a host UI action); no automated execution exists anywhere.
export const releaseToken = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const helmUninstallRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), selection: configSelectionSchema, target: targetSchema, release: releaseToken }).strict(),
]);
export type HelmUninstallRequest = z.infer<typeof helmUninstallRequestSchema>;
export const helmUninstallResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-uninstalled'), release: releaseToken }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-uninstall-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmUninstallResponse = z.infer<typeof helmUninstallResponseSchema>;
// Upstream argument shape verbatim: the DEL alias with the pinned kubeconfig.
export function helmUninstallArguments(release: string, kubeconfigPath: string): readonly string[] {
  return ['--kubeconfig', kubeconfigPath, 'del', release];
}
