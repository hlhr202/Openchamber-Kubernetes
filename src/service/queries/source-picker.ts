import { createHmac, randomBytes } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import { sourcePickerEntrySchema, sourcePickerPageSchema, sourcePickerRequestSchema, parentDirectory } from '../../shared/source-picker-protocol.ts';
import type { SourcePickerEntry } from '../../shared/source-picker-protocol.ts';
import { ReadScheduler } from './read-scheduler.ts';

export type SourceDirectoryRead = { readonly generation: string; readonly entries: readonly SourcePickerEntry[] };
export type SourceDirectoryReader = (directory: string, signal: AbortSignal) => Promise<SourceDirectoryRead>;
// Read-only injected directory metadata. No file bodies, preferences, configuration parsing or operation imports.
export function createSourcePicker(serviceGeneration: string, read: SourceDirectoryReader) {
  const key = randomBytes(32), scheduler = new ReadScheduler<SourceDirectoryRead>({ concurrency: 1, queued: 8, consumers: 16, timeoutMs: 5000 });
  return {
    async read(input: unknown, signal: AbortSignal) {
      const parsed = sourcePickerRequestSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const request = parsed.data;
      if (request.serviceGeneration !== serviceGeneration) throw new BoundaryError('STALE_TARGET');
      const raw = await scheduler.run([serviceGeneration, request.directory], inner => read(request.directory, inner), { signal });
      if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED');
      if (raw.entries.length > 2000 || raw.generation.length > 256) throw new BoundaryError('BUDGET_EXCEEDED');
      const entries = raw.entries.map(entry => sourcePickerEntrySchema.parse(entry)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      if (new Set(entries.map(entry => entry.name)).size !== entries.length) throw new BoundaryError('CONFIG_CHANGED');
      const listingIdentity = createHmac('sha256', key).update(JSON.stringify([request.directory, raw.generation, entries, request.showHidden])).digest('hex');
      if (request.listingIdentity !== undefined && request.listingIdentity !== listingIdentity) throw new BoundaryError('CONFIG_CHANGED');
      const visible = entries.filter(entry => request.showHidden || !entry.name.startsWith('.')); if (request.offset > visible.length) throw new BoundaryError('INVALID_INPUT');
      const page = visible.slice(request.offset, request.offset + 100), end = request.offset + page.length;
      return sourcePickerPageSchema.parse({ protocol: 2, serviceGeneration, directory: request.directory, parent: parentDirectory(request.directory), showHidden: request.showHidden,
        listingIdentity, offset: request.offset, total: visible.length, nextOffset: end < visible.length ? end : null, entries: page });
    },
    close: () => scheduler.close(),
  };
}
