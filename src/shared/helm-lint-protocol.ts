import { z } from 'zod';
import { BoundaryError, errorCodes } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { containsControlCharacters, hasWellFormedUnicode } from './identity.ts';
import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts';
import type { HelmRepositorySource } from './helm-repository-protocol.ts';

// Upstream helmLint (helm.exec.ts): pickChart() then `helm lint "<path>"`, with the combined output
// logged. A non-zero exit reports lint FINDINGS (upstream surfaces them), not an unavailable tool.
// Here the chart directory is a canonical workspace location (root + relative path, both
// schema-validated — never an arbitrary filesystem path and never a shell string). The lint runs in
// the isolated PATH-only environment with the user's repositories.yaml READ-ONLY and any dependency
// download redirected into the plugin-isolated cache. Only bounded stdout is retained; stderr is
// never retained (disclosed deviation: upstream also logs stderr — the findings table on stdout
// carries the substance).
export const helmLintRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('read'), root: workspaceRootSchema, path: workspaceRelativeSchema }).strict(),
]);
export type HelmLintRequest = z.infer<typeof helmLintRequestSchema>;
export const helmLintResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-linted'), root: workspaceRootSchema, path: workspaceRelativeSchema, failed: z.boolean(), content: z.string().max(16_384) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-lint-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmLintResponse = z.infer<typeof helmLintResponseSchema>;
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
export function helmLintArguments(root: string, path: string, source: HelmRepositorySource, home: string): { readonly args: readonly string[]; readonly chartDirectory: string } {
  const cache = `${pluginCacheDirectory(home)}/${baseName(source.paths.indexDirectory)}`;
  return { args: [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${cache}`, 'lint', workspaceChartDirectory(root, path)], chartDirectory: workspaceChartDirectory(root, path) };
}
export function lintFailureCode(error: unknown): ErrorCode {
  return error instanceof BoundaryError && ['CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'FORBIDDEN', 'UNAUTHENTICATED', 'QUERY_CANCELLED', 'BUDGET_EXCEEDED', 'STATE_UNAVAILABLE', 'READ_TRANSPORT_UNAVAILABLE'].includes(error.code) ? error.code : 'STATE_UNAVAILABLE';
}
