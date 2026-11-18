// Pure source gate/metadata projection. Never imports a Save/Create controller, calls transport or writes a file.
import { BoundaryError } from '../shared/errors.ts';
import { manifestFileSchema } from '../shared/manifest-file-protocol.ts';
import type { ManifestFile } from '../shared/manifest-file-protocol.ts';
import type { WorkspaceEditor } from './workspace-client.ts';
export type ManifestFileInput = { readonly text: string; readonly source: { readonly kind: 'file' | 'file-command'; readonly revision: number; readonly file: ManifestFile; readonly fileProof?: string } };
export function manifestFileInput(editor: WorkspaceEditor, format: 'yaml' | 'json', command = false): ManifestFileInput {
  if (editor.dirty) throw new BoundaryError('DOCUMENT_DIRTY'); if (editor.detached) throw new BoundaryError('CONFLICT');
  const origin = editor.origin, receipt = command ? undefined : editor.savedFile;
  if (receipt && (receipt.root !== origin.root || receipt.path !== origin.path)) throw new BoundaryError('CONFLICT'); // Save As never silently relocates this ordinary file source.
  const file = manifestFileSchema.parse({ root: origin.root, path: origin.path, identity: origin.identity, version: receipt?.version ?? origin.version, format, ...(receipt ? { receipt } : {}) });
  return { text: editor.text, source: { kind: command ? 'file-command' : 'file', revision: editor.revision, file, ...(!receipt ? { fileProof: origin.proof } : {}) } };
}
