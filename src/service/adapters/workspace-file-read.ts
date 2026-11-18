// READ-ONLY real filesystem adapter. No mkdir, writing, config parsing, CLI/authentication or operation imports.
import { constants } from 'node:fs';
import { lstat, realpath, open, opendir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { BoundaryError } from '../../shared/errors.ts';
import { workspaceBytes, workspaceRelativeSchema, workspaceRootSchema } from '../../shared/workspace-protocol.ts';
import { workspaceEntrySchema } from '../../shared/workspace-protocol.ts';
import type { WorkspaceEntry } from '../../shared/workspace-protocol.ts';
import type { WorkspaceReadBackend } from '../queries/workspace-reader.ts';
type Stamp = { dev: bigint; ino: bigint; mode: bigint; uid: bigint; gid: bigint; nlink: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
const stamp = (value: Stamp) => [value.dev, value.ino, value.mode, value.uid, value.gid, value.nlink, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
function active(signal: AbortSignal) { if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); }
function failure(error: unknown): never { if (error instanceof BoundaryError) throw error; const code = error instanceof Error && 'code' in error ? error.code : undefined; throw new BoundaryError(code === 'ENOENT' ? 'NOT_FOUND' : code === 'EACCES' || code === 'EPERM' ? 'FORBIDDEN' : 'STATE_UNAVAILABLE'); }
export function createWorkspaceFileReadBackend(): WorkspaceReadBackend {
  const key = randomBytes(32), hash = (value: string) => createHmac('sha256', key).update(value).digest('hex');
  async function directories(path: string, signal: AbortSignal) {
    const values: string[] = []; let directory = path;
    for (;;) {
      if (values.length >= 128) throw new BoundaryError('BUDGET_EXCEEDED');
      active(signal); const value = await lstat(directory, { bigint: true });
      if (!value.isDirectory() || value.isSymbolicLink() || await realpath(directory) !== directory) throw new BoundaryError('STALE_TARGET');
      // Directory contents may change; pin topology/ownership, not directory mtime or size.
      values.push(`${directory}:${value.dev}:${value.ino}:${value.mode}:${value.uid}:${value.gid}`);
      if (directory === '/') break; directory = dirname(directory);
    }
    active(signal); return hash(values.join('\n'));
  }
  return {
    async inspectRoot(root, signal) { try { if (!workspaceRootSchema.safeParse(root).success) throw new BoundaryError('INVALID_INPUT'); return await directories(root, signal); } catch (error) { return failure(error); } },
    async readFile(root, rootVersion, path, signal) {
      try {
        if (!workspaceRootSchema.safeParse(root).success || !workspaceRelativeSchema.safeParse(path).success || !path) throw new BoundaryError('INVALID_INPUT');
        if (await directories(root, signal) !== rootVersion) throw new BoundaryError('STALE_TARGET');
        const absolute = join(root, path), parents = await directories(dirname(absolute), signal); active(signal);
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW), bytes = Buffer.alloc(workspaceBytes + 1);
        try {
          const before = await handle.stat({ bigint: true });
          if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(workspaceBytes)) throw new BoundaryError(before.size > BigInt(workspaceBytes) ? 'BUDGET_EXCEEDED' : 'CONTENT_INVALID');
          let offset = 0;
          while (offset < bytes.length) { active(signal); const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
          if (offset > workspaceBytes) throw new BoundaryError('BUDGET_EXCEEDED');
          const after = await handle.stat({ bigint: true }), current = await lstat(absolute, { bigint: true }); active(signal);
          if (current.isSymbolicLink() || stamp(before) !== stamp(after) || stamp(after) !== stamp(current) || await realpath(absolute) !== absolute
            || await directories(dirname(absolute), signal) !== parents || await directories(root, signal) !== rootVersion) throw new BoundaryError('STALE_TARGET');
          let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset)); } catch { throw new BoundaryError('CONTENT_INVALID'); }
          return { text, version: hash(`${absolute}\n${rootVersion}\n${parents}\n${stamp(after)}\n${text}`) };
        } finally { bytes.fill(0); await handle.close(); }
      } catch (error) { return failure(error); }
    },
    async listDirectory(root, rootVersion, path, signal) {
      try {
        if (!workspaceRootSchema.safeParse(root).success || !workspaceRelativeSchema.safeParse(path).success) throw new BoundaryError('INVALID_INPUT');
        if (await directories(root, signal) !== rootVersion) throw new BoundaryError('STALE_TARGET');
        const absolute = join(root, path), parents = await directories(absolute, signal), before = await lstat(absolute, { bigint: true });
        const entries: WorkspaceEntry[] = [], metadata: string[] = [], stream = await opendir(absolute, { bufferSize: 32 });
        for await (const entry of stream) { // Async iterator closes its OWN directory handle, including early rejection.
          active(signal); if (entries.length >= 2000) throw new BoundaryError('BUDGET_EXCEEDED');
          const name = workspaceEntrySchema.shape.name.safeParse(entry.name); if (!name.success) throw new BoundaryError('CONTENT_INVALID');
          const value = await lstat(join(absolute, name.data), { bigint: true });
          entries.push({ name: name.data, kind: value.isSymbolicLink() ? 'blocked' : value.isDirectory() ? 'directory' : value.isFile() && value.nlink === 1n ? 'file' : 'blocked' });
          metadata.push(JSON.stringify([name.data, stamp(value)]));
        }
        const after = await lstat(absolute, { bigint: true }); active(signal);
        if (stamp(before) !== stamp(after) || await directories(absolute, signal) !== parents || await directories(root, signal) !== rootVersion) throw new BoundaryError('STALE_TARGET');
        return { version: hash(JSON.stringify([rootVersion, parents, stamp(after), metadata.sort()])), entries };
      } catch (error) { return failure(error); }
    },
  };
}
