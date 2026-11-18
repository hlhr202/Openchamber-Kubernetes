import { z } from 'zod';
import { containsControlCharacters, hasWellFormedUnicode } from './identity.ts';
export const workspaceBytes = 1_048_576, workspaceChunkCharacters = 16_384;
const safeText = (value: string) => !containsControlCharacters(value) && hasWellFormedUnicode(value);
export const workspaceRootSchema = z.string().min(2).max(4096).refine(value => value.startsWith('/') && !value.startsWith('//') && !value.endsWith('/') && safeText(value) && !value.includes('\\') && value.split('/').length <= 65 && value.split('/').slice(1).every(part => !!part && part !== '.' && part !== '..'));
export const workspaceRelativeSchema = z.string().max(4096).refine(value => safeText(value) && !value.includes('\\') && (!value || value.split('/').length <= 32 && value.split('/').every(part => !!part && part !== '.' && part !== '..')));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const workspaceScopeSchema = z.object({ generation: z.string().min(1).max(1024), id: z.uuid(), token: hash }).strict();
export type WorkspaceScope = z.infer<typeof workspaceScopeSchema>;
export const workspaceOpenSchema = z.object({ protocol: z.literal(2), root: workspaceRootSchema }).strict();
export const workspaceReadSchema = z.object({ protocol: z.literal(2), scope: workspaceScopeSchema, path: workspaceRelativeSchema, cursor: z.string().min(1).max(17000).optional() }).strict();
export const workspaceReleaseSchema = z.object({ protocol: z.literal(2), scope: workspaceScopeSchema }).strict();
export const workspaceScopePageSchema = z.object({ protocol: z.literal(2), kind: z.literal('workspace-scope'), scope: workspaceScopeSchema, root: workspaceRootSchema, expiresAt: z.number().int().nonnegative() }).strict();
export type WorkspaceScopePage = z.infer<typeof workspaceScopePageSchema>;
export const workspaceProofSchema = z.string().min(6).max(17000).regex(/^wsp1\.[A-Za-z0-9_-]+$/);
export const workspaceRebindSchema = z.object({ protocol: z.literal(2), root: workspaceRootSchema, path: workspaceRelativeSchema.refine(value => !!value), proof: workspaceProofSchema }).strict();
export const workspaceRebindPageSchema = z.object({ protocol: z.literal(2), kind: z.literal('workspace-rebind'), scope: workspaceScopeSchema, root: workspaceRootSchema, path: workspaceRelativeSchema.refine(value => !!value),
  version: hash, identity: hash, proof: workspaceProofSchema, expiresAt: z.number().int().nonnegative() }).strict();
export type WorkspaceRebindPage = z.infer<typeof workspaceRebindPageSchema>;
export const workspaceEntrySchema = z.object({ name: z.string().min(1).max(255).refine(value => safeText(value) && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')), kind: z.enum(['file', 'directory', 'blocked']) }).strict();
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;
export const workspaceListSchema = z.object({ protocol: z.literal(2), scope: workspaceScopeSchema, path: workspaceRelativeSchema, showHidden: z.boolean(), offset: z.number().int().min(0).max(2000), listingIdentity: hash.optional() }).strict().refine(value => value.offset === 0 || value.listingIdentity !== undefined);
export function workspaceParent(path: string): string | null { return path === '' ? null : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; }
export const workspaceListPageSchema = z.object({ protocol: z.literal(2), kind: z.literal('workspace-directory'), scope: workspaceScopeSchema, root: workspaceRootSchema, path: workspaceRelativeSchema,
  parent: workspaceRelativeSchema.nullable(), showHidden: z.boolean(), listingIdentity: hash, offset: z.number().int().min(0).max(2000), total: z.number().int().min(0).max(2000), nextOffset: z.number().int().min(1).max(2000).nullable(), entries: z.array(workspaceEntrySchema).max(100) }).strict()
  .refine(value => value.parent === workspaceParent(value.path) && value.offset + value.entries.length <= value.total && new Set(value.entries.map(entry => entry.name)).size === value.entries.length
    && value.entries.every((entry, index) => (value.showHidden || !entry.name.startsWith('.')) && (!index || (value.entries[index - 1]?.name ?? '') < entry.name))
    && (value.offset + value.entries.length < value.total ? value.entries.length === 100 && value.nextOffset === value.offset + 100 : value.nextOffset === null));
export type WorkspaceListPage = z.infer<typeof workspaceListPageSchema>;
export const workspaceFilePageSchema = z.object({ protocol: z.literal(2), kind: z.literal('workspace-file'), scope: workspaceScopeSchema, root: workspaceRootSchema, path: workspaceRelativeSchema.refine(value => !!value),
  version: hash, identity: hash, proof: workspaceProofSchema, totalBytes: z.number().int().min(0).max(workspaceBytes), totalCharacters: z.number().int().min(0).max(workspaceBytes),
  offset: z.number().int().min(0).max(workspaceBytes), end: z.number().int().min(0).max(workspaceBytes), text: z.string().max(workspaceChunkCharacters), nextCursor: z.string().min(1).max(17000).nullable() }).strict()
  .refine(value => value.end === value.offset + value.text.length && value.end <= value.totalCharacters && hasWellFormedUnicode(value.text));
export type WorkspaceFilePage = z.infer<typeof workspaceFilePageSchema>;
