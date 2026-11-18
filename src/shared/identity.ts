import { z } from 'zod';
import { BoundaryError } from './errors.ts';

export function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) { const code = character.codePointAt(0) ?? 0; bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4; }
  return bytes;
}
export function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) { const next = value.charCodeAt(++index); if (!(next >= 0xDC00 && next <= 0xDFFF)) return false; }
    else if (code >= 0xDC00 && code <= 0xDFFF) return false;
  }
  return true;
}
export const boundedName = z.string().min(1).max(1024).refine(value => !containsControlCharacters(value));
export const namespaceName = z.string().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
export const dnsName = z.string().min(1).max(253).refine(value => value.split('.').every(part => namespaceName.safeParse(part).success));
export const apiGroup = z.union([z.literal(''), dnsName]);
export const apiVersion = z.string().min(1).max(63).regex(/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/);
export const resourceName = z.string().min(1).max(253).regex(/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/);
export const targetSchema = z.object({
  serviceGeneration: boundedName,
  projectId: boundedName,
  configIdentity: boundedName,
  context: boundedName,
  namespace: namespaceName,
}).strict();
export type TargetIdentity = z.infer<typeof targetSchema>;

export const resourceTypeSchema = z.object({
  group: apiGroup,
  version: apiVersion,
  resource: resourceName,
  scope: z.enum(['cluster', 'namespace']),
  kind: boundedName,
}).strict();
export type ResourceType = z.infer<typeof resourceTypeSchema>;
export type ResourceIdentity = ResourceType & {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
};

export function readTarget(value: unknown): TargetIdentity {
  const parsed = targetSchema.safeParse(value);
  if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
  return Object.freeze(parsed.data);
}

// JSON tuples are unambiguous even when context or configuration names contain separators.
export function stableNodeId(target: TargetIdentity, ...parts: readonly string[]): string {
  return JSON.stringify([
    target.serviceGeneration, target.projectId, target.configIdentity,
    target.context, target.namespace, ...parts,
  ]);
}

export function sameTarget(left: TargetIdentity, right: TargetIdentity): boolean {
  return stableNodeId(left) === stableNodeId(right);
}
