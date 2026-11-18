import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { targetSchema } from './identity.ts';
import { configSelectionSchema } from './configuration.ts';
import { releaseToken } from './helm-uninstall-protocol.ts';

// Upstream helmRollback (helm.exec.ts#L394-L420): from a release HISTORY node only, the currently
// deployed revision is refused with an information message, then an explicit warning confirm
// ("You are about to rollback <name> to release version <rev>. Continue?" with the single
// 'Rollback' action) precedes `helm rollback <release> <revision> --cleanup-on-fail`; success
// refreshes the explorer. DELIVERY NOTE: like helmGet/helmInstall/helmUninstall, this increment
// ships the bounded protocol and the upstream-verbatim argument projection under static review;
// SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED (credentials stay inline everywhere; the Helm CLI
// needs a kubeconfig FILE — materializing credentials to disk needs its own design decision). The
// deployed-revision guard and the warning confirm are HUMAN package steps (host UI/cluster-state
// actions); no automated execution exists anywhere.
export const helmRollbackRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), selection: configSelectionSchema, target: targetSchema, release: releaseToken, revision: z.number().int().min(1).max(10_000) }).strict(),
]);
export type HelmRollbackRequest = z.infer<typeof helmRollbackRequestSchema>;
export const helmRollbackResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-rolled-back'), release: releaseToken, revision: z.number().int().min(1).max(10_000) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-rollback-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmRollbackResponse = z.infer<typeof helmRollbackResponseSchema>;
// Upstream argument shape verbatim: revision as its own token plus --cleanup-on-fail.
export function helmRollbackArguments(release: string, revision: number, kubeconfigPath: string): readonly string[] {
  return ['--kubeconfig', kubeconfigPath, 'rollback', release, String(revision), '--cleanup-on-fail'];
}
