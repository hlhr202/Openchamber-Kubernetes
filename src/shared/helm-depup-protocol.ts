import { z } from 'zod';
import { BoundaryError, errorCodes } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { containsControlCharacters, hasWellFormedUnicode } from './identity.ts';
import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts';
import type { HelmRepositorySource } from './helm-repository-protocol.ts';

// Upstream helmDepUp (helm.exec.ts#L155-L180): pickChart (or a file URI's directory) then
// `helm dep up "<path>"` — Chart.lock and the vendored charts/ subtree INSIDE the chart directory
// are updated, and dependency downloads land in the repository cache. Here the chart directory is a
// canonical workspace location (root + relative path, both schema-validated — never an arbitrary
// filesystem path and never a shell string; upstream's non-file scheme check is the schema's job).
// The run stays in the isolated PATH-only environment with the user's repositories.yaml READ-ONLY;
// downloads go ONLY into the plugin-isolated cache, workspace writes only inside the chart
// directory. Only bounded stdout is retained; stderr is never retained (upstream logs both —
// disclosed deviation). A non-zero exit is an UPDATE FAILURE with a fixed code (upstream logs
// "UPDATE FAILED"), never silently retried.
export const helmDepUpRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), root: workspaceRootSchema, path: workspaceRelativeSchema }).strict(),
]);
export type HelmDepUpRequest = z.infer<typeof helmDepUpRequestSchema>;
export const helmDepUpResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-dep-updated'), root: workspaceRootSchema, path: workspaceRelativeSchema, content: z.string().max(16_384) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-dep-up-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmDepUpResponse = z.infer<typeof helmDepUpResponseSchema>;
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
export function depUpArguments(root: string, path: string, source: HelmRepositorySource, home: string): { readonly args: readonly string[] } {
  const cache = `${pluginCacheDirectory(home)}/${baseName(source.paths.indexDirectory)}`;
  return { args: [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${cache}`, 'dep', 'up', workspaceChartDirectory(root, path)] };
}
export function depUpFailureCode(error: unknown): ErrorCode {
  return error instanceof BoundaryError && ['CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'FORBIDDEN', 'UNAUTHENTICATED', 'QUERY_CANCELLED', 'BUDGET_EXCEEDED', 'STATE_UNAVAILABLE', 'READ_TRANSPORT_UNAVAILABLE'].includes(error.code) ? error.code : 'STATE_UNAVAILABLE';
}
