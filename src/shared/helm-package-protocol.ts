import { z } from 'zod';
import { BoundaryError, errorCodes } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { containsControlCharacters, hasWellFormedUnicode } from './identity.ts';
import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts';
import type { HelmRepositorySource } from './helm-repository-protocol.ts';

// Upstream helmPackage (helm.exec.ts#L432-L454): pickChart, then a single-folder Save dialog, then
// `helm package "<chartPath>" -d "<destinationFolder>"` — the packaged .tgz is written INTO the
// chosen destination folder. Here both the chart directory and the destination folder are canonical
// workspace locations (root + relative path, all schema-validated — never arbitrary filesystem
// paths and never shell strings; upstream's non-file scheme check is the schema's job). The run
// stays in the isolated PATH-only environment with the user's repositories.yaml READ-ONLY; the
// ONLY filesystem effect is the archive inside the designated workspace destination. Only bounded
// stdout is retained (it carries the "Successfully packaged chart and saved it to:" identity);
// stderr is never retained (upstream logs both — disclosed deviation).
export const helmPackageRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), root: workspaceRootSchema, path: workspaceRelativeSchema, destinationRoot: workspaceRootSchema, destinationPath: workspaceRelativeSchema }).strict(),
]);
export type HelmPackageRequest = z.infer<typeof helmPackageRequestSchema>;
export const helmPackageResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-packaged'), root: workspaceRootSchema, path: workspaceRelativeSchema, destinationRoot: workspaceRootSchema, destinationPath: workspaceRelativeSchema, content: z.string().max(16_384) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-package-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmPackageResponse = z.infer<typeof helmPackageResponseSchema>;
// Canonical joins of already-validated components; no normalization tricks, no escapes.
export function workspaceChartDirectory(root: string, path: string): string {
  return path === '' ? root : `${root}/${path}`;
}
const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, '');
export function pluginCacheDirectory(home: string): string {
  if (home.length === 0 || home.length > 4096 || !home.startsWith('/') || home.startsWith('//') || home.includes('\\') || containsControlCharacters(home) || !hasWellFormedUnicode(home)) throw new BoundaryError('INVALID_INPUT');
  return `${trimTrailingSlashes(home)}/.openchamber-kubernetes/helm-cache`;
}
const baseName = (directory: string) => trimTrailingSlashes(directory).split('/').pop() ?? '';
export function packageArguments(root: string, path: string, destinationRoot: string, destinationPath: string, source: HelmRepositorySource, home: string): { readonly args: readonly string[] } {
  const cache = `${pluginCacheDirectory(home)}/${baseName(source.paths.indexDirectory)}`;
  return { args: [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${cache}`, 'package', workspaceChartDirectory(root, path), '-d', workspaceChartDirectory(destinationRoot, destinationPath)] };
}
export function packageFailureCode(error: unknown): ErrorCode {
  return error instanceof BoundaryError && ['CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'FORBIDDEN', 'UNAUTHENTICATED', 'QUERY_CANCELLED', 'BUDGET_EXCEEDED', 'STATE_UNAVAILABLE', 'READ_TRANSPORT_UNAVAILABLE'].includes(error.code) ? error.code : 'STATE_UNAVAILABLE';
}
