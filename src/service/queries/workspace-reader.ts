import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { BoundaryError } from '../../shared/errors.ts';
import { hasWellFormedUnicode } from '../../shared/identity.ts';
import { workspaceOpenSchema, workspaceReadSchema, workspaceReleaseSchema, workspaceScopePageSchema, workspaceFilePageSchema, workspaceBytes, workspaceChunkCharacters } from '../../shared/workspace-protocol.ts';
import type { WorkspaceScope } from '../../shared/workspace-protocol.ts';
import { workspaceRebindSchema, workspaceRebindPageSchema, workspaceListSchema, workspaceListPageSchema, workspaceEntrySchema, workspaceParent } from '../../shared/workspace-protocol.ts';
import type { WorkspaceEntry } from '../../shared/workspace-protocol.ts';
import { ReadScheduler } from './read-scheduler.ts';
import { createSealedCursor } from './sealed-cursor.ts';

export type WorkspaceFileSnapshot = { readonly version: string; readonly text: string };
export type WorkspaceReadBackend = { inspectRoot(root: string, signal: AbortSignal): Promise<string>;
  readFile(root: string, rootVersion: string, path: string, signal: AbortSignal): Promise<WorkspaceFileSnapshot>;
  listDirectory?(root: string, rootVersion: string, path: string, signal: AbortSignal): Promise<{ readonly version: string; readonly entries: readonly WorkspaceEntry[] }> };
const cursorSchema = z.object({ binding: z.string().regex(/^[a-f0-9]{64}$/), identity: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(1).max(workspaceBytes), expiresAt: z.number().int().nonnegative() }).strict();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const proofSchema = z.object({ generation: z.string(), location: z.string(), root: z.string(), snapshot: z.string(), binding: z.string(), identity: z.string(), version: z.string(), validUntil: z.number().int().nonnegative() }).strict();
// Explicit selected Server root, NOT host-attested project/frame identity. This read scope never authorizes Save/Apply or another root.
export function createWorkspaceReader(generation: string, backend: WorkspaceReadBackend, clock = Date.now) {
  const key = randomBytes(32), codec = createSealedCursor('ws1', 'openchamber-workspace-file-1'), proofs = createSealedCursor('wsp1', 'openchamber-workspace-comparison-1');
  type Scope = { handle: WorkspaceScope; root: string; version: string; expiresAt: number; reads: number; lineage?: { path: string; binding: string } };
  const scopes = new Map<string, Scope>(), scheduler = new ReadScheduler<WorkspaceFileSnapshot & { readonly entries?: readonly WorkspaceEntry[] }>({ concurrency: 2, queued: 8, consumers: 16, timeoutMs: 5000 });
  let closed = false, opening = 0;
  function active(signal?: AbortSignal) { if (closed) throw new BoundaryError('SERVICE_CLOSED'); if (signal?.aborted) throw new BoundaryError('QUERY_CANCELLED'); }
  function now() { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) throw new BoundaryError('STATE_UNAVAILABLE'); return value; }
  function collect() { const time = now(); for (const [id, scope] of scopes) if (scope.expiresAt <= time) scopes.delete(id); }
  function find(handle: WorkspaceScope) {
    active(); collect(); if (handle.generation !== generation) throw new BoundaryError('STALE_TARGET');
    const scope = scopes.get(handle.id); if (!scope || !timingSafeEqual(Buffer.from(scope.handle.token, 'hex'), Buffer.from(handle.token, 'hex'))) throw new BoundaryError('VIEW_EXPIRED'); return scope;
  }
  function snapshot(value: WorkspaceFileSnapshot) {
    if (!hasWellFormedUnicode(value.text) || value.text.includes('\0')) throw new BoundaryError('CONTENT_INVALID');
    const bytes = Buffer.byteLength(value.text); if (bytes > workspaceBytes || !value.version || value.version.length > 8192) throw new BoundaryError('BUDGET_EXCEEDED'); return bytes;
  }
  function identity(binding: string, value: WorkspaceFileSnapshot) {
    return { identity: createHmac('sha256', key).update(binding).update(value.version).update(value.text).digest('hex'), version: createHmac('sha256', key).update(binding).update(value.version).digest('hex') };
  }
  return {
    // Internal bounded full snapshot for explicit file-consuming intents; no new HTTP route/write grant.
    async capture(input: unknown, signal: AbortSignal) {
      active(signal); const parsed = workspaceReadSchema.safeParse(input);
      if (!parsed.success || !parsed.data.path || parsed.data.cursor) throw new BoundaryError('INVALID_INPUT');
      const { scope: handle, path } = parsed.data, scope = find(handle), binding = hash(JSON.stringify([handle, path]));
      if (++scope.reads > 128) throw new BoundaryError('BUDGET_EXCEEDED');
      const value = await scheduler.run([generation, handle.id, 'file', hash(path)], async inner => {
        active(inner); if (find(handle) !== scope) throw new BoundaryError('VIEW_EXPIRED'); return backend.readFile(scope.root, scope.version, path, inner);
      }, { signal }); active(signal); if (find(handle) !== scope) throw new BoundaryError('VIEW_EXPIRED'); snapshot(value);
      const metadata = identity(scope.lineage?.path === path ? scope.lineage.binding : binding, value);
      return Object.freeze({ root: scope.root, path, scope: handle, ...metadata, text: value.text });
    },
    async open(input: unknown, signal: AbortSignal) {
      active(signal); const parsed = workspaceOpenSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); collect();
      if (scopes.size + opening >= 32) throw new BoundaryError('QUERY_LIMIT'); if (opening >= 2) throw new BoundaryError('QUERY_LIMIT'); opening++;
      try {
        const expiresAt = now() + 60_000, result = await scheduler.run([generation, 'root', randomUUID()], async inner => ({ text: '', version: await backend.inspectRoot(parsed.data.root, inner) }), { signal }); active(signal);
        const version = result.version;
        if (now() >= expiresAt) throw new BoundaryError('CONTINUATION_EXPIRED');
        if (!version || version.length > 8192) throw new BoundaryError('STATE_UNAVAILABLE');
        const handle = Object.freeze({ generation, id: randomUUID(), token: randomBytes(32).toString('hex') });
        const scope = { handle, root: parsed.data.root, version, expiresAt, reads: 0 }; scopes.set(handle.id, scope);
        return workspaceScopePageSchema.parse({ protocol: 2, kind: 'workspace-scope', scope: handle, root: scope.root, expiresAt });
      } finally { opening--; }
    },
    async read(input: unknown, signal: AbortSignal) {
      active(signal); const parsed = workspaceReadSchema.safeParse(input); if (!parsed.success || !parsed.data.path) throw new BoundaryError('INVALID_INPUT');
      const { scope: handle, path, cursor } = parsed.data, scope = find(handle);
      const binding = createHash('sha256').update(JSON.stringify([handle, path])).digest('hex');
      let previous: z.infer<typeof cursorSchema> | undefined;
      if (cursor) { const parsed = cursorSchema.safeParse(codec.open(cursor)); if (!parsed.success || parsed.data.binding !== binding) throw new BoundaryError('STALE_TARGET'); previous = parsed.data; }
      if (previous && previous.expiresAt !== scope.expiresAt) throw new BoundaryError('STALE_TARGET');
      if (++scope.reads > 128) throw new BoundaryError('BUDGET_EXCEEDED'); // At most 128MiB full-file text reads per fixed scope; no renewal/reset through continuation.
      const value = await scheduler.run([generation, handle.id, 'file', hash(path)], async inner => { active(inner); if (find(handle) !== scope) throw new BoundaryError('VIEW_EXPIRED'); return backend.readFile(scope.root, scope.version, path, inner); }, { signal }); active(signal);
      if (find(handle) !== scope) throw new BoundaryError('VIEW_EXPIRED');
      const bytes = snapshot(value), originalBinding = scope.lineage?.path === path ? scope.lineage.binding : binding, metadata = identity(originalBinding, value);
      const proof = proofs.seal({ generation, location: hash(JSON.stringify([scope.root, path])), root: hash(scope.version), snapshot: hash(value.version), binding: originalBinding, ...metadata, validUntil: now() + 86_400_000 });
      const offset = previous?.offset ?? 0; if (previous && (previous.identity !== metadata.identity || offset >= value.text.length)) throw new BoundaryError('STALE_TARGET');
      let end = Math.min(value.text.length, offset + workspaceChunkCharacters);
      if (end < value.text.length && value.text.charCodeAt(end - 1) >= 0xD800 && value.text.charCodeAt(end - 1) <= 0xDBFF) end--;
      return workspaceFilePageSchema.parse({ protocol: 2, kind: 'workspace-file', scope: handle, root: scope.root, path, ...metadata, proof, totalBytes: bytes, totalCharacters: value.text.length, offset, end, text: value.text.slice(offset, end),
        nextCursor: end < value.text.length ? codec.seal({ binding, identity: metadata.identity, offset: end, expiresAt: scope.expiresAt }) : null });
    },
    async rebind(input: unknown, signal: AbortSignal) {
      active(signal); const parsed = workspaceRebindSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const { root, path, proof } = parsed.data;
      const original = proofSchema.safeParse(proofs.open(proof));
      if (!original.success || original.data.generation !== generation || original.data.location !== hash(JSON.stringify([root, path]))) throw new BoundaryError('STALE_TARGET');
      if (now() >= original.data.validUntil) throw new BoundaryError('VIEW_EXPIRED'); collect();
      if (scopes.size + opening >= 32 || opening >= 2) throw new BoundaryError('QUERY_LIMIT'); opening++;
      try {
        const expiresAt = now() + 60_000, result = await scheduler.run([generation, 'rebind', randomUUID()], async inner => {
          active(inner); if (now() >= original.data.validUntil || now() >= expiresAt) throw new BoundaryError('VIEW_EXPIRED');
          const version = await backend.inspectRoot(root, inner); active(inner);
          if (hash(version) !== original.data.root) throw new BoundaryError('STALE_TARGET');
          if (now() >= original.data.validUntil || now() >= expiresAt) throw new BoundaryError('VIEW_EXPIRED');
          const value = await backend.readFile(root, version, path, inner); snapshot(value);
          const metadata = identity(original.data.binding, value);
          if (hash(value.version) !== original.data.snapshot || metadata.identity !== original.data.identity || metadata.version !== original.data.version) throw new BoundaryError('CONFLICT');
          return { version, text: '' }; // Never return the disk body or replace the user's edited buffer.
        }, { signal }); active(signal);
        if (now() >= expiresAt || now() >= original.data.validUntil) throw new BoundaryError('VIEW_EXPIRED');
        const handle = Object.freeze({ generation, id: randomUUID(), token: randomBytes(32).toString('hex') });
        scopes.set(handle.id, { handle, root, version: result.version, expiresAt, reads: 1, lineage: { path, binding: original.data.binding } });
        return workspaceRebindPageSchema.parse({ protocol: 2, kind: 'workspace-rebind', scope: handle, root, path, identity: original.data.identity, version: original.data.version, proof, expiresAt });
      } finally { opening--; }
    },
    async list(input: unknown, signal: AbortSignal) {
      active(signal); const parsed = workspaceListSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT');
      const request = parsed.data, scope = find(request.scope);
      if (++scope.reads > 128) throw new BoundaryError('BUDGET_EXCEEDED');
      const raw = await scheduler.run([generation, request.scope.id, 'directory', hash(request.path)], async inner => {
        active(inner); if (find(request.scope) !== scope) throw new BoundaryError('VIEW_EXPIRED');
        if (!backend.listDirectory) throw new BoundaryError('READ_TRANSPORT_UNAVAILABLE');
        const value = await backend.listDirectory(scope.root, scope.version, request.path, inner); return { ...value, text: '' };
      }, { signal }); active(signal); if (find(request.scope) !== scope) throw new BoundaryError('VIEW_EXPIRED');
      if (!raw.entries || raw.entries.length > 2000 || !raw.version || raw.version.length > 8192) throw new BoundaryError('BUDGET_EXCEEDED');
      const entries = raw.entries.map(entry => workspaceEntrySchema.parse(entry)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      if (new Set(entries.map(entry => entry.name)).size !== entries.length) throw new BoundaryError('CONTENT_INVALID');
      const listingIdentity = createHmac('sha256', key).update(JSON.stringify([request.scope, request.path, raw.version, request.showHidden, entries])).digest('hex');
      if (request.listingIdentity && request.listingIdentity !== listingIdentity) throw new BoundaryError('STALE_TARGET');
      const visible = entries.filter(entry => request.showHidden || !entry.name.startsWith('.')); if (request.offset > visible.length) throw new BoundaryError('INVALID_INPUT');
      const page = visible.slice(request.offset, request.offset + 100), end = request.offset + page.length;
      return workspaceListPageSchema.parse({ protocol: 2, kind: 'workspace-directory', scope: request.scope, root: scope.root, path: request.path, parent: workspaceParent(request.path), showHidden: request.showHidden, listingIdentity, offset: request.offset, total: visible.length, entries: page, nextOffset: end < visible.length ? end : null });
    },
    release(input: unknown) { const parsed = workspaceReleaseSchema.safeParse(input); if (!parsed.success) throw new BoundaryError('INVALID_INPUT'); const scope = find(parsed.data.scope); scopes.delete(scope.handle.id); return { protocol: 2 as const, released: true as const }; },
    close() { if (closed) return; closed = true; scopes.clear(); scheduler.close(); codec.dispose(); proofs.dispose(); key.fill(0); },
  };
}
