import { z } from 'zod';
import { BoundaryError } from './errors.ts';
import { boundedName, containsControlCharacters } from './identity.ts';

// Server targets are macOS/Linux. Paths are explicit selections, never credentials or config text.
const serverPath = z.string().min(2).max(4096).refine(value => value.startsWith('/') && !value.startsWith('//')
  && !containsControlCharacters(value) && !value.includes('\\'));
export const configSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('default') }).strict(),
  z.object({ mode: z.literal('file'), path: serverPath }).strict(),
  z.object({ mode: z.literal('merge'), paths: z.array(serverPath).min(1).max(64) }).strict(),
]).refine(value => value.mode !== 'merge' || value.paths.reduce((sum, path) => sum + path.length, 0) <= 24_000);
export type ConfigSelection = { readonly mode: 'default' } | { readonly mode: 'file'; readonly path: string } | { readonly mode: 'merge'; readonly paths: readonly string[] };

export const authenticationSchema = z.object({
  methods: z.array(z.enum(['anonymous', 'token', 'token-file', 'client-certificate', 'basic', 'exec', 'auth-provider', 'unknown'])).min(1).max(8),
  externalExecution: z.boolean(), referencedFiles: z.boolean(), mayUpdateCredentials: z.boolean(), proxyConfigured: z.boolean(),
  evaluated: z.literal(false), // Only configuration inspection. Authentication has NOT been tried.
}).strict();
export type AuthenticationDisclosure = z.infer<typeof authenticationSchema>;
export const configSourcesSchema = z.object({
  mode: z.enum(['default', 'file', 'merge']), selectedCount: z.number().int().min(0).max(64),
  loadedCount: z.number().int().min(0).max(64), missingCount: z.number().int().min(0).max(64),
}).strict().refine(value => value.loadedCount + value.missingCount === value.selectedCount && (value.selectedCount > 0 || value.mode === 'default'));

export const configPageQuerySchema = z.object({
  offset: z.number().int().min(0).max(5000).default(0),
  limit: z.number().int().min(1).max(100).default(100),
  configIdentity: boundedName.optional(),
}).strict().refine(value => value.offset === 0 || value.configIdentity !== undefined);

export function readConfigSelection(value: unknown): ConfigSelection {
  const parsed = configSelectionSchema.safeParse(value);
  if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
  return parsed.data.mode === 'merge' ? Object.freeze({ ...parsed.data, paths: Object.freeze(parsed.data.paths) }) : Object.freeze(parsed.data);
}

export function selectionFromLines(mode: ConfigSelection['mode'], text: string): ConfigSelection {
  if (mode === 'default') return { mode: 'default' };
  if (text.length > 24_000) throw new BoundaryError('BUDGET_EXCEEDED');
  const paths = text.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
  return readConfigSelection(mode === 'file' ? { mode, path: paths.length === 1 ? paths[0] : '' } : { mode, paths });
}
