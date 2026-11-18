// Dedicated mergeIntoKubeconfig file adapter: merges the incoming kubeconfig into the FIRST
// EXISTING path of the bound selection with the audited safety rules of the config writers —
// normalized absolute path, no symlinks, safe parent chain (no group/other-writable, owned),
// version pinning (content hash), 0600 O_EXCL staging + rename + mode/fsync preservation.
// Never imported, constructed or invoked by automatic functional tests.
import { createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { BoundaryError } from '../../shared/errors.ts';
export type MergeSnapshot = { readonly path: string; readonly exists: boolean; readonly body: string; readonly version: string; readonly uid: bigint; readonly gid: bigint; readonly mode: bigint; readonly parent: string };
const key = randomBytes(32);
const hash = (value: string) => createHmac('sha256', key).update(value).digest('hex');
function active(signal: AbortSignal) { if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); }
async function parentsSafe(path: string, signal: AbortSignal): Promise<string> {
  const values: string[] = []; let directory = dirname(path);
  for (;;) {
    active(signal);
    const value = await lstat(directory, { bigint: true });
    if (!value.isDirectory() || value.isSymbolicLink() || (value.mode & 0o022n) !== 0n || (value.uid !== 0n && value.uid !== BigInt(process.getuid?.() ?? -1))) throw new BoundaryError('CONFIG_UNREADABLE');
    values.push(`${directory}:${value.dev}:${value.ino}`);
    if (directory === '/') break; directory = dirname(directory);
  }
  return values.join('\n');
}
export function createMergeKubeconfigFileAdapter() {
  return {
    // Bounded read of one candidate path; missing files are legitimate merge targets (creates).
    async snapshot(path: string, signal: AbortSignal): Promise<MergeSnapshot> {
      if (!isAbsolute(path) || normalize(path) !== path || path.startsWith('//')) throw new BoundaryError('INVALID_INPUT');
      active(signal);
      try {
        const parent = await parentsSafe(path, signal);
        const info = await lstat(path, { bigint: true });
        if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n || info.uid !== BigInt(process.getuid?.() ?? -1)
          || (info.mode & 0o7133n) !== 0n || (info.mode & 0o200n) === 0n || info.size > 2_000_000n) throw new BoundaryError('CONFIG_UNREADABLE');
        const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
          const body = (await readFile(file)).toString('utf8');
          if (Buffer.byteLength(body) > 2_000_000) throw new BoundaryError('BUDGET_EXCEEDED');
          return { path, exists: true, body, version: hash(body), uid: info.uid, gid: info.gid, mode: info.mode & 0o7777n, parent };
        } finally { await file.close(); }
      } catch (error) {
        if (error instanceof BoundaryError && error.code === 'CONFIG_UNREADABLE') {
          // A MISSING target is a create; anything else (symlink/unsafe owner/oversize) is fixed.
          const missing = await lstat(path).then(() => false, issue => issue.code === 'ENOENT');
          if (missing) return { path, exists: false, body: '', version: hash(''), uid: BigInt(process.getuid?.() ?? -1), gid: BigInt(process.getgid?.() ?? -1), mode: 0o600n, parent: await parentsSafe(dirname(path), signal) };
        }
        throw error;
      }
    },
    // ONE staged replace; the content hash must match the prepared intended hash exactly.
    async replace(snapshot: MergeSnapshot, next: string, intended: string, id: string, beforeStage: () => void, beforeCommit: () => void, signal: AbortSignal): Promise<{ phase: 'succeeded'; result: 'changed' | 'unchanged'; versionAfter: string } | { phase: 'failed' | 'unknown'; code: string; cleanup: 'none' | 'manual-check' }> {
      if (hash(next) !== intended) throw new BoundaryError('CONFIG_CHANGED');
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new BoundaryError('INVALID_INPUT');
      const fresh = await this.snapshot(snapshot.path, signal);
      if (fresh.exists !== snapshot.exists || fresh.version !== snapshot.version || fresh.parent !== snapshot.parent) throw new BoundaryError('CONFIG_CHANGED');
      if (next === fresh.body) return { phase: 'succeeded', result: 'unchanged', versionAfter: fresh.version };
      beforeStage();
      const temporary = join(dirname(snapshot.path), `.${basename(snapshot.path)}.oc-k8s-merge-${id}.tmp`);
      let stagedCreated = false, committed = false, attempted = false;
      let owned: { ino: bigint; dev: bigint } | undefined;
      try {
        const staged = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        stagedCreated = true;
        try {
          const info = await staged.stat({ bigint: true }); owned = { ino: info.ino, dev: info.dev };
          active(signal); await staged.writeFile(next, 'utf8');
          if (snapshot.exists) await staged.chown(Number(snapshot.uid), Number(snapshot.gid));
          await staged.sync(); active(signal);
          const current = await this.snapshot(snapshot.path, signal);
          if (current.exists !== snapshot.exists || current.version !== snapshot.version || current.parent !== snapshot.parent) throw new BoundaryError('CONFIG_CHANGED');
          const stage = await lstat(temporary, { bigint: true });
          if (!stage.isFile() || stage.nlink !== 1n || stage.ino !== owned.ino || stage.dev !== owned.dev) throw new BoundaryError('CONFIG_CHANGED');
          beforeCommit(); attempted = true; // Irrevocable boundary.
          await rename(temporary, snapshot.path); committed = true;
          await staged.chmod(Number(snapshot.mode)); await staged.sync();
          const parent = await open(dirname(snapshot.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { await parent.sync(); } finally { await parent.close(); }
        } finally { await staged.close(); }
        const after = await this.snapshot(snapshot.path, signal);
        if (hash(after.body) !== intended) throw new BoundaryError('CONFIG_CHANGED');
        return { phase: 'succeeded', result: 'changed', versionAfter: after.version };
      } catch (error) {
        return { phase: attempted ? 'unknown' : 'failed', cleanup: 'none', code: attempted ? 'OPERATION_UNKNOWN' : error instanceof BoundaryError ? error.code : 'CONFIG_UNREADABLE' };
      } finally {
        if (temporary && stagedCreated && !committed) {
          try { if (owned) { const stage = await lstat(temporary, { bigint: true }); if (stage.ino === owned.ino && stage.dev === owned.dev) await unlink(temporary); else await rm(temporary, { force: true }); } else await rm(temporary, { force: true }); }
          catch { /* staging cleanup is best effort; never blocks the result */ }
        }
      }
    },
  };
}