import { z } from 'zod';
import { BoundaryError, errorCodes } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { containsControlCharacters, hasWellFormedUnicode } from './identity.ts';
import { helmChartReference, helmChartVersion } from './helm-inspect-protocol.ts';
import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts';
import type { HelmRepositorySource } from './helm-repository-protocol.ts';

// Upstream helmFetch (helm.exec.ts#L456-L495): chart ref (+ optional version, shell.isSafe
// checked) and a workspace folder pick, then `helm fetch <chartId> --untar [--version <v>] -d
// "<destinationDir>"` — the chart archive is downloaded from the repository cache and UNTARRED into
// the chosen destination folder. Here the chart/version tokens reuse the shared inspect schemas
// (strict port of the isSafe check) and the destination is a canonical workspace location (root +
// relative path, all schema-validated). The run stays in the isolated PATH-only environment with
// the user's repositories.yaml READ-ONLY; the repository download goes ONLY into the
// plugin-isolated cache and the untarred chart tree lands ONLY in the designated destination.
// Only bounded stdout is retained; stderr is never retained (upstream shows it — disclosed
// deviation). A non-zero exit is a fetch failure with a fixed code, never silently retried.
export const helmFetchRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), chart: helmChartReference, version: helmChartVersion.optional(), root: workspaceRootSchema, path: workspaceRelativeSchema }).strict(),
]);
export type HelmFetchRequest = z.infer<typeof helmFetchRequestSchema>;
export const helmFetchResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-fetched'), chart: helmChartReference, version: helmChartVersion.optional(), root: workspaceRootSchema, path: workspaceRelativeSchema, content: z.string().max(16_384) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-fetch-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmFetchResponse = z.infer<typeof helmFetchResponseSchema>;
// Canonical join of two already-validated components; no normalization tricks, no escapes.
export function workspaceChartDirectory(root: string, path: string): string {
  return path === '' ? root : `${root}/${path}`;
}
const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, '');
export function pluginCacheDirectory(home: string): string {
  if (home.length === 0 || home.length > 4096 || !home.startsWith('/') || home.startsWith('//') || home.includes('\\') || containsControlCharacters(home) || !hasWellFormedUnicode(home)) throw new BoundaryError('INVALID_INPUT');
  return `${trimTrailingSlashes(home)}/.openchamber-kubernetes/helm-cache`;
}
const baseName = (directory: string) => trimTrailingSlashes(directory).split('/').pop() ?? '';
export function fetchArguments(chart: string, version: string | undefined, root: string, path: string, source: HelmRepositorySource, home: string): { readonly args: readonly string[] } {
  const cache = `${pluginCacheDirectory(home)}/${baseName(source.paths.indexDirectory)}`;
  return { args: [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${cache}`, 'fetch', chart, '--untar', ...(version ? ['--version', version] : []), '-d', workspaceChartDirectory(root, path)] };
}
export function fetchFailureCode(error: unknown): ErrorCode {
  return error instanceof BoundaryError && ['CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'HELM_INDEX_MISSING', 'FORBIDDEN', 'UNAUTHENTICATED', 'QUERY_CANCELLED', 'BUDGET_EXCEEDED', 'STATE_UNAVAILABLE', 'READ_TRANSPORT_UNAVAILABLE'].includes(error.code) ? error.code : 'STATE_UNAVAILABLE';
}
