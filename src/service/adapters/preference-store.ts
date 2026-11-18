import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { BoundaryError } from '../../shared/errors.ts';
import { preferencePrefix, preferenceRevisionSchema, projectPreferenceLedger } from '../../shared/preference-protocol.ts';
import type { PreferenceRevision } from '../../shared/preference-protocol.ts';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const active = (signal: AbortSignal) => { if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); };
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
async function cleanOwnedStage(path: string, owned: { ino: bigint; dev: bigint } | undefined): Promise<boolean> {
  try {
    const stage = await lstat(path, { bigint: true });
    if (!owned || !stage.isFile() || stage.isSymbolicLink() || stage.ino !== owned.ino || stage.dev !== owned.dev) return false;
    await unlink(path); return true;
  } catch { return false; }
}
// Persistent non-secret preference adapter. No I/O in construction; append is WRITE and never tested/called automatically.
// It is bound to this Server OS user's HOME, not mutable host runtime HTTP storage routing.
export function createPreferenceStore(home: string) {
  if (!home.startsWith('/') || normalize(home) !== home || home.startsWith('//')) throw new BoundaryError('INVALID_INPUT');
  const root = join(home, '.local', 'share', 'openchamber-kubernetes-plugin', 'sources-v1');
  async function directory(create: boolean, signal: AbortSignal) {
    active(signal); if (await realpath(home) !== home) throw new BoundaryError('CONFIG_UNREADABLE');
    let path = home;
    for (const part of ['', '.local', 'share', 'openchamber-kubernetes-plugin', 'sources-v1']) {
      if (part) path = join(path, part);
      let info;
      try { info = await lstat(path, { bigint: true }); }
      catch (error) {
        if (!missing(error)) throw error; if (!create) return false;
        active(signal); try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
        info = await lstat(path, { bigint: true });
      }
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== BigInt(process.getuid?.() ?? -1) || (info.mode & 0o022n) !== 0n || await realpath(path) !== path) throw new BoundaryError('CONFIG_UNREADABLE');
      if (['openchamber-kubernetes-plugin', 'sources-v1'].includes(part) && (info.mode & 0o7777n) !== 0o700n) throw new BoundaryError('CONFIG_UNREADABLE');
    }
    active(signal); return true;
  }
  async function keys(signal: AbortSignal) {
    if (!await directory(false, signal)) return [];
    const entries = await opendir(root), keys: string[] = []; let count = 0;
    for await (const entry of entries) {
      active(signal); if (++count > 128) throw new BoundaryError('QUERY_LIMIT');
      if (/^\.[a-f0-9-]{36}\.tmp$/.test(entry.name)) continue; // Unpublished owned staging is not a committed revision; never auto-clean it.
      const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
      if (!uuid.test(id) || !entry.isFile() || entry.isSymbolicLink()) throw new BoundaryError('CONFIG_INVALID');
      keys.push(`${preferencePrefix}${id}`);
    }
    if (keys.length > 64) throw new BoundaryError('QUERY_LIMIT'); active(signal); return keys.sort();
  }
  async function get(id: string, signal: AbortSignal): Promise<PreferenceRevision | undefined> {
    if (!uuid.test(id)) throw new BoundaryError('INVALID_INPUT');
    if (!await directory(false, signal)) return undefined;
    let handle;
    try { handle = await open(join(root, `${id}.json`), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
    catch (error) { if (missing(error)) return undefined; throw new BoundaryError('CONFIG_UNREADABLE'); }
    const bytes = Buffer.alloc(48_001);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.uid !== BigInt(process.getuid?.() ?? -1) || (before.mode & 0o7777n) !== 0o600n || before.nlink < 1n || before.nlink > 2n || before.size > 48_000n) throw new BoundaryError('CONFIG_UNREADABLE');
      let offset = 0;
      while (offset < bytes.length) { active(signal); const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
      if (offset > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
      const after = await handle.stat({ bigint: true }), current = await lstat(join(root, `${id}.json`), { bigint: true });
      if (before.ino !== current.ino || before.dev !== current.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new BoundaryError('STALE_TARGET');
      active(signal); const value = preferenceRevisionSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))) as unknown);
      if (!value.success || value.data.id !== id) throw new BoundaryError('CONFIG_INVALID'); return value.data;
    } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONFIG_INVALID'); }
    finally { bytes.fill(0); await handle.close(); }
  }
  return {
    keys, get,
    async append(event: PreferenceRevision, step: 'known' | 'active', beforePublish: () => Promise<void>, signal: AbortSignal) {
      const encoded = JSON.stringify(preferenceRevisionSchema.parse(event)); if (Buffer.byteLength(encoded) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
      const existing = await get(event.id, signal);
      if (existing) { if (JSON.stringify(existing) !== encoded) throw new BoundaryError('CONFLICT'); return; }
      const before = await keys(signal), entries = [];
      for (const key of before) { const value = await get(key.slice(preferencePrefix.length), signal); if (!value) throw new BoundaryError('STALE_TARGET'); entries.push({ key, value }); }
      const ledger = projectPreferenceLedger(entries);
      if (JSON.stringify(ledger.heads.map(value => value.id).sort()) !== JSON.stringify([...event.parents].sort())) throw new BoundaryError('CONFLICT');
      if (step === 'known' && (ledger.conflict || JSON.stringify(event.preferences.active) !== JSON.stringify(ledger.preferences?.active ?? { mode: 'default' }))) throw new BoundaryError('CONFLICT');
      if (before.length >= 64 || Buffer.byteLength(ledger.identity) + Buffer.byteLength(encoded) > 1_499_900) throw new BoundaryError('QUERY_LIMIT');
      await directory(true, signal); active(signal);
      const temporary = join(root, `.${event.id}.tmp`), destination = join(root, `${event.id}.json`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let owned: { ino: bigint; dev: bigint } | undefined, published = false, failure: unknown;
      try {
        const info = await handle.stat({ bigint: true }); owned = { ino: info.ino, dev: info.dev };
        await handle.writeFile(encoded, 'utf8'); await handle.sync(); active(signal);
        if (JSON.stringify(await keys(signal)) !== JSON.stringify(before)) throw new BoundaryError('CONFLICT');
        await directory(false, signal);
        const stage = await lstat(temporary, { bigint: true });
        if (!stage.isFile() || stage.ino !== owned.ino || stage.dev !== owned.dev || stage.nlink !== 1n) throw new BoundaryError('CONFIG_CHANGED');
        await beforePublish(); active(signal);
        // Atomic publication without replacing any existing revision. No automatic retry/rollback.
        await link(temporary, destination); published = true;
        const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await parent.sync(); } finally { await parent.close(); }
      } catch (error) { failure = published ? new BoundaryError('OPERATION_UNKNOWN') : error; }
      finally {
        if (!await cleanOwnedStage(temporary, owned)) failure = new BoundaryError('OPERATION_UNKNOWN');
        try { await handle.close(); } catch { failure = new BoundaryError('OPERATION_UNKNOWN'); }
      }
      if (failure) throw failure;
    },
  };
}
