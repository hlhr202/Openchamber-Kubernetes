import { z } from 'zod';
import { hasWellFormedUnicode, namespaceName, targetSchema } from './identity.ts';
import { parentReferenceSchema } from './branch-protocol.ts';
import { configSelectionSchema } from './configuration.ts';
import { protocolVersion } from './protocol.ts';

export const logBytes = 1_048_576;
export const logChunkCharacters = 65_536;
export const podLogReferenceSchema = parentReferenceSchema.extend({ resource: z.literal('pods'), namespace: namespaceName }).strict();
export type PodLogReference = z.infer<typeof podLogReferenceSchema>;
export const jobLogOriginSchema = parentReferenceSchema.extend({ resource: z.literal('jobs'), namespace: namespaceName }).strict();
export type JobLogOrigin = z.infer<typeof jobLogOriginSchema>;
export function jobLogOriginId(origin: JobLogOrigin | undefined): string { return origin ? JSON.stringify([origin.namespace, origin.name, origin.uid, origin.resourceVersion]) : ''; }
export function jobLogOriginFromParent(value: unknown): JobLogOrigin | null { const parsed = jobLogOriginSchema.safeParse(value); return parsed.success ? parsed.data : null; }
export const logOptionsSchema = z.object({ timestamps: z.boolean(), sinceSeconds: z.number().int().min(1).max(31_536_000).nullable(), tailLines: z.number().int().min(1).max(1_000_000).nullable() }).strict();
export const logContainerSchema = z.object({ name: namespaceName, kind: z.enum(['init', 'regular']) }).strict();
export const logBaseSchema = z.object({ protocol: z.literal(protocolVersion), target: targetSchema, selection: configSelectionSchema, reference: podLogReferenceSchema, origin: jobLogOriginSchema.optional() }).strict();
export const podLogRequestSchema = z.discriminatedUnion('kind', [
  logBaseSchema.extend({ kind: z.literal('containers') }).strict(),
  logBaseSchema.extend({ kind: z.literal('read'), container: namespaceName, options: logOptionsSchema, cursor: z.string().min(1).max(17_000).optional() }).strict(),
]).refine(value => !value.origin || value.origin.namespace === value.reference.namespace);
export type PodLogRequest = z.infer<typeof podLogRequestSchema>;
export const logContainersResponseSchema = z.object({ protocol: z.literal(protocolVersion), kind: z.literal('log-containers'), target: targetSchema,
  reference: podLogReferenceSchema, origin: jobLogOriginSchema.optional(), containers: z.array(logContainerSchema).min(1).max(128) }).strict();
export const podLogPageSchema = z.object({ protocol: z.literal(protocolVersion), kind: z.literal('pod-log'), target: targetSchema, reference: podLogReferenceSchema,
  origin: jobLogOriginSchema.optional(), container: namespaceName, options: logOptionsSchema, snapshotId: z.string().uuid(), totalBytes: z.number().int().min(0).max(logBytes), totalCharacters: z.number().int().min(0).max(logBytes),
  offset: z.number().int().min(0).max(logBytes), end: z.number().int().min(0).max(logBytes), text: z.string().max(logChunkCharacters).refine(hasWellFormedUnicode),
  nextCursor: z.string().min(1).max(17_000).nullable() }).strict();
export const podLogResponseSchema = z.discriminatedUnion('kind', [logContainersResponseSchema, podLogPageSchema]);
export type PodLogResponse = z.infer<typeof podLogResponseSchema>;
export type PodLogPage = z.infer<typeof podLogPageSchema>;
export function podLogReferenceId(value: PodLogReference): string { return JSON.stringify([value.namespace, value.name, value.uid, value.resourceVersion]); }

// Pure text consumer for read-only output. Never feed raw untrusted logs into a terminal parser.
// Retain original bytes in the bounded client snapshot; escape controls only for display.
export function logDisplayText(text: string): string {
  let result = '', start = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) {
      result += text.slice(start, index) + `\\u${code.toString(16).padStart(4, '0')}`; start = index + 1;
    }
  }
  return result + text.slice(start);
}
