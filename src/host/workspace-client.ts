import { z } from 'zod';
import { BoundaryError, errorCodes } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { hasWellFormedUnicode, utf8ByteLength } from '../shared/identity.ts';
import { workspaceBytes, workspaceOpenSchema, workspaceFilePageSchema, workspaceScopePageSchema, workspaceRelativeSchema } from '../shared/workspace-protocol.ts';
import type { WorkspaceFilePage, WorkspaceScopePage } from '../shared/workspace-protocol.ts';
import { savedFileForSnapshot } from '../shared/saved-buffer.ts';
import type { SavedFileReceipt } from '../shared/file-save-protocol.ts';
import { workspaceRebindPageSchema, workspaceListPageSchema } from '../shared/workspace-protocol.ts';
import type { WorkspaceListPage } from '../shared/workspace-protocol.ts';
type Transport = (request: { method: 'POST'; path: string; body: string }) => Promise<{ status: number; body: string }>;
export type WorkspaceEditor = { readonly text: string; readonly dirty: boolean; readonly revision: number; readonly origin: Readonly<Pick<WorkspaceFilePage, 'scope' | 'root' | 'path' | 'version' | 'identity' | 'proof' | 'totalBytes' | 'totalCharacters'>>; readonly readScope?: WorkspaceScopePage['scope']; readonly detached?: boolean; readonly savedFile?: SavedFileReceipt };
export type WorkspaceState = { readonly phase: 'idle' | 'opening' | 'ready' | 'loading' | 'error'; readonly scope?: WorkspaceScopePage; readonly file?: WorkspaceEditor; readonly listing?: WorkspaceListPage; readonly stale: boolean; readonly error?: ErrorCode };
const errorSchema = z.object({ error: z.object({ code: z.enum(errorCodes) }).strict() }).strict();
// Independent, explicitly selected Server FILE source. No fabricated cluster target, Load/Explain, writer, storage or CLI.
export class WorkspaceClient {
  readonly #request: Transport; readonly #show: (state: WorkspaceState) => void;
  #scope: WorkspaceScopePage | undefined; #file: WorkspaceEditor | undefined; #listing: WorkspaceListPage | undefined; #baseline = ''; #revision = 0; #calls = 0; #disposed = false; #directory: string | null = null; #editable = false; #stale = false; #phase: WorkspaceState['phase'] = 'idle';
  constructor(request: Transport, show: (state: WorkspaceState) => void) { this.#request = request; this.#show = show; }
  #paint(phase: WorkspaceState['phase'], stale = false, error?: ErrorCode) { this.#phase = phase; this.#stale = stale; this.#editable = phase === 'ready' && !stale && !!this.#file; if (!this.#disposed) this.#show({ phase, stale, ...(this.#scope ? { scope: this.#scope } : {}), ...(this.#file ? { file: this.#file } : {}), ...(this.#listing ? { listing: this.#listing } : {}), ...(error ? { error } : {}) }); }
  async #post(path: string, value: unknown): Promise<unknown> {
    if (this.#disposed) throw new BoundaryError('SERVICE_CLOSED'); if (this.#calls >= 2) throw new BoundaryError('QUERY_LIMIT');
    const body = JSON.stringify(value); if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED'); this.#calls++;
    try {
      const response = await this.#request({ method: 'POST', path, body });
      if (utf8ByteLength(response.body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED');
      let decoded: unknown; try { decoded = JSON.parse(response.body); } catch { throw new BoundaryError('STATE_UNAVAILABLE'); }
      if (response.status !== 200) { const parsed = errorSchema.safeParse(decoded); throw new BoundaryError(parsed.success ? parsed.data.error.code : 'STATE_UNAVAILABLE'); } return decoded;
    } finally { this.#calls--; }
  }
  #release(scope: WorkspaceScopePage | undefined) { if (scope && !this.#disposed) void this.#post('/v2/workspace-files/release', { protocol: 2, scope: scope.scope }).catch(() => {}); } // Fixed expiry is the fallback; no filesystem cleanup.
  project(directory: string | null): void { if (directory === this.#directory) return; this.#directory = directory; this.reset(); }
  async open(root: string): Promise<void> {
    if (this.#disposed) return; if (this.#file?.dirty) { this.#paint('ready', this.#stale, 'DOCUMENT_DIRTY'); return; }
    const parsed = workspaceOpenSchema.safeParse({ protocol: 2, root }); if (!parsed.success) { this.#paint('error', true, 'INVALID_INPUT'); return; }
    const revision = ++this.#revision, previous = this.#scope; this.#scope = undefined; this.#file = undefined; this.#listing = undefined; this.#baseline = ''; this.#release(previous); this.#paint('opening');
    try {
      const value = workspaceScopePageSchema.safeParse(await this.#post('/v2/workspace-files/open', parsed.data)); if (!value.success || value.data.root !== root) throw new BoundaryError('STALE_TARGET');
      if (this.#disposed || revision !== this.#revision) { this.#release(value.data); return; } this.#scope = value.data; this.#paint('ready');
    } catch (error) { if (!this.#disposed && revision === this.#revision) this.#paint('error', true, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async read(path: string, discard = false): Promise<void> {
    if (this.#disposed || !this.#scope) return;
    if (this.#file?.dirty && !discard) { this.#paint('ready', this.#stale, 'DOCUMENT_DIRTY'); return; }
    if (!path || !workspaceRelativeSchema.safeParse(path).success) { this.#paint('error', true, 'INVALID_INPUT'); return; }
    const scope = this.#scope, revision = ++this.#revision; this.#paint('loading', !!this.#file);
    const current = () => !this.#disposed && revision === this.#revision && this.#scope === scope;
    try {
      const file = await this.#capture(scope, path, current); if (!current()) return;
      this.#baseline = file.text; this.#file = file; this.#paint('ready');
    } catch (error) { if (current()) this.#paint('error', !!this.#file, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async captureFile(path: string): Promise<WorkspaceEditor> {
    const scope = this.#scope, directory = this.#directory;
    if (this.#disposed || !scope || !path || !workspaceRelativeSchema.safeParse(path).success) throw new BoundaryError('INVALID_INPUT');
    return this.#capture(scope, path, () => !this.#disposed && this.#scope === scope && this.#directory === directory);
    // Does not change #file/#baseline/dirty/revision/listing or silently discard the active editor.
  }
  async #capture(scope: WorkspaceScopePage, path: string, current: () => boolean): Promise<WorkspaceEditor> {
      let cursor: string | undefined, previous: WorkspaceFilePage | undefined, text = ''; const tokens = new Set<string>();
      for (let chunk = 0; chunk < 128; chunk++) {
        if (!current()) throw new BoundaryError('QUERY_CANCELLED');
        const value = workspaceFilePageSchema.safeParse(await this.#post('/v2/workspace-files/read', { protocol: 2, scope: scope.scope, path, ...(cursor ? { cursor } : {}) }));
        if (!current()) throw new BoundaryError('QUERY_CANCELLED'); if (!value.success) throw new BoundaryError('STATE_UNAVAILABLE'); const page = value.data;
        if (page.root !== scope.root || page.path !== path || JSON.stringify(page.scope) !== JSON.stringify(scope.scope) || page.offset !== text.length
          || previous && (page.identity !== previous.identity || page.version !== previous.version || page.totalBytes !== previous.totalBytes || page.totalCharacters !== previous.totalCharacters)
          || page.nextCursor !== null && (tokens.has(page.nextCursor) || page.end <= page.offset)) throw new BoundaryError('STALE_TARGET');
        text += page.text; if (utf8ByteLength(text) > workspaceBytes || text.length > page.totalCharacters) throw new BoundaryError('BUDGET_EXCEEDED');
        if (!page.nextCursor) {
          if (text.length !== page.totalCharacters || utf8ByteLength(text) !== page.totalBytes || !hasWellFormedUnicode(text)) throw new BoundaryError('CONTENT_INVALID');
          // Origin retains metadata only, not a redundant final chunk/body or a resource target.
          const origin = Object.freeze({ scope: Object.freeze({ ...page.scope }), root: page.root, path: page.path, version: page.version, identity: page.identity, proof: page.proof, totalBytes: page.totalBytes, totalCharacters: page.totalCharacters });
          return Object.freeze({ text, dirty: false, revision: 0, origin });
        }
        tokens.add(page.nextCursor); cursor = page.nextCursor; previous = page;
      }
      throw new BoundaryError('BUDGET_EXCEEDED');
  }
  async rebind(): Promise<void> {
    const file = this.#file; if (this.#disposed || !file) return;
    const revision = ++this.#revision, previous = this.#scope; this.#paint('loading', this.#stale);
    try {
      const parsed = workspaceRebindPageSchema.safeParse(await this.#post('/v2/workspace-files/rebind', { protocol: 2, root: file.origin.root, path: file.origin.path, proof: file.origin.proof }));
      if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); const page = parsed.data;
      if (page.root !== file.origin.root || page.path !== file.origin.path || page.identity !== file.origin.identity || page.version !== file.origin.version || page.proof !== file.origin.proof) throw new BoundaryError('STALE_TARGET');
      const selected: WorkspaceScopePage = Object.freeze({ protocol: 2, kind: 'workspace-scope', scope: Object.freeze({ ...page.scope }), root: page.root, expiresAt: page.expiresAt });
      if (this.#disposed || revision !== this.#revision || this.#file !== file) { this.#release(selected); return; }
      this.#scope = selected; this.#file = Object.freeze({ ...file, readScope: selected.scope, detached: false }); this.#listing = undefined; this.#release(previous); this.#paint('ready');
    } catch (error) { if (!this.#disposed && revision === this.#revision) this.#paint('error', true, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  async browse(path = '', showHidden = false, next = false): Promise<void> {
    const scope = this.#scope, previous = this.#listing; if (this.#disposed || !scope || !workspaceRelativeSchema.safeParse(path).success) return;
    if (next && (!previous?.nextOffset || previous.path !== path || previous.showHidden !== showHidden)) return;
    const revision = ++this.#revision, stale = this.#stale; this.#listing = undefined; this.#paint('loading', stale);
    try {
      const parsed = workspaceListPageSchema.safeParse(await this.#post('/v2/workspace-files/list', { protocol: 2, scope: scope.scope, path, showHidden, offset: next ? previous?.nextOffset : 0, ...(next ? { listingIdentity: previous?.listingIdentity } : {}) }));
      if (this.#disposed || revision !== this.#revision || this.#scope !== scope) return;
      if (!parsed.success) throw new BoundaryError('STATE_UNAVAILABLE'); const page = parsed.data;
      if (page.root !== scope.root || page.path !== path || page.showHidden !== showHidden || JSON.stringify(page.scope) !== JSON.stringify(scope.scope)
        || page.offset !== (next ? previous?.nextOffset : 0) || next && (page.listingIdentity !== previous?.listingIdentity || page.total !== previous?.total)) throw new BoundaryError('STALE_TARGET');
      for (const entry of page.entries) Object.freeze(entry); Object.freeze(page.entries); this.#listing = Object.freeze(page); this.#paint('ready', stale);
    } catch (error) { if (!this.#disposed && revision === this.#revision) this.#paint('ready', stale, error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE'); }
  }
  pick(name: string): Promise<void> {
    const page = this.#listing; if (!page || !this.#scope || page.root !== this.#scope.root) return Promise.resolve();
    const entry = page.entries.find(entry => entry.name === name); if (!entry || entry.kind === 'blocked') return Promise.resolve();
    const path = page.path ? `${page.path}/${entry.name}` : entry.name;
    return entry.kind === 'directory' ? this.browse(path, page.showHidden) : this.read(path);
  }
  keepDraft(): void {
    if (this.#disposed || !this.#file || !this.#stale || this.#phase !== 'error') return;
    ++this.#revision; this.#file = Object.freeze({ ...this.#file, detached: true, revision: this.#file.revision + 1 }); this.#paint('ready');
  }
  edit(text: string) {
    if (this.#disposed || !this.#file || !this.#editable) return;
    if (!hasWellFormedUnicode(text) || text.includes('\0')) { this.#paint('ready', false, 'CONTENT_INVALID'); return; }
    if (utf8ByteLength(text) > workspaceBytes) { this.#paint('ready', false, 'BUDGET_EXCEEDED'); return; }
    ++this.#revision; this.#file = Object.freeze({ ...this.#file, text, dirty: text !== this.#baseline, revision: this.#file.revision + (text === this.#file.text ? 0 : 1) }); this.#paint('ready');
  }
  revert() { if (this.#file) this.edit(this.#baseline); }
  acknowledgeSaved(input: unknown, text: string, revision: number): boolean {
    const file = this.#file; if (this.#disposed || !this.#editable || !file || file.text !== text || file.revision !== revision) return false;
    const receipt = savedFileForSnapshot(input, { kind: 'file', identity: file.origin.identity, revision }, text); if (!receipt) return false;
    this.#baseline = text; this.#file = Object.freeze({ ...file, dirty: false, savedFile: receipt }); this.#paint('ready'); return true;
  }
  cancel() { if (this.#disposed) return; ++this.#revision; this.#paint('error', !!this.#file, 'QUERY_CANCELLED'); }
  close(discard = false) { if (this.#file?.dirty && !discard) { this.#paint('ready', this.#stale, 'DOCUMENT_DIRTY'); return; } this.reset(); }
  reset() { ++this.#revision; const scope = this.#scope; this.#scope = undefined; this.#file = undefined; this.#listing = undefined; this.#baseline = ''; this.#release(scope); this.#paint('idle'); }
  dispose() { if (this.#disposed) return; this.reset(); this.#disposed = true; }
}
