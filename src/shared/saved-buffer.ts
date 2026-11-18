import { fileSaveOutcomeSchema } from './file-save-protocol.ts';
import type { SavedFileReceipt, SaveSourceSummary } from './file-save-protocol.ts';
import { saveContentSnapshot } from './save-content.ts';
// Pure response/snapshot comparison. No write chain, callbacks, transport, SDK or filesystem.
export function savedFileForSnapshot(input: unknown, source: SaveSourceSummary, text: string): SavedFileReceipt | undefined {
  const parsed = fileSaveOutcomeSchema.safeParse(input); if (!parsed.success) return undefined; const value = parsed.data;
  if (value.phase !== 'succeeded' || !value.versionAfter || value.source.kind !== source.kind || value.source.identity !== source.identity || value.source.revision !== source.revision) return undefined;
  const snapshot = saveContentSnapshot(text);
  try {
    if (snapshot.digest !== value.digest || snapshot.bytes.length !== value.bytes) return undefined;
    return Object.freeze({ id: value.id, generation: value.generation, root: value.target.root, path: value.target.path, version: value.versionAfter });
  } finally { snapshot.bytes.fill(0); }
}
