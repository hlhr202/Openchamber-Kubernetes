import { z } from 'zod';
import { configSelectionSchema } from './configuration.ts';
import { documentReferenceSchema } from './document-protocol.ts';
import { definitionReferenceSchema } from './branch-protocol.ts';
import { containsControlCharacters, hasWellFormedUnicode, targetSchema } from './identity.ts';

export const openApiSchemaBytes = 8_000_000;
export const explainField = z.string().min(1).max(256).refine(value => hasWellFormedUnicode(value) && !containsControlCharacters(value));
export const explainPath = z.array(explainField).max(32);
function builtinType(type: z.infer<typeof documentReferenceSchema.shape.type>) {
  return documentReferenceSchema.safeParse({ type, name: 'validation', ...(type.scope === 'namespace' ? { namespace: 'default' } : {}), uid: 'validation', resourceVersion: 'validation' }).success;
}
export const explainRequestSchema = z.object({ protocol: z.literal(2), target: targetSchema, selection: configSelectionSchema, definition: definitionReferenceSchema.optional(),
  type: documentReferenceSchema.shape.type, fieldPath: explainPath, documentIdentity: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()
  .refine(value => value.definition ? !!value.type.group && value.definition.name === `${value.type.resource}.${value.type.group}` && !builtinType(value.type) : builtinType(value.type));
export type ExplainRequest = z.infer<typeof explainRequestSchema>;
const description = z.string().max(16_384).refine(hasWellFormedUnicode);
export const explanationSchema = z.object({ type: z.string().min(1).max(128), description, required: z.boolean(),
  properties: z.array(z.object({ name: explainField, type: z.string().min(1).max(128), required: z.boolean() }).strict()).max(100) }).strict();
export const explainResponseSchema = z.object({ protocol: z.literal(2), kind: z.literal('field-explanation'), target: targetSchema,
  definition: definitionReferenceSchema.optional(),
  type: documentReferenceSchema.shape.type, fieldPath: explainPath, documentIdentity: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  schemaIdentity: z.string().regex(/^[a-f0-9]{64}$/), explanation: explanationSchema }).strict();
export type ExplainResponse = z.infer<typeof explainResponseSchema>;
