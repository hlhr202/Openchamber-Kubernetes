import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { boundedName } from './identity.ts';

// Upstream helmTemplatePreview (helm.exec.ts#L132-L153, registered at extension.ts#L243) requires
// an active editor ('No active editor.'), a template path containing 'templates'
// ('Not a template: <filePath>') and the Helm tool (ensureHelm Alert), then opens the FIXED
// preview URI in ViewColumn.Two titled `Preview <basename>` and records that a preview was shown.
// The document provider (helm.documentProvider.ts#L165-L231) resolves: without an active editor it
// logs 'FIXME: no editor selected'; it probes the syntax version, attributes the file to its
// top-most chart via pickChartForFile(warnIfNoCharts), derives the relative template path, and
// renders `template "<chartPath>" --show-only "<reltpl>"` on v3/v4 versus --execute on v2; a
// non-zero exit yields the error document 'Chart Preview' / 'Failed template call'; output is
// YAML-validated (never for NOTES.txt) reporting `YAML failed to parse: <message>`; empty output
// yields 'Helm template produced no output'. On save (extension.ts#L329-L345) the preview
// refreshes only for the ACTIVE file-scheme document, else logs 'WARNING: No active editor during
// save. Helm preview was not updated.'. DELIVERY NOTE: this increment ships the bounded protocol
// and the upstream-verbatim pure projections under static review; SERVER-SIDE EXECUTION IS DELIBERATELY DEFERRED — the Helm CLI render, the preview webview and the save refresh run in
// the HUMAN package environment (NORMAL case: the template file is attributed to its chart and
// rendered with --show-only on v3/v4 versus --execute on v2, and a dirty buffer is never
// auto-saved; CANCEL_FAILURE case: no editor, a non-template path, no chart, a CLI failure or a
// YAML failure is explicit — no hung promise and never another file's execution; STALE case: the
// fixed preview URI never crosses active editors or projects, and the save refresh stays explicit
// and controlled — it never becomes an auto-verify authorisation). No automated execution exists
// anywhere.
export const helmTemplatePreviewRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('preview') }).strict(),
]);
export type HelmTemplatePreviewRequest = z.infer<typeof helmTemplatePreviewRequestSchema>;
export const helmTemplatePreviewResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('preview-opened'), title: boundedName.max(512) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('no-active-editor') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('not-a-template') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('preview-rendered'), isErrorOutput: z.boolean() }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('preview-failed') }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('preview-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmTemplatePreviewResponse = z.infer<typeof helmTemplatePreviewResponseSchema>;
// Upstream gate verbatim: the path must contain 'templates'.
export function isTemplatePath(filePath: string): boolean {
  return filePath.indexOf('templates') >= 0;
}
// Upstream messages and titles verbatim.
export function noActiveEditorMessage(): string {
  return 'No active editor.';
}
export function notATemplateMessage(filePath: string): string {
  return 'Not a template: ' + filePath;
}
export function previewTitle(basename: string): string {
  return `Preview ${basename}`;
}
export function noEditorLogText(): string {
  return 'FIXME: no editor selected';
}
export function saveNoEditorLogText(): string {
  return 'WARNING: No active editor during save. Helm preview was not updated.';
}
export function yamlParseFailedMessage(errorMessage: string): string {
  return `YAML failed to parse: ${errorMessage}`;
}
export function noOutputContent(): string {
  return 'Helm template produced no output';
}
export function errorDocumentTitle(): string {
  return 'Chart Preview';
}
export function errorDocumentSubtitle(): string {
  return 'Failed template call';
}
// Upstream version branch verbatim: v3/v4 render with --show-only, v2 with --execute.
export function templateArguments(chartPath: string, reltpl: string, version: 2 | 3 | 4): readonly string[] {
  return version === 3 || version === 4 ? ['template', `"${chartPath}"`, '--show-only', `"${reltpl}"`] : ['template', `"${chartPath}"`, '--execute', `"${reltpl}"`];
}
// Upstream NOTES.txt gate verbatim: NOTES.txt output is never YAML-validated.
export function skipsYamlValidation(reltpl: string): boolean {
  return reltpl.split('/').at(-1) === 'NOTES.txt';
}
// Upstream preview document verbatim: output or the fixed no-output content, flagged as error.
export function previewDocument(out: string, reltpl: string): { title: string; content: string; isErrorOutput: boolean } {
  return out ? { title: reltpl, content: out, isErrorOutput: false } : { title: reltpl, content: 'Helm template produced no output', isErrorOutput: true };
}
// Upstream save-refresh gate verbatim: only the ACTIVE file-scheme document refreshes the preview.
export function saveShouldRefresh(hasActiveEditor: boolean, savedIsActiveDocument: boolean, scheme: string): boolean {
  return hasActiveEditor && savedIsActiveDocument && scheme === 'file';
}
