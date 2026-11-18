import { z } from 'zod';

// This namespace stores memory and routes only the existing, finite project API.
// A workspace reference is not a filesystem/cluster authorization grant.
export const workspaceChunkBytes = 24_000;
export const workspacePayloadBytes = 4 * 1024 * 1024;
export const workspaceFrameBytes = 24 * 1024 * 1024;
export const workspaceReferenceSchema = z.object({
  workspace: z.string().uuid(), viewer: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const reference = workspaceReferenceSchema.shape;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const projectWorkspaceRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('attach'), directory: z.string().min(1).max(4096), locale: z.string().min(1).max(64), preferences: z.unknown().optional() }).strict(),
  z.object({ op: z.literal('read'), ...reference, after: revision, initial: z.boolean(), cursor: z.string().uuid().optional(), offset: revision.optional() }).strict(),
  z.object({ op: z.literal('command'), ...reference, sequence: revision, method: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,79}$/), args: z.array(z.unknown()).max(16) }).strict(),
  z.object({ op: z.literal('job'), ...reference, id: z.string().uuid() }).strict(),
  z.object({ op: z.literal('ack-job'), ...reference, id: z.string().uuid() }).strict(),
  z.object({ op: z.literal('ui'), ...reference, revision, value: z.record(z.string().max(512), z.unknown()) }).strict(),
  z.object({ op: z.literal('ui-patch'), ...reference, revision, start: revision, remove: revision, insert: z.string() }).strict(),
  z.object({ op: z.literal('upload-begin'), ...reference, bytes: z.number().int().min(1).max(workspacePayloadBytes) }).strict(),
  z.object({ op: z.literal('upload-part'), ...reference, id: z.string().uuid(), offset: revision, data: z.string().max(32_000) }).strict(),
  z.object({ op: z.literal('upload-finish'), ...reference, id: z.string().uuid() }).strict(),
  z.object({ op: z.literal('detach'), ...reference }).strict(),
]);
export type ProjectWorkspaceRequest = z.infer<typeof projectWorkspaceRequestSchema>;
export type WorkspaceReference = z.infer<typeof workspaceReferenceSchema>;
export type WorkspaceEffect = { kind: 'clipboard'; text: string } | { kind: 'open-url'; url: string } | { kind: 'storage'; key: string; value: unknown };
export type WorkspaceFrame = {
  version: number; states: Record<string, { version: number; args: unknown[] }>;
  selectors: Record<string, unknown>; ui?: { revision: number; value: Record<string, unknown> };
};
export const workspaceCallbackChannels = [
  'configuration', 'projectChanged', 'resources', 'branches', 'keyContent', 'podLogs', 'events', 'document', 'delete', 'namespace',
  'namespaceDelete', 'context', 'preference', 'sourceSelected', 'contextDelete', 'sourcePicker', 'sourceFileChosen', 'contextChoices',
  'inspection', 'explanation', 'watch', 'logFollow', 'eventFollow', 'jobLogSelection', 'logPreferences',
] as const;
