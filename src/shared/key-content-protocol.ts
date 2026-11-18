import { z } from 'zod';
import { boundedName, containsControlCharacters, hasWellFormedUnicode, namespaceName, targetSchema } from './identity.ts';
import { configSelectionSchema } from './configuration.ts';
import { configKeyNodeSchema, parentReferenceSchema } from './branch-protocol.ts';
import { protocolVersion } from './protocol.ts';

export const keyContentBytes = 1_048_576;
export const keyContentChunkCharacters = 65_536;
export const keyDisplayCharacters = 1_398_104;
export const keyReferenceSchema = z.object({ parent: parentReferenceSchema.extend({ resource: z.enum(['configmaps', 'secrets']), namespace: namespaceName }).strict(), key: boundedName }).strict();
export type KeyReference = z.infer<typeof keyReferenceSchema>;
export const keyContentRequestSchema = z.object({ protocol: z.literal(protocolVersion), selection: configSelectionSchema, target: targetSchema,
  reference: keyReferenceSchema, cursor: z.string().min(1).max(17_000).optional() }).strict();
export type KeyContentRequest = z.infer<typeof keyContentRequestSchema>;
export const keyContentResponseSchema = z.object({ protocol: z.literal(protocolVersion), kind: z.literal('key-content'), target: targetSchema,
  reference: keyReferenceSchema, encoding: z.enum(['utf8', 'base64']), totalBytes: z.number().int().min(0).max(keyContentBytes),
  totalCharacters: z.number().int().min(0).max(keyDisplayCharacters), offset: z.number().int().min(0).max(keyDisplayCharacters), end: z.number().int().min(0).max(keyDisplayCharacters),
  text: z.string().max(keyContentChunkCharacters).refine(hasWellFormedUnicode), contentIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  nextCursor: z.string().min(1).max(17_000).nullable() }).strict();
export type KeyContentResponse = z.infer<typeof keyContentResponseSchema>;

// A display policy, not a transcoder: preserve bytes, display non-UTF8/control-bearing content as base64.
export function isDisplayText(value: string): boolean {
  return hasWellFormedUnicode(value) && ![...value].some(character => character !== '\n' && character !== '\r' && character !== '\t' && containsControlCharacters(character));
}
export function keyReferenceId(reference: KeyReference): string {
  const parent = reference.parent;
  return JSON.stringify([parent.resource, parent.namespace, parent.name, parent.uid, parent.resourceVersion, reference.key]);
}

export function keyReferenceFromNode(input: unknown): KeyReference | null {
  const parsed = configKeyNodeSchema.safeParse(input);
  if (!parsed.success) return null;
  const node = parsed.data, identity = node.resource;
  if (identity.group !== '' || identity.version !== 'v1' || identity.scope !== 'namespace' || node.label !== node.key
    || !((identity.resource === 'secrets' && identity.kind === 'Secret') || (identity.resource === 'configmaps' && identity.kind === 'ConfigMap'))) return null;
  const reference = keyReferenceSchema.safeParse({ parent: { resource: identity.resource, name: identity.name, namespace: identity.namespace,
    uid: identity.uid, resourceVersion: identity.resourceVersion }, key: node.key });
  return reference.success ? reference.data : null;
}
