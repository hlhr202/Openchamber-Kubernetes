import { z } from 'zod';
import { BoundaryError, errorCodes } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { containsControlCharacters, hasWellFormedUnicode } from './identity.ts';
import { helmChartReference, helmChartVersion } from './helm-inspect-protocol.ts';
import type { HelmRepositorySource } from './helm-repository-protocol.ts';

// Upstream helmDependencies (helm.exec.ts#L581-L635): from a repo chart/version node, fetch the chart
// archive into a temporary directory (`helm fetch <id> [--version v] -d <tempdir>`), run
// `helm dep list <chartPath>` on it, parse the tab-separated table (outputUtils.parseLineOutput with
// HELM_OUTPUT_COLUMN_SEPARATOR = /\t+/g), then delete the archive and the temp directory. The fetch
// download runs with the user's repositories.yaml READ-ONLY and writes ONLY into the plugin-isolated
// cache plus a plugin-owned temp directory under the service home (never system tmp). Upstream maps
// a header-only table to an error string; here a header-only table is a determinate EMPTY dependency
// list (disclosed deviation: no invented error code, no fake success text).
export const helmDependenciesRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('read'), chart: helmChartReference, version: helmChartVersion.optional() }).strict(),
]);
export type HelmDependenciesRequest = z.infer<typeof helmDependenciesRequestSchema>;
const cell = z.string().max(256);
export const helmDependenciesResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-dependencies'), chart: helmChartReference, version: helmChartVersion.optional(), headers: z.array(cell).max(4), rows: z.array(z.array(cell).max(4)).max(64) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-dependencies-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmDependenciesResponse = z.infer<typeof helmDependenciesResponseSchema>;
const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, '');
export function pluginCacheDirectory(home: string): string {
  if (home.length === 0 || home.length > 4096 || !home.startsWith('/') || home.startsWith('//') || home.includes('\\') || containsControlCharacters(home) || !hasWellFormedUnicode(home)) throw new BoundaryError('INVALID_INPUT');
  return `${trimTrailingSlashes(home)}/.openchamber-kubernetes/helm-cache`;
}
export function pluginTempRoot(home: string): string {
  if (home.length === 0 || home.length > 4096 || !home.startsWith('/') || home.startsWith('//') || home.includes('\\') || containsControlCharacters(home) || !hasWellFormedUnicode(home)) throw new BoundaryError('INVALID_INPUT');
  return `${trimTrailingSlashes(home)}/.openchamber-kubernetes/helm-tmp`;
}
const baseName = (directory: string) => trimTrailingSlashes(directory).split('/').pop() ?? '';
export function helmDependencyFetchArguments(chart: string, version: string | undefined, targetDirectory: string, source: HelmRepositorySource, home: string): { readonly args: readonly string[] } {
  const cache = `${pluginCacheDirectory(home)}/${baseName(source.paths.indexDirectory)}`;
  return { args: [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${cache}`, 'fetch', chart, ...(version ? ['--version', version] : []), '-d', targetDirectory] };
}
export function helmDependencyListArguments(chartPath: string): readonly string[] {
  return ['dep', 'list', chartPath]; // upstream literal: helmExecAsync(`dep list "${chartPath}"`)
}
const separator = /\t+/;
export function parseDependencyTable(stdout: string): { readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[] } {
  if (!hasWellFormedUnicode(stdout)) return { headers: [], rows: [] };
  const lines = stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0).slice(0, 65);
  const [headerLine, ...rest] = lines;
  if (!headerLine) return { headers: [], rows: [] };
  const headers = headerLine.split(separator).map(c => c.trim().slice(0, 256)).slice(0, 4);
  const rows = rest.slice(0, 64).map(line => line.split(separator).map(c => c.trim().slice(0, 256)).slice(0, 4));
  return { headers, rows }; // header-only table ⇒ rows: [] ⇒ the chart has no dependencies
}
export function dependenciesFailureCode(error: unknown): ErrorCode {
  return error instanceof BoundaryError && ['CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'HELM_INDEX_MISSING', 'FORBIDDEN', 'UNAUTHENTICATED', 'QUERY_CANCELLED', 'BUDGET_EXCEEDED', 'STATE_UNAVAILABLE', 'READ_TRANSPORT_UNAVAILABLE'].includes(error.code) ? error.code : 'STATE_UNAVAILABLE';
}
