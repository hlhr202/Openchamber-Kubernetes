// WRITE boundary. Static review only: never imported or invoked by automatic functional tests.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, link, rename, unlink } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import { BoundaryError } from '../../shared/errors.ts';
import type { ErrorCode } from '../../shared/errors.ts';
import { fileSaveTargetSchema } from '../../shared/file-save-protocol.ts';
import { workspaceBytes } from '../../shared/workspace-protocol.ts';

export type SaveFilePlan = { readonly root: string; readonly path: string; readonly topology: string; readonly parent: string;
  readonly version: string | null; readonly digest: string | null; readonly mode: number; readonly uid: bigint; readonly gid: bigint | null };
export type SaveFileResult = { readonly phase: 'succeeded' | 'failed' | 'unknown'; readonly cleanup: 'none' | 'manual-check';
  readonly result?: 'created' | 'replaced' | 'unchanged'; readonly versionAfter?: string; readonly code?: ErrorCode };
const codeOf = (error: unknown) => error instanceof Error && 'code' in error ? error.code : undefined;
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
const topologyStamp = (s: BigIntStats) => [s.dev, s.ino, s.mode, s.uid, s.gid].map(String).join(':');
function active(signal: AbortSignal) { if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); }
function errorCode(error: unknown): ErrorCode { return error instanceof BoundaryError ? error.code : ['EACCES', 'EPERM'].includes(String(codeOf(error))) ? 'FORBIDDEN' : 'STATE_UNAVAILABLE'; }
export function createWorkspaceFileWriter() {
  const key = randomBytes(32), hash = (value: string) => createHmac('sha256', key).update(value).digest('hex');
  const uid = process.getuid?.();
  function owner(s: BigIntStats, directory: boolean, own = false) {
    if (uid === undefined || (own ? s.uid !== BigInt(uid) : s.uid !== BigInt(uid) && s.uid !== 0n)
      || (s.mode & 0o022n) !== 0n || (!directory && (s.mode & 0o7000n) !== 0n)) throw new BoundaryError('FORBIDDEN');
  }
  async function topology(root: string, parent: string, signal: AbortSignal) {
    let directory = parent; const values: string[] = [];
    for (;;) {
      active(signal); if (values.length >= 128) throw new BoundaryError('BUDGET_EXCEEDED');
      const s = await lstat(directory, { bigint: true });
      if (!s.isDirectory() || s.isSymbolicLink() || await realpath(directory) !== directory) throw new BoundaryError('STALE_TARGET');
      owner(s, true, directory === root || directory.startsWith(root + '/'));
      values.push(`${directory}:${topologyStamp(s)}`); if (directory === '/') break; directory = dirname(directory);
    }
    active(signal); return hash(values.join('\n'));
  }
  async function inspect(root: string, path: string, signal: AbortSignal): Promise<SaveFilePlan> {
    if (!fileSaveTargetSchema.safeParse({ root, path }).success) throw new BoundaryError('INVALID_INPUT');
    const absolute = join(root, path), parent = dirname(absolute), beforeTopology = await topology(root, parent, signal);
    let entry: BigIntStats;
    try { entry = await lstat(absolute, { bigint: true }); }
    catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error; // ENOTDIR, permissions and I/O failures are NOT a missing target.
      if (await topology(root, parent, signal) !== beforeTopology) throw new BoundaryError('STALE_TARGET');
      return Object.freeze({ root, path, parent, topology: beforeTopology, version: null, digest: null, mode: 0o600, uid: BigInt(uid ?? -1), gid: null });
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) throw new BoundaryError('CONTENT_INVALID'); owner(entry, false, true);
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW), bytes = Buffer.alloc(workspaceBytes + 1);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || stamp(before) !== stamp(entry) || before.size > BigInt(workspaceBytes)) throw new BoundaryError('CONFLICT');
      let offset = 0;
      while (offset < bytes.length) { active(signal); const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
      if (offset > workspaceBytes) throw new BoundaryError('BUDGET_EXCEEDED');
      const after = await handle.stat({ bigint: true }), current = await lstat(absolute, { bigint: true });
      if (stamp(before) !== stamp(after) || stamp(after) !== stamp(current) || await realpath(absolute) !== absolute || await topology(root, parent, signal) !== beforeTopology) throw new BoundaryError('CONFLICT');
      const digest = createHash('sha256').update(bytes.subarray(0, offset)).digest('hex');
      return Object.freeze({ root, path, parent, topology: beforeTopology, version: hash(`${absolute}\n${beforeTopology}\n${stamp(after)}\n${digest}`), digest,
        mode: Number(after.mode & 0o777n), uid: after.uid, gid: after.gid });
    } finally { bytes.fill(0); await handle.close(); }
  }
  async function verify(plan: SaveFilePlan, signal: AbortSignal) {
    const next = await inspect(plan.root, plan.path, signal);
    if (next.topology !== plan.topology || next.version !== plan.version || next.mode !== plan.mode || next.uid !== plan.uid || next.gid !== plan.gid) throw new BoundaryError('CONFLICT');
    return next;
  }
  return {
    inspect, verify,
    async commit(id: string, plan: SaveFilePlan, bytes: Buffer, digest: string, signal: AbortSignal, recheck: () => Promise<void>, stage: () => void, commit: () => void): Promise<SaveFileResult> {
      let temporary: string | undefined, owned: BigIntStats | undefined, attempted = false, published = false, knownNoPublish = false, cleanup: 'none' | 'manual-check' = 'none';
      let result: SaveFileResult;
      try {
        if (!/^[a-f0-9-]{36}$/.test(id) || bytes.length > workspaceBytes || createHash('sha256').update(bytes).digest('hex') !== digest) throw new BoundaryError('CONTENT_INVALID');
        await recheck(); await verify(plan, signal); active(signal);
        if (plan.digest === digest && plan.version) return { phase: 'succeeded', cleanup: 'none', result: 'unchanged', versionAfter: plan.version };
        const directory = await open(plan.parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const parent = await directory.stat({ bigint: true }), currentParent = await lstat(plan.parent, { bigint: true });
          if (topologyStamp(parent) !== topologyStamp(currentParent) || await topology(plan.root, plan.parent, signal) !== plan.topology) throw new BoundaryError('STALE_TARGET');
          stage();
          const name = join(plan.parent, `.oc-k8s-save-${id}.tmp`);
          const file = await open(name, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); temporary = name;
          try {
            owned = await file.stat({ bigint: true });
            if (!owned.isFile() || owned.nlink !== 1n || owned.uid !== plan.uid || plan.gid !== null && owned.gid !== plan.gid) throw new BoundaryError('FORBIDDEN');
            active(signal); await file.writeFile(bytes); active(signal); await file.chmod(plan.mode); await file.sync();
            const written = await file.stat({ bigint: true });
            if (written.dev !== owned.dev || written.ino !== owned.ino || written.size !== BigInt(bytes.length) || Number(written.mode & 0o777n) !== plan.mode) throw new BoundaryError('CONFLICT');
          } finally { await file.close(); }
          await directory.sync(); await recheck(); await verify(plan, signal); active(signal);
          const staged = await lstat(name, { bigint: true });
          if (!owned || staged.dev !== owned.dev || staged.ino !== owned.ino || staged.nlink !== 1n || staged.size !== BigInt(bytes.length) || await realpath(name) !== name) throw new BoundaryError('CONFLICT');
          // The final version check + rename is optimistic, NOT an external-process CAS or openat2 transaction.
          commit(); attempted = true;
          if (plan.version === null) {
            try { await link(name, join(plan.root, plan.path)); }
            catch (error) { if (codeOf(error) === 'EEXIST') { knownNoPublish = true; throw new BoundaryError('CONFLICT'); } throw error; }
            published = true;
            // Never unlink the target, even if cancellation or later durability verification fails.
            const source = await lstat(name, { bigint: true });
            if (source.dev !== owned.dev || source.ino !== owned.ino) throw new BoundaryError('CONFLICT');
            await unlink(name); temporary = undefined;
          } else { await rename(name, join(plan.root, plan.path)); published = true; temporary = undefined; }
          await directory.sync();
          // Ignore cancellation after publication: it cannot undo a link/rename. Account on the original target.
          const after = await inspect(plan.root, plan.path, new AbortController().signal);
          const destination = await lstat(join(plan.root, plan.path), { bigint: true });
          if (destination.dev !== owned.dev || destination.ino !== owned.ino) throw new BoundaryError('CONFLICT');
          if (after.topology !== plan.topology || after.digest !== digest || after.mode !== plan.mode || after.uid !== plan.uid || after.gid !== (plan.gid ?? owned.gid)) throw new BoundaryError('CONFLICT');
          if (!after.version) throw new BoundaryError('CONFLICT');
          result = { phase: 'succeeded', cleanup: 'none', result: plan.version === null ? 'created' : 'replaced', versionAfter: after.version };
        } finally { await directory.close(); }
      } catch (error) {
        result = { phase: attempted && !knownNoPublish ? 'unknown' : 'failed', cleanup: 'none', code: attempted && !knownNoPublish ? 'OPERATION_UNKNOWN' : errorCode(error) };
      }
      if (temporary) {
        try {
          // Only this operation's inode under the ORIGINAL topology may be cleaned. No target deletion/rollback.
          if (!owned || await topology(plan.root, plan.parent, new AbortController().signal) !== plan.topology) throw new BoundaryError('STALE_TARGET');
          const current = await lstat(temporary, { bigint: true });
          if (current.dev !== owned.dev || current.ino !== owned.ino || current.uid !== owned.uid || !current.isFile()) throw new BoundaryError('CONFLICT');
          await unlink(temporary);
          const directory = await open(plan.parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { await directory.sync(); } finally { await directory.close(); }
        } catch { cleanup = 'manual-check'; }
      }
      if (cleanup === 'manual-check') return { phase: published || attempted && !knownNoPublish ? 'unknown' : 'failed', cleanup, code: published || attempted && !knownNoPublish ? 'OPERATION_UNKNOWN' : result.code ?? 'STATE_UNAVAILABLE' };
      return result;
    },
  };
}
