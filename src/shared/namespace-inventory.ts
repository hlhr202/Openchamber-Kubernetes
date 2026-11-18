import { z } from 'zod';
import { documentReferenceSchema } from './document-protocol.ts';
import { errorCodes } from './errors.ts';
import { namespaceName } from './identity.ts';

export const namespaceDeleteReferenceSchema = documentReferenceSchema.refine(value => value.type.group === '' && value.type.version === 'v1' && value.type.resource === 'namespaces' && namespaceName.safeParse(value.name).success);
export type NamespaceDeleteReference = z.infer<typeof namespaceDeleteReferenceSchema>;
export const namespaceInventorySchema = z.object({ reference: namespaceDeleteReferenceSchema,
  status: z.enum(['complete', 'unknown']), count: z.number().int().min(0).max(10_000).nullable(), types: z.number().int().min(0).max(128),
  digest: z.string().regex(/^[a-f0-9]{64}$/), code: z.enum(errorCodes).optional(),
}).strict().refine(value => value.status === 'complete' ? value.count !== null && value.code === undefined : value.count === null && value.code !== undefined);
export type NamespaceInventory = z.infer<typeof namespaceInventorySchema>;
