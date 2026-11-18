import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { BoundaryError } from '../../shared/errors.ts';
import type { HelmRepositoryFileRead } from '../queries/helm-repositories.ts';
// READ ONLY; construction/import has no I/O. Never invoked against real files by automatic tests.
export const readHelmRepositoryFile: HelmRepositoryFileRead = async (path, maximumBytes, signal) => {
  const active = () => { if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); };
  try {
    active(); const canonical = await realpath(path); if (canonical !== path) throw new BoundaryError('CONFIG_UNREADABLE');
    const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true }); active();
      if (!before.isFile() || before.size > BigInt(maximumBytes)) throw new BoundaryError('BUDGET_EXCEEDED');
      const buffer = Buffer.alloc(maximumBytes + 1); let total = 0;
      while (total <= maximumBytes) { active(); const value = await file.read(buffer, total, buffer.length - total, total); if (!value.bytesRead) break; total += value.bytesRead; }
      if (total > maximumBytes) throw new BoundaryError('BUDGET_EXCEEDED');
      const after = await file.stat({ bigint: true }), current = await stat(canonical, { bigint: true }); active();
      const stamp = (value: typeof before) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.mode, value.uid, value.gid].join(':');
      if (stamp(before) !== stamp(after) || stamp(current) !== stamp(after) || await realpath(path) !== canonical) throw new BoundaryError('STALE_TARGET');
      return { content: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total)), version: stamp(after) };
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new BoundaryError('CONFIG_UNREADABLE');
  }
};
