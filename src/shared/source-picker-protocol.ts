import { z } from 'zod';
import { containsControlCharacters } from './identity.ts';
import { configSelectionSchema, readConfigSelection } from './configuration.ts';
import type { ConfigSelection } from './configuration.ts';

export const serverDirectorySchema = z.string().min(1).max(4096).refine(value => value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !containsControlCharacters(value)
  && (value === '/' || (!value.endsWith('/') && value.slice(1).split('/').every(part => part !== '' && part !== '.' && part !== '..'))));
export const sourceEntryNameSchema = z.string().min(1).max(255).refine(value => value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !containsControlCharacters(value));
export const sourcePickerEntrySchema = z.object({ name: sourceEntryNameSchema, kind: z.enum(['file', 'directory', 'blocked']) }).strict();
export type SourcePickerEntry = z.infer<typeof sourcePickerEntrySchema>;
export const sourcePickerRequestSchema = z.object({ protocol: z.literal(2), serviceGeneration: z.string().uuid(), directory: serverDirectorySchema, showHidden: z.boolean(),
  offset: z.number().int().min(0).max(2000), listingIdentity: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().refine(value => value.offset === 0 || value.listingIdentity !== undefined);
export type SourcePickerRequest = z.infer<typeof sourcePickerRequestSchema>;
export const sourcePickerPageSchema = z.object({ protocol: z.literal(2), serviceGeneration: z.string().uuid(), directory: serverDirectorySchema, parent: serverDirectorySchema.nullable(), showHidden: z.boolean(),
  listingIdentity: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(0).max(2000), total: z.number().int().min(0).max(2000), nextOffset: z.number().int().min(1).max(2000).nullable(),
  entries: z.array(sourcePickerEntrySchema).max(100) }).strict().refine(value => value.parent === parentDirectory(value.directory) && new Set(value.entries.map(entry => entry.name)).size === value.entries.length
    && value.entries.every((entry, index) => (value.showHidden || !entry.name.startsWith('.')) && (!index || (value.entries[index - 1]?.name ?? '') < entry.name))
    && value.offset + value.entries.length <= value.total && (value.offset + value.entries.length < value.total ? value.entries.length === 100 && value.nextOffset === value.offset + 100 : value.nextOffset === null));
export type SourcePickerPage = z.infer<typeof sourcePickerPageSchema>;
export function parentDirectory(directory: string): string | null { return directory === '/' ? null : directory.slice(0, directory.lastIndexOf('/')) || '/'; }
export function sourceChildPath(directory: string, name: string): string { return serverDirectorySchema.parse(`${serverDirectorySchema.parse(directory) === '/' ? '' : directory}/${sourceEntryNameSchema.parse(name)}`); }
export function pickedSource(selection: ConfigSelection, path: string, append: boolean): ConfigSelection {
  const file = configSelectionSchema.parse({ mode: 'file', path });
  return append ? readConfigSelection({ mode: 'merge', paths: [...new Set([...(selection.mode === 'merge' ? selection.paths : selection.mode === 'file' ? [selection.path] : []), path])] }) : file;
}
