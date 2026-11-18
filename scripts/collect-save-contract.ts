// Read exact-version public documentation as TEXT; never load its code or inspect a user filesystem/configuration.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const root = new URL('../tests/fixtures/contracts/save-contract/', import.meta.url); await mkdir(root, { recursive: true });
const inputs = [
  { name: 'node-fs.json', url: 'https://nodejs.org/docs/v24.22.1/api/fs.json' },
  { name: 'posix-link.html', url: 'https://pubs.opengroup.org/onlinepubs/9799919799/functions/link.html' },
];
const records = [];
for (const input of inputs) {
  const path = new URL(`${input.name}.txt`, root); let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const response = await fetch(input.url, { redirect: 'error', signal: AbortSignal.timeout(30_000) }); if (!response.ok) throw new Error(`Public documentation HTTP ${response.status}`);
    text = await response.text(); if (Buffer.byteLength(text) > 2_000_000) throw new Error('Public documentation budget'); await writeFile(path, text, { flag: 'wx' });
  }
  records.push({ ...input, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
}
await writeFile(new URL('../docs/baseline/save-sources.json', import.meta.url), JSON.stringify({ node: '24.22.1', posix: '9799919799', records }, null, 2) + '\n');
console.log(JSON.stringify({ files: records.length, bytes: records.reduce((sum, record) => sum + record.bytes, 0), scope: 'public-versioned-document-text-only' }));
