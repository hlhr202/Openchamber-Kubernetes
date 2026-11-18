import { z } from 'zod';
import { errorCodes } from './errors.ts';
import { helmChartName } from './helm-create-protocol.ts';

// Upstream convertToParameter (helm.authoring.ts#L189-L355): with a Helm template open and a
// YAML field value selected, the value is replaced in the TEMPLATE BUFFER by
// `{{ .Values.<templateName>.<field> }}` and the actual value is inserted into the chart's
// values.yaml (creating it empty when missing), via unsaved workspace edits. Here the PURE core is
// the strict port: locate the single `field: value` scalar assignment in the supplied template
// text, produce the updated template text and the values entry text. Nothing is written to any
// buffer, document or clipboard — the two bounded texts are displayed for the human to place
// (upstream's applyEdit is a host editor action, disclosed deviation). Ambiguity (more than one
// exact assignment) is an explicit failure, never a guess and never recursive disambiguation.
export const helmParameteriseRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('read'), template: helmChartName, field: helmChartName, value: z.string().min(1).max(1024).refine(v => !/[\n\r\t]/.test(v)), document: z.string().min(1).max(46_080) }).strict(),
]);
export type HelmParameteriseRequest = z.infer<typeof helmParameteriseRequestSchema>;
export const helmParameteriseResponseSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), kind: z.literal('helm-parameterised'), template: helmChartName, field: helmChartName, keyReference: z.string().max(265), document: z.string().max(46_080), entry: z.string().max(2048) }).strict(),
  z.object({ protocol: z.literal(2), kind: z.literal('helm-parameterised-unavailable'), code: z.enum(errorCodes) }).strict(),
]);
export type HelmParameteriseResponse = z.infer<typeof helmParameteriseResponseSchema>;
// Upstream keyPath = [templateName, fieldName] joined with dots; both components are schema-bounded
// tokens, so upstream sanitiseForGoTemplate is the identity here.
export function keyReference(template: string, field: string): string {
  return `${template}.${field}`;
}
export function parameterReference(template: string, field: string): string {
  return `{{ .Values.${keyReference(template, field)} }}`;
}
export function entryText(template: string, field: string, value: string): string {
  return `${template}:\n  ${field}: ${value}\n`;
}
