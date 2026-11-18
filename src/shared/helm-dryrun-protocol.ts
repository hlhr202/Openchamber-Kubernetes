import { z } from 'zod';
import { BoundaryError, errorCodes } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { containsControlCharacters, hasWellFormedUnicode } from './identity.ts';
import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts';
import type { HelmSyntax } from './helm-version-protocol.ts';
import type { HelmRepositorySource } from './helm-repository-protocol.ts';

// Upstream helmDryRun (helm.exec.ts): pickChart, then a syntax-probed install with dry-run flags —
// `install ${dryRunArg} ${generateNameArg} --debug "<path>"` where dryRunArg is `--dry-run=client`
// for v4 (plain `--dry-run` otherwise) and generateNameArg is `--generate-name` for v3/v4 only.
// Here the chart directory is a canonical workspace location (root + relative path, both
// schema-validated). The run is an explicit user action (never a read exemption), in the isolated
// PATH-only environment with the user's repositories.yaml READ-ONLY and any dependency download
// redirected into the plugin-isolated cache. Only bounded stdout is retained; stderr is never
// retained (upstream logs both — disclosed deviation). The probed syntax is echoed so the argument
// branch is auditable.
export const helmDryRunRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), root: workspaceRootSchema, path: workspaceRelativeSchema }).strict(),
]);
export type HelmDryRunRequest = z.infer<typeof helmDryRunRequestSchema>;
export const helmDryRunResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-dry-ran'), root: workspaceRootSchema, path: workspaceRelativeSchema, syntax: z.enum(['v2', 'v3', 'v4', 'unknown']), content: z.string().max(16_384) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-dry-run-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmDryRunResponse = z.infer<typeof helmDryRunResponseSchema>;
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
// Upstream argument branch, verbatim: v4 uses --dry-run=client; v3/v4 add --generate-name.
export function dryRunArguments(syntax: HelmSyntax, root: string, path: string, source: HelmRepositorySource, home: string): { readonly args: readonly string[] } {
  const cache = `${pluginCacheDirectory(home)}/${baseName(source.paths.indexDirectory)}`;
  const dryRunArg = syntax === 'v4' ? '--dry-run=client' : '--dry-run';
  const generateNameArg = syntax === 'v3' || syntax === 'v4' ? ['--generate-name'] : [];
  return { args: [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${cache}`, 'install', dryRunArg, ...generateNameArg, '--debug', workspaceChartDirectory(root, path)] };
}
export function dryRunFailureCode(error: unknown): ErrorCode {
  return error instanceof BoundaryError && ['CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'FORBIDDEN', 'UNAUTHENTICATED', 'QUERY_CANCELLED', 'BUDGET_EXCEEDED', 'STATE_UNAVAILABLE', 'READ_TRANSPORT_UNAVAILABLE'].includes(error.code) ? error.code : 'STATE_UNAVAILABLE';
}
