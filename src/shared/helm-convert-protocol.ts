import { z } from 'zod';
import { BoundaryError, errorCodes } from './errors.ts';
import type { ErrorCode } from './errors.ts';
import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts';

// Upstream convertToTemplate (helm.authoring.ts#L25-L176): take a resource YAML (explorer node,
// file, or active text), pick-or-create a chart, templatise it (strip cluster metadata/status and
// the last-applied annotation, set the fullname name expression and the chart label expression),
// ask for a template name, then write `<chart>/templates/<name>.yaml` and open it. Here the input
// document arrives in the request (bounded), the chart is an EXPLICIT canonical workspace location
// (root + relative path, schema-validated) and the template name a bounded token — no chart
// auto-discovery, no quick-pick and NO auto-create (upstream may create a chart before the user
// cancels and can only report the leftover directory; the explicit form avoids that partial
// side effect entirely — disclosed narrower scope). The written file is NEVER overwritten
// (upstream TODO admits the existence check is missing; we refuse with DOCUMENT_DIRTY). The new
// file is not auto-opened (host UI action).
export const helmTemplateName = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const helmConvertRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('run'), root: workspaceRootSchema, path: workspaceRelativeSchema, name: helmTemplateName, document: z.string().min(1).max(46_080) }).strict(),
]);
export type HelmConvertRequest = z.infer<typeof helmConvertRequestSchema>;
export const helmConvertResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-template-written'), root: workspaceRootSchema, path: workspaceRelativeSchema, name: helmTemplateName }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-convert-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmConvertResponse = z.infer<typeof helmConvertResponseSchema>;
// Canonical join of two already-validated components; no normalization tricks, no escapes.
export function workspaceChartDirectory(root: string, path: string): string {
  return path === '' ? root : `${root}/${path}`;
}
export function templateFilePath(root: string, path: string, name: string): string {
  return `${workspaceChartDirectory(root, path)}/templates/${name}.yaml`;
}
export function convertFailureCode(error: unknown): ErrorCode {
  return error instanceof BoundaryError && ['INVALID_INPUT', 'DOCUMENT_DIRTY', 'CONTENT_INVALID', 'BUDGET_EXCEEDED', 'QUERY_CANCELLED', 'STATE_UNAVAILABLE'].includes(error.code) ? error.code : 'STATE_UNAVAILABLE';
}
