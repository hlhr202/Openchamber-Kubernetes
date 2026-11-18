import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Inspects only the already pinned public package declarations; never loads a product executor.
export async function inspectWatchContract() {
  const root = resolve('node_modules/rolldown/dist');
  async function inspect(directory: string): Promise<{ declaration: string; sha256: string; experimental: boolean } | null> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) { const result = await inspect(path); if (result) return result; }
      else if (entry.isFile() && entry.name.endsWith('.d.mts')) {
        const bytes = await readFile(path);
        const text = bytes.toString('utf8');
        const declaration = text.indexOf('declare function watch(input: WatchOptions');
        if (declaration !== -1) {
          const end = text.lastIndexOf('*/', declaration), start = text.lastIndexOf('/**', end);
          if (start === -1 || end === -1 || text.slice(end + 2, declaration).trim()) throw new Error('Unexpected watch declaration layout');
          return { declaration: path.slice(root.length + 1), sha256: createHash('sha256').update(bytes).digest('hex'), experimental: text.slice(start, end).includes('@experimental') };
        }
      }
    }
    return null;
  }
  const contract = await inspect(root);
  if (!contract) throw new Error('Pinned watch declaration not found; review required');
  return { package: 'rolldown', version: '1.2.15', ...contract };
}
