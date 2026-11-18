import { z } from 'zod';
import { boundedName, containsControlCharacters } from './identity.ts';

// Public metadata only. No configuration body, credentials, I/O, write plan or operation lifecycle.
export const configurationSourcePathSchema = z.string().min(2).max(4096).refine(value => value.startsWith('/') && !containsControlCharacters(value));
export const configurationSourceSchema = z.object({ path: configurationSourcePathSchema, status: z.enum(['present', 'missing']), version: boundedName.nullable(),
  currentContext: z.string().max(1024), definesContext: z.boolean() }).strict().refine(value => value.status === 'present' ? value.version !== null : value.version === null && !value.definesContext && value.currentContext === '');
export type ConfigurationSource = z.infer<typeof configurationSourceSchema>;
