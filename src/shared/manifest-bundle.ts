import { z } from 'zod';
import { BoundaryError } from './errors.ts';
import { documentBytes } from './document-protocol.ts';
import { containsControlCharacters, hasWellFormedUnicode } from './identity.ts';
const metadata = z.string().min(1).max(1024).refine(value => hasWellFormedUnicode(value) && !containsControlCharacters(value));
const document = z.object({ index: z.number().int().nonnegative().max(31), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
  shape: z.enum(['mapping', 'sequence', 'scalar', 'empty']), apiVersion: metadata.optional(), kind: metadata.optional(), name: metadata.optional(), namespace: metadata.optional() }).strict();
const bundle = z.object({ format: z.enum(['yaml', 'json']), characters: z.number().int().nonnegative().max(documentBytes), documents: z.array(document).min(1).max(32) }).strict();
export type ManifestDocument = z.infer<typeof document>;
export type ManifestBundle = z.infer<typeof bundle>;
// Portable summaries only. The YAML parser stays in host, never imported by shared buffer contracts.
export function readManifestBundle(input: unknown): ManifestBundle {
  const parsed = bundle.safeParse(input); if (!parsed.success) throw new BoundaryError('CONTENT_INVALID'); let previousEnd = 0;
  for (const [index, item] of parsed.data.documents.entries()) {
    if (item.index !== index || item.start < previousEnd || item.end < item.start || item.end > parsed.data.characters) throw new BoundaryError('CONTENT_INVALID');
    Object.freeze(item); previousEnd = item.end;
  }
  Object.freeze(parsed.data.documents); return Object.freeze(parsed.data);
}
