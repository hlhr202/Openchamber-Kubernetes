import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { BoundaryError } from './errors.ts';
import { utf8ByteLength } from './identity.ts';

export const preferencePrefix = 'k8s.sources.v1.';
export const preferenceStateSchema = z.object({ active: configSelectionSchema, known: z.array(configSelectionSchema).max(64) }).strict()
  .refine(value => new Set(value.known.map(item => JSON.stringify(item))).size === value.known.length);
export type SourcePreferences = z.infer<typeof preferenceStateSchema>;
export const preferenceRevisionSchema = z.object({ schemaVersion: z.literal(1), id: z.string().uuid(), parents: z.array(z.string().uuid()).max(64), preferences: preferenceStateSchema }).strict()
  .refine(value => new Set(value.parents).size === value.parents.length && !value.parents.includes(value.id));
export type PreferenceRevision = z.infer<typeof preferenceRevisionSchema>;
export type PreferenceLedger = { readonly revisions: readonly PreferenceRevision[]; readonly heads: readonly PreferenceRevision[]; readonly identity: string; readonly conflict: boolean; readonly preferences?: SourcePreferences; readonly serviceGeneration?: string };
export const preferenceReadRequestSchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), serviceGeneration: z.string().uuid(), kind: z.literal('keys') }).strict(),
  z.object({ protocol: z.literal(2), serviceGeneration: z.string().uuid(), kind: z.literal('get'), id: z.string().uuid() }).strict(),
]);
export const preferenceAppendRequestSchema = z.discriminatedUnion('step', [
  z.object({ protocol: z.literal(2), serviceGeneration: z.string().uuid(), notAfter: z.number().int().nonnegative(), step: z.literal('known'), revision: preferenceRevisionSchema }).strict(),
  z.object({ protocol: z.literal(2), serviceGeneration: z.string().uuid(), notAfter: z.number().int().nonnegative(), step: z.literal('active'), revision: preferenceRevisionSchema,
    selection: configSelectionSchema, configIdentity: z.string().min(1).max(1024) }).strict(),
]);
export type PreferenceAppendRequest = z.infer<typeof preferenceAppendRequestSchema>;
export const preferenceReplySchema = z.discriminatedUnion('kind', [
  z.object({ protocol: z.literal(2), serviceGeneration: z.string().uuid(), kind: z.literal('keys'), keys: z.array(z.string().max(128)).max(64) }).strict(),
  z.object({ protocol: z.literal(2), serviceGeneration: z.string().uuid(), kind: z.literal('get'), revision: preferenceRevisionSchema.nullable() }).strict(),
  z.object({ protocol: z.literal(2), serviceGeneration: z.string().uuid(), kind: z.literal('stored'), id: z.string().uuid() }).strict(),
]);
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

// Independent read projection, not a revision/write planner. No SDK/operations import or write method.
export function projectPreferenceLedger(input: readonly { key: string; value: unknown }[]): PreferenceLedger {
  if (input.length > 64) throw new BoundaryError('QUERY_LIMIT');
  let bytes = 0;
  const revisions = input.map(item => {
    let encoded: string | undefined;
    try { encoded = JSON.stringify(item.value); } catch { throw new BoundaryError('CONFIG_INVALID'); }
    if (!encoded) throw new BoundaryError('CONFIG_INVALID');
    bytes += utf8ByteLength(encoded); if (utf8ByteLength(encoded) > 48_000 || bytes > 1_500_000) throw new BoundaryError('BUDGET_EXCEEDED');
    const parsed = preferenceRevisionSchema.safeParse(item.value);
    if (!parsed.success || item.key !== `${preferencePrefix}${parsed.data.id}`) throw new BoundaryError('CONFIG_INVALID');
    return parsed.data;
  }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const byId = new Map(revisions.map(value => [value.id, value]));
  if (byId.size !== revisions.length) throw new BoundaryError('CONFIG_INVALID');
  const visited = new Set<string>(), visiting = new Set<string>(), parents = new Set<string>();
  const visit = (value: PreferenceRevision): void => {
    if (visited.has(value.id)) return; if (visiting.has(value.id)) throw new BoundaryError('CONFIG_INVALID'); visiting.add(value.id);
    for (const id of value.parents) { const parent = byId.get(id); if (!parent) throw new BoundaryError('STALE_TARGET'); parents.add(id); visit(parent); }
    visiting.delete(value.id); visited.add(value.id);
  };
  for (const value of revisions) visit(value);
  const heads = revisions.filter(value => !parents.has(value.id));
  return freeze({ revisions, heads, identity: JSON.stringify(revisions), conflict: heads.length > 1,
    ...(heads.length === 1 && heads[0] ? { preferences: heads[0].preferences } : {}) });
}
