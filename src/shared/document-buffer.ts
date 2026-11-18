import { BoundaryError } from './errors.ts';
import { documentBytes } from './document-protocol.ts';
import type { DocumentPage } from './document-protocol.ts';
import { hasWellFormedUnicode, utf8ByteLength } from './identity.ts';
import { readManifestBundle } from './manifest-bundle.ts';
import type { ManifestBundle } from './manifest-bundle.ts';
import { savedFileForSnapshot } from './saved-buffer.ts';
import type { SavedFileReceipt } from './file-save-protocol.ts';

export type DocumentBufferState = { readonly text: string; readonly dirty: boolean; readonly revision: number;
  readonly origin: Pick<DocumentPage, 'target' | 'reference' | 'format' | 'contentIdentity'>; readonly activeDocument: number; readonly analysis?: ManifestBundle; readonly savedFile?: SavedFileReceipt };
export function bufferDocumentText(state: DocumentBufferState): string {
  if (!state.analysis) return state.text; // Legacy single-document Explain still requires one complete matching GVK.
  const document = state.analysis.documents[state.activeDocument];
  if (state.analysis.characters !== state.text.length || !document || document.start < 0 || document.end > state.text.length || document.end < document.start) throw new BoundaryError('STALE_TARGET');
  return state.text.slice(document.start, document.end);
}
// Pure, detached edit buffer only. Success acknowledgements compare values; no Save execution, file access or callbacks.
export class DocumentBuffer {
  #baseline: string;
  #savedFile: SavedFileReceipt | undefined;
  readonly #origin: DocumentBufferState['origin'];
  #text: string;
  #revision = 0;
  #analysis: ManifestBundle | undefined;
  #activeDocument = 0;
  constructor(text: string, origin: DocumentBufferState['origin']) {
    if (!hasWellFormedUnicode(text) || utf8ByteLength(text) > documentBytes) throw new BoundaryError('BUDGET_EXCEEDED');
    this.#baseline = text; this.#text = text;
    this.#origin = Object.freeze({ target: Object.freeze({ ...origin.target }), reference: Object.freeze({ ...origin.reference, type: Object.freeze({ ...origin.reference.type }),
      ...('definition' in origin.reference ? { definition: Object.freeze({ ...origin.reference.definition }) } : {}) }), format: origin.format, contentIdentity: origin.contentIdentity });
  }
  edit(text: string): void {
    if (!hasWellFormedUnicode(text)) throw new BoundaryError('CONTENT_INVALID');
    if (utf8ByteLength(text) > documentBytes) throw new BoundaryError('BUDGET_EXCEEDED');
    if (text !== this.#text) { this.#text = text; this.#revision++; this.#analysis = undefined; this.#activeDocument = 0; }
  }
  analyse(input: ManifestBundle): void {
    const analysis = readManifestBundle(input);
    if (analysis.characters !== this.#text.length || analysis.format !== this.#origin.format) throw new BoundaryError('STALE_TARGET');
    this.#analysis = analysis; this.#activeDocument = 0; this.#revision++;
  }
  selectDocument(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || !this.#analysis?.documents[index]) throw new BoundaryError('INVALID_INPUT');
    if (index !== this.#activeDocument) { this.#activeDocument = index; this.#revision++; } // Navigation invalidates old Explain/field IDs without making the text dirty.
  }
  revert(): void { this.edit(this.#baseline); }
  acknowledgeSaved(input: unknown, text: string, revision: number): boolean {
    if (this.#text !== text || this.#revision !== revision) return false;
    const receipt = savedFileForSnapshot(input, { kind: 'live', identity: this.#origin.contentIdentity, revision }, text); if (!receipt) return false;
    this.#baseline = text; this.#savedFile = receipt; return true; // Never change the original Load cluster UID/RV/Explain origin.
  }
  get state(): DocumentBufferState { return Object.freeze({ text: this.#text, dirty: this.#text !== this.#baseline, revision: this.#revision, origin: this.#origin, activeDocument: this.#activeDocument, ...(this.#analysis ? { analysis: this.#analysis } : {}), ...(this.#savedFile ? { savedFile: this.#savedFile } : {}) }); }
}
