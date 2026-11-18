// Public documentation text only; no tool installation, process probing, FIFO or authentication.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const directory = new URL('../tests/fixtures/contracts/read-runtime-contract/', import.meta.url);
const output = new URL('../docs/baseline/read-runtime-sources.json', import.meta.url);
const sources = [
  { id: 'node-24.22.1-child-process', url: 'https://nodejs.org/docs/v24.22.1/api/child_process.json' },
  { id: 'posix-2024-open', url: 'https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html' },
  { id: 'posix-2024-mkfifo', url: 'https://pubs.opengroup.org/onlinepubs/9799919799/utilities/mkfifo.html' },
] as const;
await mkdir(directory, { recursive: true });
const records = [];
for (const source of sources) {
  const path = new URL(`${source.id}.txt`, directory);
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const response = await fetch(source.url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Public contract HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 2_000_000) throw new Error('Public contract exceeds text budget');
    await writeFile(path, bytes, { flag: 'wx' });
  }
  const record = { ...source, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  try {
    const prior = JSON.parse(await readFile(output, 'utf8')) as { records: { id: string; sha256: string }[] };
    const existing = prior.records.find(item => item.id === record.id);
    if (existing && existing.sha256 !== record.sha256) throw new Error('Captured public contract changed; refusing evidence drift');
  } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
  records.push(record);
}
await writeFile(output, `${JSON.stringify({ schemaVersion: 1, evidence: 'M1-E016', checkedAt: '2026-10-23', runtime: 'not-executed', records }, null, 2)}\n`);
console.log(JSON.stringify({ files: records.length, bytes: records.reduce((sum, item) => sum + item.bytes, 0), runtime: 'not-executed' }));
