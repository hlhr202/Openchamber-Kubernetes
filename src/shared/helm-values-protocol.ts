import { z } from 'zod';
import { BoundaryError, errorCodes } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { containsControlCharacters, hasWellFormedUnicode } from './identity.ts';
import { helmChartReference, helmChartVersion } from './helm-inspect-protocol.ts';
import type { HelmRepositorySource } from './helm-repository-protocol.ts';

// Upstream helmFetchValues (helm.exec.ts#L256-L262) is the SAME helmInspect dispatcher with
// FETCH_VALUES_SCHEME and generateFile: true — HelmInspectDocumentProvider runs
// `helm inspect values <id> [--version <v>]` (NO `all` scope regardless of syntax) into a virtual
// document; the user, not the plugin, decides whether it ever lands on disk. The command downloads
// the chart into the repository cache, so it runs with the user's repositories.yaml READ-ONLY and
// every download writing ONLY into the plugin-isolated cache directory. Preview text is bounded;
// stderr is never retained; nothing is written to any workspace by this chain.
export const helmValuesRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('read'), chart: helmChartReference, version: helmChartVersion.optional() }).strict(),
]);
export type HelmValuesRequest = z.infer<typeof helmValuesRequestSchema>;
export const helmValuesResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-values-fetched'), chart: helmChartReference, version: helmChartVersion.optional(), content: z.string().max(16_384) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-values-fetch-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmValuesResponse = z.infer<typeof helmValuesResponseSchema>;
const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, '');
export function pluginCacheDirectory(home: string): string {
  if (home.length === 0 || home.length > 4096 || !home.startsWith('/') || home.startsWith('//') || home.includes('\\') || containsControlCharacters(home) || !hasWellFormedUnicode(home)) throw new BoundaryError('INVALID_INPUT');
  return `${trimTrailingSlashes(home)}/.openchamber-kubernetes/helm-cache`;
}
const baseName = (directory: string) => trimTrailingSlashes(directory).split('/').pop() ?? '';
export function helmValuesArguments(chart: string, version: string | undefined, source: HelmRepositorySource, home: string): { readonly args: readonly string[]; readonly cache: string } {
  const cache = `${pluginCacheDirectory(home)}/${baseName(source.paths.indexDirectory)}`;
  return { args: [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${cache}`, 'inspect', 'values', chart, ...(version ? ['--version', version] : [])], cache };
}
export function valuesFailureCode(error: unknown): ErrorCode {
  return error instanceof BoundaryError && ['CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'HELM_INDEX_MISSING', 'FORBIDDEN', 'UNAUTHENTICATED', 'QUERY_CANCELLED', 'BUDGET_EXCEEDED', 'STATE_UNAVAILABLE', 'READ_TRANSPORT_UNAVAILABLE'].includes(error.code) ? error.code : 'STATE_UNAVAILABLE';
}
