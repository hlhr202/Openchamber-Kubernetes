import { z } from 'zod';
import { workspaceRootSchema, workspaceRelativeSchema } from './workspace-protocol.ts';
import { savedFileReceiptSchema } from './file-save-protocol.ts';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const manifestFileSchema = z.object({ root: workspaceRootSchema, path: workspaceRelativeSchema.refine(value => !!value), version: hash, identity: hash,
  format: z.enum(['yaml', 'json']), receipt: savedFileReceiptSchema.optional() }).strict().refine(value => !value.receipt || value.receipt.root === value.root && value.receipt.path === value.path && value.receipt.version === value.version);
export type ManifestFile = z.infer<typeof manifestFileSchema>;
