import { z } from 'zod';
import { BoundaryError, errorCodes } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { containsControlCharacters, hasWellFormedUnicode } from './identity.ts';
import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts';
import type { HelmRepositorySource } from './helm-repository-protocol.ts';

// Upstream helmCreate (helm.exec.ts#L182-L240): showWorkspaceFolderPick + a name input box, then
// `helm create "<folder>/<name>"` which scaffolds the chart directory; on success an OPTIONAL
// open/reveal action is offered. Here the parent folder is a canonical workspace location (root +
// relative path, schema-validated) and the name is bounded to the same token set the repository
// explorer uses (upstream interpolates the raw input into a shell string; the schema is the strict
// port). No implicit install, no auto-open (the created path is only reported — upstream's
// open/reveal is a host UI action, disclosed deviation). The run stays in the isolated PATH-only
// environment; only bounded stdout is retained, stderr never.
export const helmChartName = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const helmCreateRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), root: workspaceRootSchema, path: workspaceRelativeSchema, name: helmChartName }).strict(),
]);
export type HelmCreateRequest = z.infer<typeof helmCreateRequestSchema>;
export const helmCreateResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-chart-created'), root: workspaceRootSchema, path: workspaceRelativeSchema, name: helmChartName, content: z.string().max(16_384) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-chart-create-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmCreateResponse = z.infer<typeof helmCreateResponseSchema>;
// Canonical joins of already-validated components; no normalization tricks, no escapes.
export function workspaceChartDirectory(root: string, path: string): string {
  return path === '' ? root : `${root}/${path}`;
}
export function createdChartPath(root: string, path: string, name: string): string {
  return `${workspaceChartDirectory(root, path)}/${name}`;
}
const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, '');
export function pluginCacheDirectory(home: string): string {
  if (home.length === 0 || home.length > 4096 || !home.startsWith('/') || home.startsWith('//') || home.includes('\\') || containsControlCharacters(home) || !hasWellFormedUnicode(home)) throw new BoundaryError('INVALID_INPUT');
  return `${trimTrailingSlashes(home)}/.openchamber-kubernetes/helm-cache`;
}
const baseName = (directory: string) => trimTrailingSlashes(directory).split('/').pop() ?? '';
export function createArguments(root: string, path: string, name: string, source: HelmRepositorySource, home: string): { readonly args: readonly string[] } {
  const cache = `${pluginCacheDirectory(home)}/${baseName(source.paths.indexDirectory)}`;
  return { args: [`--repository-config=${source.paths.repositoryFile}`, `--repository-cache=${cache}`, 'create', createdChartPath(root, path, name)] };
}
export function createFailureCode(error: unknown): ErrorCode {
  return error instanceof BoundaryError && ['CLI_NOT_FOUND', 'CLI_INCOMPATIBLE', 'FORBIDDEN', 'UNAUTHENTICATED', 'QUERY_CANCELLED', 'BUDGET_EXCEEDED', 'STATE_UNAVAILABLE', 'READ_TRANSPORT_UNAVAILABLE'].includes(error.code) ? error.code : 'STATE_UNAVAILABLE';
}
