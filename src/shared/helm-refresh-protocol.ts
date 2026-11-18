import { z } from 'zod';
import { BoundaryError, errorCodes } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { containsControlCharacters, hasWellFormedUnicode } from './identity.ts';
import type { HelmRepositorySource } from './helm-repository-protocol.ts';

// Upstream HelmRepoExplorer.refresh: `helm repo update` then tree invalidation. Here the update runs
// with the user's repositories.yaml mounted READ-ONLY (HELM_REPOSITORY_CONFIG) and every download
// writing ONLY into the plugin-isolated cache directory (HELM_REPOSITORY_CACHE) — the user's config
// file is never modified. Failures keep the previous tree state; unknown results keep the written
// cache without rollback or replay.
export const helmRefreshRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run') }).strict(),
]);
export type HelmRefreshRequest = z.infer<typeof helmRefreshRequestSchema>;
export const helmRefreshResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-repo-refreshed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-repo-refresh-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmRefreshResponse = z.infer<typeof helmRefreshResponseSchema>;
// Bounded stdout of a successful update ("...Successfully got an update from the \"x\" chart repository"):
// kept only as a count of updated repositories, never raw text (it can echo repository URLs).
export function countUpdatedRepositories(stdout: string): number {
  if (!hasWellFormedUnicode(stdout)) return 0;
  return (stdout.match(/Successfully got an update/g) ?? []).length;
}
// Pure POSIX string shaping; no Node builtin is imported in shared. The plugin cache root is ALWAYS
// under the service home, never the user's real cache directory and never a shared system location.
const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, '');
export function pluginCacheDirectory(home: string): string {
  if (home.length === 0 || home.length > 4096 || !home.startsWith('/') || home.startsWith('//') || home.includes('\\') || containsControlCharacters(home) || !hasWellFormedUnicode(home)) throw new BoundaryError('INVALID_INPUT');
  return `${trimTrailingSlashes(home)}/.openchamber-kubernetes/helm-cache`;
}
const baseName = (directory: string) => trimTrailingSlashes(directory).split('/').pop() ?? '';
export function helmRefreshArguments(source: HelmRepositorySource, home: string): { readonly args: readonly string[]; readonly cache: string } {
  // Mirror the ORIGINAL cache directory NAME inside the isolation root so the reader's index
  // filenames stay stable; the user's repository file is passed read-only via --repository-config.
  const cache = `${pluginCacheDirectory(home)}/${baseName(source.paths.indexDirectory)}`;
  return { args: [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${cache}`, 'repo', 'update'], cache };
}
export function refreshFailureCode(error: unknown): ErrorCode {
  return error instanceof BoundaryError && ['CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'HELM_INDEX_MISSING', 'FORBIDDEN', 'UNAUTHENTICATED', 'QUERY_CANCELLED', 'BUDGET_EXCEEDED', 'STATE_UNAVAILABLE', 'READ_TRANSPORT_UNAVAILABLE'].includes(error.code) ? error.code : 'STATE_UNAVAILABLE';
}
