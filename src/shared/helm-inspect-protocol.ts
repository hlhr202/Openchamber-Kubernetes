import { z } from 'zod';
import { BoundaryError, errorCodes } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { containsControlCharacters, hasWellFormedUnicode } from './identity.ts';
import type { HelmRepositorySource } from './helm-repository-protocol.ts';
import type { HelmSyntax } from './helm-version-protocol.ts';

// Upstream helmInspectChart (helm.exec.ts#L265-L310) opens the INSPECT_CHART_SCHEME virtual document;
// HelmInspectDocumentProvider (helm.documentProvider.ts#L92-L121) runs `helm inspect [all] <id>
// [--version <v>]` after a syntax probe (v2 omits the `all` scope). The command downloads the chart
// into the repository cache, so here it runs with the user's repositories.yaml READ-ONLY and every
// download writing ONLY into the plugin-isolated cache directory — the same isolation as the repo
// refresh. Preview text is bounded; stderr is never retained.
export const helmChartReference = z.string().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
export const helmChartVersion = z.string().min(1).max(63).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const helmInspectRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('read'), chart: helmChartReference, version: helmChartVersion.optional() }).strict(),
]);
export type HelmInspectRequest = z.infer<typeof helmInspectRequestSchema>;
export const helmInspectResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-chart-inspected'), chart: helmChartReference, version: helmChartVersion.optional(), content: z.string().max(16_384) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-chart-inspect-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmInspectResponse = z.infer<typeof helmInspectResponseSchema>;
// Upstream `shell.isSafe` rejects anything outside a safe token set; the schema above is the strict
// port (no spaces/shell metacharacters, no control characters, no empty or oversized tokens).
export const inspectScope = (syntax: HelmSyntax): 'none' | 'all' => (syntax === 'v2' ? 'none' : 'all'); // upstream: only v2 omits `all`
const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, '');
export function pluginCacheDirectory(home: string): string {
  if (home.length === 0 || home.length > 4096 || !home.startsWith('/') || home.startsWith('//') || home.includes('\\') || containsControlCharacters(home) || !hasWellFormedUnicode(home)) throw new BoundaryError('INVALID_INPUT');
  return `${trimTrailingSlashes(home)}/.openchamber-kubernetes/helm-cache`;
}
const baseName = (directory: string) => trimTrailingSlashes(directory).split('/').pop() ?? '';
export function helmInspectArguments(syntax: HelmSyntax, chart: string, version: string | undefined, source: HelmRepositorySource, home: string): { readonly args: readonly string[]; readonly cache: string } {
  const cache = `${pluginCacheDirectory(home)}/${baseName(source.paths.indexDirectory)}`;
  const scope = inspectScope(syntax);
  return { args: [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${cache}`, 'inspect', ...(scope === 'all' ? ['all'] : []), chart, ...(version ? ['--version', version] : [])], cache };
}
export function inspectFailureCode(error: unknown): ErrorCode {
  return error instanceof BoundaryError && ['CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'HELM_INDEX_MISSING', 'FORBIDDEN', 'UNAUTHENTICATED', 'QUERY_CANCELLED', 'BUDGET_EXCEEDED', 'STATE_UNAVAILABLE', 'READ_TRANSPORT_UNAVAILABLE'].includes(error.code) ? error.code : 'STATE_UNAVAILABLE';
}
