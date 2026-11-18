import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName } from './identity.ts';

// Upstream kubernetesSaveKubeconfig (extension.ts#L2380-L2412, registered at #L263) first obtains
// the kubeconfig text from the selected Cloud Explorer node via
// target.provider.getKubeconfigYaml(target.value) — with no contributed target it shows
// 'This command requires a cluster to be selected in Cloud Explorer' and stops; then an EMPTY
// options SaveDialog: a cancellation writes nothing; a non-file scheme shows
// 'Can only save to the file system'; an EXISTING target shows 'File already exists' (upstream has
// NO overwrite option) and only a non-existent file is created via fs.writeTextFile, reporting
// `Configuration saved to <fsPath>`. DELIVERY NOTE: this increment ships the bounded protocol and
// the upstream-verbatim pure projections under static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the provider credential acquisition and the local file write run in the HUMAN
// package environment (NORMAL case: provider acquisition precedes the target choice, only a
// non-existent file is created, and the result is never auto-merged or set active/known; CANCEL
// case: a cancelled dialog writes nothing yet the preceding authentication/credential acquisition
// may already have happened — the whole chain is never claimed zero-side-effect; FAILURE case:
// non-file targets, existing targets and permission/symlink failures fail as themselves, and the
// exists-then-refuse gate never becomes an exists-then-write race that overwrites; PRIVACY_UNKNOWN
// case: config/token never enters the default DTO/URL/storage/log/chat and an unknown write result
// stays unaccounted — never auto-deleted or replayed). No automated execution exists anywhere.
export const saveKubeconfigRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('save'), provider: boundedName.max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional(), cluster: boundedName.max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional() }).strict(),
]);
export type SaveKubeconfigRequest = z.infer<typeof saveKubeconfigRequestSchema>;
export const saveKubeconfigResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('cluster-required') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('save-cancelled') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('non-file-target') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('target-already-exists') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('kubeconfig-saved') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('save-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type SaveKubeconfigResponse = z.infer<typeof saveKubeconfigResponseSchema>;
// Upstream messages verbatim.
export function requiresClusterMessage(): string {
  return 'This command requires a cluster to be selected in Cloud Explorer';
}
export function onlyFileSystemMessage(): string {
  return 'Can only save to the file system';
}
export function fileExistsMessage(): string {
  return 'File already exists';
}
export function configurationSavedMessage(kcfile: string): string {
  return `Configuration saved to ${kcfile}`;
}
// Upstream gate order verbatim: cancel → scheme → existence → write; refuse-before-write means an
// existing file is NEVER overwritten (there is no overwrite branch anywhere upstream).
export function mayWriteTarget(cancelled: boolean, isFileScheme: boolean, targetExists: boolean): boolean {
  return !cancelled && isFileScheme && !targetExists;
}
