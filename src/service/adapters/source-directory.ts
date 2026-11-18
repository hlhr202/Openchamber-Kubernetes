import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BoundaryError } from '../../shared/errors.ts';
import { serverDirectorySchema, sourceEntryNameSchema } from '../../shared/source-picker-protocol.ts';
import type { SourcePickerEntry } from '../../shared/source-picker-protocol.ts';
import type { SourceDirectoryRead } from '../queries/source-picker.ts';

const active = (signal: AbortSignal) => { if (signal.aborted) throw new BoundaryError('QUERY_CANCELLED'); };
// Explicit READ only. Never called in automatic tests against a real filesystem/HOME.
export async function readSourceDirectory(input: string, signal: AbortSignal): Promise<SourceDirectoryRead> {
  try {
    const directory = serverDirectorySchema.parse(input); active(signal);
    if (await realpath(directory) !== directory) throw new BoundaryError('CONFIG_UNREADABLE');
    let parent = directory; const parents: { path: string; identity: string }[] = [];
    while (true) {
      active(signal); const info = await lstat(parent, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022n) !== 0n || (info.uid !== 0n && info.uid !== BigInt(process.getuid?.() ?? -1))) throw new BoundaryError('CONFIG_UNREADABLE');
      if (parents.length >= 64) throw new BoundaryError('BUDGET_EXCEEDED');
      parents.push({ path: parent, identity: `${info.dev}:${info.ino}:${info.uid}:${info.gid}:${info.mode}` }); if (parent === '/') break; parent = dirname(parent);
    }
    const before = await lstat(directory, { bigint: true }), fingerprint = createHash('sha256'), entries: SourcePickerEntry[] = [];
    const stamp = (value: typeof before) => [value.dev, value.ino, value.mtimeNs, value.ctimeNs, value.mode, value.uid, value.gid].map(String).join(':');
    const stream = await opendir(directory, { bufferSize: 32 }); // Async iterator owns close, including early throw/cancellation.
    const metadata: string[] = [];
    for await (const entry of stream) {
      active(signal); if (entries.length >= 2000) throw new BoundaryError('BUDGET_EXCEEDED');
      const name = sourceEntryNameSchema.safeParse(entry.name); if (!name.success) throw new BoundaryError('CONFIG_UNREADABLE');
      const info = await lstat(join(directory, name.data), { bigint: true });
      entries.push({ name: name.data, kind: info.isSymbolicLink() ? 'blocked' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'blocked' });
      metadata.push(JSON.stringify([name.data, stamp(info), info.size.toString()]));
    }
    active(signal); const after = await lstat(directory, { bigint: true });
    if (stamp(before) !== stamp(after) || await realpath(directory) !== directory) throw new BoundaryError('CONFIG_CHANGED');
    for (const expected of parents) {
      active(signal); const info = await lstat(expected.path, { bigint: true });
      if (`${info.dev}:${info.ino}:${info.uid}:${info.gid}:${info.mode}` !== expected.identity || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022n) !== 0n) throw new BoundaryError('CONFIG_CHANGED');
    }
    fingerprint.update(JSON.stringify([stamp(after), ...metadata.sort()])); active(signal);
    return { generation: fingerprint.digest('hex'), entries };
  } catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError('CONFIG_UNREADABLE'); }
}
